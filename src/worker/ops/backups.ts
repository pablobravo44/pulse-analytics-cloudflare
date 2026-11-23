// Weekly SQL exports of the D1 databases chosen in Settings → Backups to R2 `ops-backups`, plus a monthly restore drill.
import { createHash } from "node:crypto";
import type { Env } from "../env.ts";
import { audit } from "../lib/audit.ts";
import { freeBackupStamp, newestBackupKey, stampTime } from "../lib/backupkeys.ts";
import { getOpsSettings } from "../lib/settings.ts";
import { cf, d1Query, listD1 } from "./cfapi.ts";
import { normalizeApiValue, rowsChecksum, sampleExport, type SqlValue } from "./drillcheck.ts";
import { sendMail } from "./email.ts";
import { putStream } from "./r2stream.ts";
import { countInserts, restoreOrder } from "./sqlexport.ts";

export { countInserts, restoreOrder };

export const DRILL_TARGET = "restore-drill";
/** Compressed size above which a backup is too large to restore inside a Worker (it decodes to ~10× in memory). */
export const DRILL_MAX_GZ_BYTES = 5 * 1048576;
const KEEP_DAYS = 84;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ExportPoll {
  at_bookmark?: string;
  status?: "active" | "complete" | "error";
  error?: string;
  result?: { signed_url?: string; filename?: string };
}

async function exportSql(env: Env, uuid: string): Promise<Response> {
  let bookmark: string | undefined;
  for (let i = 0; i < 120; i++) {
    const r = await cf<ExportPoll>(env, `/d1/database/${uuid}/export`, { method: "POST", body: JSON.stringify({ output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) }) });
    if (r.status === "error") throw new Error(`export failed: ${r.error ?? "unknown"}`);
    if (r.status === "complete" && r.result?.signed_url) {
      const dl = await fetch(r.result.signed_url);
      if (!dl.ok || !dl.body) throw new Error(`export download HTTP ${dl.status}`);
      return dl;
    }
    bookmark = r.at_bookmark ?? bookmark;
    await sleep(2000);
  }
  throw new Error("export timed out");
}

function opsBucket(env: Env): R2Bucket {
  if (!env.OPS_BACKUPS) throw new Error("OPS_BACKUPS binding missing");
  return env.OPS_BACKUPS;
}

export async function backupDatabases(env: Env, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const dbs = await listD1(env);
  const done: Record<string, number> = {};
  const errors: string[] = [];
  // Databases chosen for backup that no longer exist in the account: a settings problem, not a failed backup.
  const missing: string[] = [];
  const { backup_databases } = await getOpsSettings(env.DB);
  for (const name of backup_databases) {
    const db = dbs.find((d) => d.name === name);
    if (!db) {
      missing.push(name);
      continue;
    }
    try {
      // The bucket has a retention lock: never overwrite. A second run on the same UTC day gets `<date>T<HHMM>`.
      const stamp = await freeBackupStamp(now, async (s) => (await opsBucket(env).head(`${name}/${s}.sql.gz`)) !== null);
      const res = await exportSql(env, db.uuid);
      // Download, gzip and multipart upload as one stream: the export is never held in memory whole.
      done[name] = await putStream(opsBucket(env), `${name}/${stamp}.sql.gz`, res.body!.pipeThrough(new CompressionStream("gzip")), { httpMetadata: { contentType: "application/sql", contentEncoding: "gzip" } });
    } catch (err) {
      errors.push(`${name}: ${String((err as Error).message).slice(0, 160)}`);
    }
  }
  // Retention: delete backups older than 84 days (the bucket lifecycle rule does the same; this is belt and
  // braces). Only keys named by a backup stamp are touched; a failed delete doesn't fail the run.
  const cutoff = Date.parse(`${new Date(now - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`);
  for (const name of backup_databases) {
    try {
      const list = await opsBucket(env).list({ prefix: `${name}/` });
      const old = list.objects.filter((o) => {
        const t = stampTime(o.key.slice(name.length + 1));
        return t !== null && t < cutoff;
      });
      if (old.length) await opsBucket(env).delete(old.map((o) => o.key));
    } catch (err) {
      console.warn(JSON.stringify({ msg: "ops_backup_prune_failed", db: name, error: String(err).slice(0, 200) }));
    }
  }
  const ok = errors.length === 0;
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value, updated_at) VALUES ('last_ops_backup', ?, ?)").bind(JSON.stringify({ at: now, ok, done, errors, missing }), now).run();
  await audit(env.DB, "cron", "ops.backup", day, { done, errors, missing });
  return { ok, done, errors, missing };
}

async function dropAllTables(env: Env, uuid: string) {
  const tables = await d1Query<{ name: string; type: string }>(env, uuid, "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
  for (const t of tables.filter((x) => x.type === "view")) await d1Query(env, uuid, `DROP VIEW IF EXISTS "${t.name.replace(/"/g, "")}"`);
  // Foreign keys may reference each other; retry until everything is gone.
  let remaining = tables.filter((x) => x.type === "table").map((x) => x.name);
  for (let pass = 0; remaining.length && pass < 5; pass++) {
    const next: string[] = [];
    for (const n of remaining) {
      try {
        await d1Query(env, uuid, `DROP TABLE IF EXISTS "${n.replace(/"/g, "")}"`);
      } catch {
        next.push(n);
      }
    }
    remaining = next;
  }
}

async function rowCounts(env: Env, uuid: string): Promise<Record<string, number>> {
  const tables = await d1Query<{ name: string }>(env, uuid, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name");
  const out: Record<string, number> = {};
  for (const t of tables) {
    const [r] = await d1Query<{ n: number }>(env, uuid, `SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, "")}"`);
    out[t.name] = r?.n ?? 0;
  }
  return out;
}

/** Compare each table's sampled export rows with the same rows of the restored copy; adds mismatches. */
async function compareSamples(env: Env, uuid: string, samples: Record<string, SqlValue[][] | null>, mismatches: string[]) {
  let sampled = 0;
  const unchecked: string[] = [];
  for (const [t, rows] of Object.entries(samples)) {
    if (/^(sqlite_|_cf_|d1_)/.test(t)) continue;
    // Rows the parser can't read (function calls in the export) are left out rather than reported as different.
    if (rows === null) {
      unchecked.push(t);
      continue;
    }
    if (!rows.length) continue;
    const q = `"${t.replace(/"/g, "")}"`;
    // Export order is the source's rowid order, and the import inserts in that order; WITHOUT ROWID tables
    // have no rowid but scan in primary-key order on both sides.
    const got = await d1Query<Record<string, unknown>>(env, uuid, `SELECT * FROM ${q} ORDER BY rowid LIMIT ${rows.length}`).catch(() => d1Query<Record<string, unknown>>(env, uuid, `SELECT * FROM ${q} LIMIT ${rows.length}`));
    const restored = got.map((r) => Object.values(r).map(normalizeApiValue));
    if ((await rowsChecksum(restored)) !== (await rowsChecksum(rows))) mismatches.push(`${t}: the first ${rows.length} rows differ from the backup`);
    sampled++;
  }
  return { sampled, unchecked };
}

async function importSql(env: Env, uuid: string, sql: Uint8Array<ArrayBuffer>) {
  const etag = createHash("md5").update(sql).digest("hex");
  const init = await cf<{ upload_url?: string; filename?: string }>(env, `/d1/database/${uuid}/import`, { method: "POST", body: JSON.stringify({ action: "init", etag }) });
  if (!init.filename) throw new Error(`import init failed: ${JSON.stringify(init).slice(0, 200)}`);
  // D1 remembers imports by etag (the drill makes each run's file unique); a file uploaded earlier comes
  // back without an upload_url.
  if (init.upload_url) {
    const up = await fetch(init.upload_url, { method: "PUT", body: sql });
    if (!up.ok) throw new Error(`import upload HTTP ${up.status}`);
  }
  let r = await cf<{ at_bookmark?: string; status?: string; error?: string; success?: boolean }>(env, `/d1/database/${uuid}/import`, { method: "POST", body: JSON.stringify({ action: "ingest", etag, filename: init.filename }) });
  for (let i = 0; i < 150 && r.status !== "complete"; i++) {
    if (r.status === "error") throw new Error(`import failed: ${r.error ?? ""}`);
    await sleep(2000);
    r = await cf(env, `/d1/database/${uuid}/import`, { method: "POST", body: JSON.stringify({ action: "poll", current_bookmark: r.at_bookmark }) });
  }
  if (r.status !== "complete") throw new Error("import timed out");
}

/** Monthly: restore the latest backups into the scratch DB and compare per-table row counts with the source. */
export async function restoreDrill(env: Env, now = Date.now()) {
  try {
    return await runDrill(env, now);
  } catch (err) {
    // A drill that throws is recorded too, so the status board doesn't keep showing last month's success.
    const error = String((err as Error).message ?? err).slice(0, 300);
    await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value, updated_at) VALUES ('last_restore_drill', ?, ?)").bind(JSON.stringify({ at: now, ok: false, error }), now).run();
    throw err;
  }
}

async function runDrill(env: Env, now: number) {
  const dbs = await listD1(env);
  const target = dbs.find((d) => d.name === DRILL_TARGET);
  if (!target) throw new Error(`scratch database ${DRILL_TARGET} not found`);
  const report: Record<string, { ok: boolean; mismatches: string[]; tables: number; backup: string; sampled?: number; unchecked?: string[]; skipped?: string }> = {};
  const { drill_databases } = await getOpsSettings(env.DB);
  for (const name of drill_databases) {
    const src = dbs.find((d) => d.name === name);
    const list = await opsBucket(env).list({ prefix: `${name}/` });
    const latest = newestBackupKey(list.objects, `${name}/`);
    if (!src || !latest) {
      report[name] = { ok: false, mismatches: ["no source or no backup"], tables: 0, backup: latest?.key ?? "" };
      continue;
    }
    // The drill holds the decoded export in memory (the import API takes one file): a large one would exceed the
    // Worker's 128 MB and kill the run before anything is recorded. Those are skipped here; the off-site copy's
    // SQLite restore test (.github/workflows/offsite-backup.yml) covers them.
    const size = (latest as { size?: number }).size ?? 0;
    if (size > DRILL_MAX_GZ_BYTES) {
      report[name] = { ok: true, mismatches: [], tables: 0, backup: latest.key, skipped: `backup is ${(size / 1048576).toFixed(1)} MB compressed, too large to restore inside a Worker; restore-test it off-site` };
      continue;
    }
    const obj = await opsBucket(env).get(latest.key);
    // Decoded once; the bytes for the import are built from the reordered text and dropped after it.
    const sql = await new Response(obj!.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const exportCounts = countInserts(sql);
    const samples = sampleExport(sql);
    await dropAllTables(env, target.uuid);
    await importSql(env, target.uuid, new TextEncoder().encode(`-- restore drill ${now}
` + restoreOrder(sql)));
    const [a, b] = [await rowCounts(env, src.uuid), await rowCounts(env, target.uuid)];
    // The backup is up to a week old; live tables can only have grown or shrunk since. Compare against the
    // backup's own counts by checking structure (same tables) and that restored counts equal the export.
    const mismatches = Object.keys(a)
      .filter((t) => !(t in b))
      .map((t) => `missing table ${t}`);
    // D1 manages sqlite_*, _cf_* and d1_* itself (rowCounts skips them too).
    for (const [t, n] of Object.entries(exportCounts)) if (!/^(sqlite_|_cf_|d1_)/.test(t) && (b[t] ?? 0) !== n) mismatches.push(`${t}: backup ${n}, restored ${b[t] ?? 0}`);
    // Counts can agree while values don't: compare the first rows of every table with the export, by checksum.
    const { sampled, unchecked } = await compareSamples(env, target.uuid, samples, mismatches);
    report[name] = { ok: mismatches.length === 0, mismatches, tables: Object.keys(b).length, backup: latest.key, sampled, unchecked };
    await dropAllTables(env, target.uuid);
  }
  const ok = Object.values(report).every((r) => r.ok);
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value, updated_at) VALUES ('last_restore_drill', ?, ?)").bind(JSON.stringify({ at: now, ok, report }), now).run();
  await audit(env.DB, "cron", "ops.restore_drill", null, report);
  return { ok, report };
}

export const STALE_DAYS = 8;

/**
 * Daily: is the newest backup of every backed-up database (ops-backups) and of Pulse itself (pulse-backups)
 * younger than STALE_DAYS? Emails once a day while any is stale or missing. Read from R2, not from kv_meta, so
 * a run that "succeeded" without writing anything still counts as stale.
 */
export async function backupFreshness(env: Env, now = Date.now()): Promise<{ stale: string[]; missing: string[] }> {
  const limit = now - STALE_DAYS * 86_400_000;
  const stale: string[] = [];
  const age = (t: number | null) => (t === null ? "no backup found" : `newest backup ${Math.floor((now - t) / 86_400_000)} days old`);
  const missing: string[] = [];
  const pulsePrefix = `${env.ENVIRONMENT}/`;
  const listed = await env.BACKUPS.list({ prefix: pulsePrefix, delimiter: "/" });
  const newestPulse = newestBackupKey(listed.delimitedPrefixes.map((key) => ({ key })), pulsePrefix);
  const pulseAt = newestPulse ? stampTime(newestPulse.key.slice(pulsePrefix.length)) : null;
  if (pulseAt === null || pulseAt < limit) stale.push(`pulse-backups/${pulsePrefix}: ${age(pulseAt)}`);
  if (env.OPS_BACKUPS) {
    // A database deleted from the account can't be backed up any more; the status board lists it instead of
    // this email repeating it every day. If the account can't be listed, every chosen database is checked.
    const existing = await listD1(env).then((dbs) => new Set(dbs.map((d) => d.name)), () => null);
    for (const name of (await getOpsSettings(env.DB)).backup_databases) {
      if (existing && !existing.has(name)) {
        missing.push(name);
        continue;
      }
      const list = await env.OPS_BACKUPS.list({ prefix: `${name}/` });
      const newest = newestBackupKey(list.objects, `${name}/`);
      const at = newest ? stampTime(newest.key.slice(name.length + 1)) : null;
      if (at === null || at < limit) stale.push(`ops-backups/${name}/: ${age(at)}`);
    }
  }
  if (stale.length) {
    const day = new Date(now).toISOString().slice(0, 10);
    const claim = await env.DB.prepare(
      "INSERT INTO kv_meta (key, value, updated_at) VALUES ('backup_stale_warned', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE kv_meta.value <> excluded.value",
    )
      .bind(day, now)
      .run();
    if (claim.meta.changes)
      await sendMail(
        env,
        "⚠️ Pulse backups are out of date",
        [
          `These backups are older than ${STALE_DAYS} days:`,
          ...stale.map((s) => `- ${s}`),
          "",
          'Weekly backups run Sundays 04:00 UTC. Run one now: POST /api/v1/ops/run {"job": "ops_backup"} (or "pulse_backup") with an admin key, and check /status → Backups.',
        ].join("\n"),
      );
  }
  return { stale, missing };
}

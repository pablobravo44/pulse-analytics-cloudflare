import type { Env } from "../env.ts";
import { rotateSalts } from "../ingest/salt.ts";
import { audit } from "../lib/audit.ts";
import { freeBackupStamp, stampTime } from "../lib/backupkeys.ts";
import { putStream } from "../ops/r2stream.ts";
import { listSitesCached } from "../lib/sites.ts";
import { addDays, localParts, utcDay } from "../lib/time.ts";

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO kv_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, Date.now())
    .run();
}

export async function hourly(env: Env, now = Date.now()): Promise<void> {
  await rotateSalts(env.DB, now);
  const { dataCounts } = await import("../api/sites.ts");
  await dataCounts(env.DB, (await listSitesCached(env.DB)).map((s) => s.id), now);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM api_keys WHERE expires_at IS NOT NULL AND expires_at < ? AND revoked_at IS NULL AND name LIKE 'admin-import%'").bind(now - 30 * 86_400_000),
  ]);
  // OAuth grants and tokens live in KV with TTLs managed by workers-oauth-provider.
}

export async function every10(env: Env, now = Date.now()): Promise<void> {
  // Keep a cheap snapshot of today's ingest counters for /health and the dashboard.
  const { results } = await env.DB.prepare("SELECT site_id, accepted, dropped_bot, dropped_hosting, dropped_dnt, dropped_invalid, dropped_rate FROM ingest_stats WHERE day = ?").bind(utcDay(now)).all();
  await setMeta(env.DB, "ingest_snapshot", JSON.stringify({ at: now, rows: results }));
}

const ROLLUP_DIMS: Record<string, string> = {
  _total: "'all'",
  page: "e.pathname",
  channel: "s.channel",
  referrer_host: "COALESCE(s.referrer_host, '')",
  country: "COALESCE(s.country, '')",
  device: "COALESCE(s.device, '')",
  browser: "COALESCE(s.browser, '')",
  os: "COALESCE(s.os, '')",
  event_name: "CASE WHEN e.type = 'event' THEN e.name END",
};

/** Months back from a local day, clamped to month length. */
export function monthsBack(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Aggregate one day of raw data into rollups_daily, then delete the raw rows. */
export async function rollupAndDelete(db: D1Database, siteId: string, day: string): Promise<{ events: number; sessions: number }> {
  const stmts: D1PreparedStatement[] = [];
  for (const [dim, expr] of Object.entries(ROLLUP_DIMS)) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO rollups_daily (site_id, day, dimension, value, visitors, sessions, pageviews, events, bounces, engaged_ms)
           SELECT ?, ?, ?, v, COUNT(DISTINCT vid), COUNT(*), SUM(pv), SUM(ce), SUM(b), SUM(eng) FROM (
             SELECT ${expr} AS v, e.session_id AS sid, MAX(e.visitor_id) AS vid, SUM(e.type = 'pageview') AS pv,
                    SUM(e.type = 'event') AS ce, MAX(COALESCE(s.bounced, 0)) AS b, SUM(COALESCE(e.engaged_ms, 0)) AS eng
             FROM events e LEFT JOIN sessions s ON s.id = e.session_id
             WHERE e.site_id = ? AND e.local_day = ? GROUP BY 1, 2
           ) WHERE v IS NOT NULL AND (pv > 0 OR ce > 0) GROUP BY v`,
        )
        .bind(siteId, day, dim, siteId, day),
    );
  }
  stmts.push(db.prepare("DELETE FROM stat_days WHERE site_id = ? AND day = ?").bind(siteId, day));
  stmts.push(db.prepare("DELETE FROM events WHERE site_id = ? AND local_day = ?").bind(siteId, day));
  stmts.push(db.prepare("DELETE FROM sessions WHERE site_id = ? AND local_day = ? AND last_seen_at < ?").bind(siteId, day, Date.now() - 86_400_000));
  const res = await db.batch(stmts);
  return { events: res[res.length - 2]!.meta.changes ?? 0, sessions: res[res.length - 1]!.meta.changes ?? 0 };
}

export async function retention(env: Env, now = Date.now(), maxDays = 31): Promise<{ site: string; days: string[] }[]> {
  const out: { site: string; days: string[] }[] = [];
  for (const site of await listSitesCached(env.DB)) {
    const cutoff = monthsBack(localParts(now, site.timezone).day, site.retention_months);
    const { results } = await env.DB.prepare("SELECT DISTINCT local_day AS d FROM events WHERE site_id = ? AND local_day < ? ORDER BY d LIMIT ?")
      .bind(site.id, cutoff, maxDays)
      .all<{ d: string }>();
    const days: string[] = [];
    for (const { d } of results) {
      await rollupAndDelete(env.DB, site.id, d);
      days.push(d);
    }
    if (days.length) {
      await audit(env.DB, "cron", "retention", site.id, { from: days[0], to: days[days.length - 1], cutoff });
      out.push({ site: site.id, days });
    }
  }
  return out;
}

const BACKUP_TABLES = [
  "sites", "events", "sessions", "goals", "funnels", "annotations", "users", "api_keys", "audit_log",
  "imports", "ingest_stats", "rollups_daily", "settings", "monitors", "incidents", "notification_channels",
  "alert_rules", "saved_views", "share_links", "links", "reports",
];

/** One table as NDJSON, read 5000 rows at a time by rowid as the consumer pulls; `rows()` is the count so far. */
export function tableNdjson(db: D1Database, table: string): { stream: ReadableStream<Uint8Array<ArrayBuffer>>; rows: () => number } {
  const enc = new TextEncoder();
  let lastRowid = 0;
  let n = 0;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(ctrl) {
      // table is from BACKUP_TABLES, never user input.
      const { results } = await db.prepare(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 5000`).bind(lastRowid).all<Record<string, unknown>>();
      let lines = "";
      for (const r of results) {
        lastRowid = r._rowid as number;
        delete r._rowid;
        lines += JSON.stringify(r) + "\n";
      }
      n += results.length;
      if (lines) ctrl.enqueue(enc.encode(lines));
      if (results.length < 5000) ctrl.close();
    },
  });
  return { stream, rows: () => n };
}

/**
 * Weekly NDJSON export of every table to R2 (`<env>/<stamp>/<table>.ndjson.gz`). Keeps 12 weeks. The bucket
 * has a retention lock, so a run never writes into a folder that exists: a second run on the same UTC day goes
 * to `<date>T<HHMM>/` (src/worker/lib/backupkeys.ts).
 */
export async function backup(env: Env, now = Date.now()): Promise<{ key: string; tables: Record<string, number> }> {
  const day = utcDay(now);
  let prefix = `${env.ENVIRONMENT}/${day}/`;
  const tables: Record<string, number> = {};
  try {
    const stamp = await freeBackupStamp(now, async (s) => (await env.BACKUPS.list({ prefix: `${env.ENVIRONMENT}/${s}/`, limit: 1 })).objects.length > 0);
    prefix = `${env.ENVIRONMENT}/${stamp}/`;
    // Each table streams from D1 through gzip into a multipart upload: memory holds one page and one part.
    for (const t of BACKUP_TABLES) {
      const { stream, rows } = tableNdjson(env.DB, t);
      await putStream(env.BACKUPS, `${prefix}${t}.ndjson.gz`, stream.pipeThrough(new CompressionStream("gzip")), { httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" } });
      tables[t] = rows();
    }
    // Retention: 12 weekly snapshots. Only folders named by a backup stamp are touched; a failed delete (an
    // object still under the bucket lock) doesn't fail the backup.
    const keep = Date.parse(`${addDays(day, -84)}T00:00:00Z`);
    const listed = await env.BACKUPS.list({ prefix: `${env.ENVIRONMENT}/`, delimiter: "/" });
    for (const p of listed.delimitedPrefixes) {
      const t = stampTime(p.slice(env.ENVIRONMENT.length + 1, -1));
      if (t === null || t >= keep) continue;
      try {
        const objs = await env.BACKUPS.list({ prefix: p });
        if (objs.objects.length) await env.BACKUPS.delete(objs.objects.map((o) => o.key));
      } catch (err) {
        console.warn(JSON.stringify({ msg: "backup_prune_failed", prefix: p, error: String(err).slice(0, 200) }));
      }
    }
    await setMeta(env.DB, "last_backup", JSON.stringify({ at: now, ok: true, key: prefix, tables }));
    await audit(env.DB, "cron", "backup", prefix, tables);
    return { key: prefix, tables };
  } catch (err) {
    await setMeta(env.DB, "last_backup", JSON.stringify({ at: now, ok: false, key: prefix, error: String(err).slice(0, 200) }));
    throw err;
  }
}

export const CRONS = {
  frequent: "*/5 * * * *",
  daily: "0 3 * * *",
  weekly: "0 4 * * SUN",
  monthly: "0 5 1 * *",
} as const;

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(JSON.stringify({ msg: "cron_step_failed", step: name, error: String((err as Error).message ?? err).slice(0, 300) }));
  }
}

/**
 * Run a backup or drill job and email the alert address when it throws or reports ok: false (production only; a manual
 * run through /ops/run shows its result instead).
 */
export async function alerting(env: Env, name: string, fn: () => Promise<unknown>): Promise<unknown> {
  const mail = async (detail: string) => {
    const { sendMail } = await import("../ops/email.ts");
    await sendMail(env, `⚠️ Pulse ${name} failed`, `The ${name} failed at ${new Date().toISOString()}.\n\n${detail}\n\nDetails: ${env.PUBLIC_ORIGIN}/status`).catch((e) =>
      console.error(JSON.stringify({ msg: "alert_send_failed", error: String(e).slice(0, 200) })),
    );
  };
  let result: unknown;
  try {
    result = await fn();
  } catch (err) {
    if (env.ENVIRONMENT === "production") await mail(String((err as Error).message ?? err).slice(0, 1000));
    throw err;
  }
  if (env.ENVIRONMENT === "production" && result && typeof result === "object" && (result as { ok?: unknown }).ok === false) await mail(JSON.stringify(result, null, 2).slice(0, 4000));
  return result;
}

/** Five cron triggers (the per-Worker budget); finer schedules are derived from the minute/hour. Ops jobs run in production only. */
export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  const now = controller.scheduledTime;
  const prod = env.ENVIRONMENT === "production";
  const { runMonitors, recordDbSizes, pruneChecks } = await import("../ops/monitor.ts");
  switch (controller.cron) {
    case CRONS.frequent: {
      const minute = new Date(now).getUTCMinutes();
      if (prod) await step("monitors", () => runMonitors(env, now));
      if (prod) {
        const { evaluateAlerts } = await import("../ops/alerts.ts");
        await step("alerts", () => evaluateAlerts(env, now));
      }
      if (prod) {
        const { runDueReports } = await import("../ops/reports.ts");
        await step("reports", () => runDueReports(env, now));
      }
      // Daily rollups for the query engine: close finished days, rebuild today (src/worker/query/rollup.ts).
      await step("rollups", async () => {
        const { refreshRollups } = await import("../query/rollup.ts");
        return refreshRollups(env.DB, await listSitesCached(env.DB), now);
      });
      if (minute % 10 === 0) await step("every10", () => every10(env, now));
      if (minute === 5) await step("hourly", () => hourly(env, now));
      // The D1 size guard runs hourly so a fast-growing database is caught within the hour (one email a day).
      if (minute === 5 && prod) await step("db_sizes", () => recordDbSizes(env, now));
      return;
    }
    case CRONS.daily:
      await step("retention", () => retention(env, now));
      await step("prune_checks", () => pruneChecks(env, now));
      if (prod) {
        const { backupFreshness } = await import("../ops/backups.ts");
        await step("backup_freshness", () => backupFreshness(env, now));
      }
      return;
    case CRONS.weekly:
      await step("pulse_backup", () => alerting(env, "NDJSON backup", () => backup(env, now)));
      if (prod) {
        const { backupDatabases } = await import("../ops/backups.ts");
        await step("ops_backup", () => alerting(env, "database backup", () => backupDatabases(env, now)));
      }
      return;
    case CRONS.monthly:
      if (prod) {
        const { restoreDrill } = await import("../ops/backups.ts");
        await step("restore_drill", () => alerting(env, "restore drill", () => restoreDrill(env, now)));
      }
      return;
    default:
      console.warn(JSON.stringify({ msg: "unknown_cron", cron: controller.cron }));
  }
}

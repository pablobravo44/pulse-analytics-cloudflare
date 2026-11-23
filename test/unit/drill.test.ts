// Restore drill (sample checksums), backup failure alerts and the stale-backup warning.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alerting, scheduled } from "../../src/worker/cron/jobs.ts";
import { DEFAULT_OPS, putSetting } from "../../src/worker/lib/settings.ts";
import { backupFreshness, restoreDrill } from "../../src/worker/ops/backups.ts";
import { statusReport } from "../../src/worker/ops/monitor.ts";
import { normalizeApiValue, parseValues, sampleExport } from "../../src/worker/ops/drillcheck.ts";
import { makeEnv, MemR2 } from "./harness.ts";

let h: ReturnType<typeof makeEnv>;
let sent: string[];
const decode = (raw: string) => Buffer.from(raw.split("\r\n\r\n").at(-1)!.replace(/\s/g, ""), "base64").toString();
const subject = (raw: string) => {
  const s = /^Subject: (.*)$/m.exec(raw)![1]!;
  const b = /^=\?UTF-8\?B\?(.*)\?=$/.exec(s);
  return b ? Buffer.from(b[1]!, "base64").toString() : s;
};

beforeEach(() => {
  h = makeEnv();
  sent = [];
  Object.assign(h.env, { ENVIRONMENT: "production", ALERT_EMAIL: "owner@example.com", PULSE_OPS_TOKEN: "t", SEND_EMAIL: { send: async (m: { raw: string }) => void sent.push(m.raw) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("export sample parser", () => {
  it("reads plain literals and refuses function calls", () => {
    expect(parseValues(`INSERT INTO "a" VALUES(1,'it''s',NULL,X'00FF',-2.5e3,'two\nlines);\n');`)).toEqual([1, "it's", null, "x:00ff", -2500, "two\nlines);\n"]);
    expect(parseValues(`INSERT INTO "a" VALUES(replace('a\\nb','\\n',char(10)));`)).toBeNull();
    const sql = `PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE a (x, y);\nINSERT INTO "a" VALUES(1,'x');\nINSERT INTO "a" VALUES(2,'has ");\n" inside');\nINSERT INTO b VALUES(unistr('\\u00e9'));\n`;
    expect(sampleExport(sql)).toEqual({ a: [[1, "x"], [2, 'has ");\n" inside']], b: null });
    expect(sampleExport(sql, 1).a).toEqual([[1, "x"]]);
    expect(normalizeApiValue([0, 255])).toBe("x:00ff");
    expect(normalizeApiValue(true)).toBe(1);
    expect(normalizeApiValue(new Uint8Array([1, 2]))).toBe("x:0102");
    expect(normalizeApiValue({ 0: 1, 1: 2 })).toBe("x:0102");
  });
});

/** A fake Cloudflare D1 REST API over node:sqlite databases, enough for the drill. */
function fakeD1(dbs: Record<string, DatabaseSync>, opts: { corrupt?: string } = {}) {
  const uploads = new Map<string, string>();
  const ok = (result: unknown) => Response.json({ success: true, result });
  return async (input: string | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.startsWith("https://upload.example/")) {
      uploads.set(url, await new Response(init!.body as BodyInit).text());
      return new Response(null, { status: 200 });
    }
    if (url.includes("/d1/database?")) return ok(Object.keys(dbs).map((name) => ({ uuid: name, name })));
    const m = /\/d1\/database\/([^/]+)\/(query|import)$/.exec(url);
    if (!m) return new Response("no", { status: 404 });
    const db = dbs[m[1]!]!;
    const body = JSON.parse(String(init!.body)) as { sql?: string; params?: unknown[]; action?: string; etag?: string };
    if (m[2] === "query") {
      const stmt = db.prepare(body.sql!);
      const isRead = /^\s*(SELECT|WITH)/i.test(body.sql!);
      return ok([{ results: isRead ? stmt.all(...((body.params ?? []) as never[])) : (stmt.run(...((body.params ?? []) as never[])), []) }]);
    }
    if (body.action === "init") return ok({ upload_url: `https://upload.example/${body.etag}`, filename: body.etag });
    if (body.action === "ingest") {
      db.exec(uploads.get(`https://upload.example/${body.etag}`)!.replace(/^PRAGMA[^\n]*\n/, ""));
      if (opts.corrupt) db.exec(opts.corrupt);
      return ok({ status: "complete" });
    }
    return ok({ status: "complete" });
  };
}

const EXPORT = `PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE movies (id INTEGER PRIMARY KEY, title TEXT, rating REAL, poster BLOB);\nINSERT INTO "movies" VALUES(1,'Dune',8.5,X'0102');\nINSERT INTO "movies" VALUES(2,'It''s',NULL,NULL);\nCREATE TABLE shows (id INTEGER PRIMARY KEY, movie_id INTEGER REFERENCES movies(id), at TEXT);\nINSERT INTO "shows" VALUES(1,1,'2026-10-18 20:00');\n`;

async function setup(corrupt?: string) {
  const src = new DatabaseSync(":memory:");
  src.exec(EXPORT.replace(/^PRAGMA[^\n]*\n/, ""));
  const drill = new DatabaseSync(":memory:");
  const r2 = new MemR2(true);
  const gz = await new Response(new Blob([EXPORT]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  await r2.put("app-db/2026-10-11.sql.gz", gz);
  await r2.put("app-db/2026-10-04.sql.gz", "older, never read");
  Object.assign(h.env, { OPS_BACKUPS: r2 });
  await putSetting(h.db, "ops", { ...DEFAULT_OPS, drill_databases: ["app-db"] }, "test");
  vi.stubGlobal("fetch", fakeD1({ "app-db": src, "restore-drill": drill }, { corrupt }));
}

describe("restore drill", () => {
  it("restores the newest backup and compares counts and the first rows of every table", async () => {
    await setup();
    const r = await restoreDrill(h.env, Date.UTC(2026, 10, 1, 5));
    expect(r.report["app-db"]).toMatchObject({ ok: true, mismatches: [], backup: "app-db/2026-10-11.sql.gz", sampled: 2, unchecked: [] });
  });

  it("fails when a restored value differs although the counts agree, and the monthly run emails", async () => {
    await setup("UPDATE movies SET title = 'Dune 2' WHERE id = 1");
    await scheduled({ cron: "0 5 1 * *", scheduledTime: Date.UTC(2026, 10, 1, 5), noRetry() {} } as unknown as ScheduledController, h.env);
    const meta = JSON.parse((h.db.sqlite.prepare("SELECT value FROM kv_meta WHERE key = 'last_restore_drill'").get() as { value: string }).value);
    expect(meta.ok).toBe(false);
    expect(meta.report["app-db"].mismatches).toEqual(["movies: the first 2 rows differ from the backup"]);
    expect(sent).toHaveLength(1);
    expect(subject(sent[0]!)).toContain("restore drill failed");
    expect(decode(sent[0]!)).toContain("movies: the first 2 rows differ");
  });
});

describe("restore drill size limit", () => {
  it("skips a backup too large to restore inside a Worker, and the board says so", async () => {
    await setup();
    const { DRILL_MAX_GZ_BYTES } = await import("../../src/worker/ops/backups.ts");
    const r2 = h.env.OPS_BACKUPS as unknown as MemR2;
    await r2.put("app-db/2026-10-25.sql.gz", new Uint8Array(DRILL_MAX_GZ_BYTES + 1));
    const r = await restoreDrill(h.env, Date.UTC(2026, 10, 1, 5));
    expect(r.ok).toBe(true);
    expect(r.report["app-db"]).toMatchObject({ ok: true, skipped: expect.stringContaining("too large") });
    expect((await statusReport(h.env, Date.UTC(2026, 10, 1, 6))).backups.drill?.skipped[0]).toMatch(/^app-db: backup is/);
  });
});

describe("restore drill failures", () => {
  it("a drill that throws is recorded, so the status board shows it failed instead of last month's success", async () => {
    await setup();
    h.db.sqlite.prepare("INSERT OR REPLACE INTO kv_meta (key, value, updated_at) VALUES ('last_restore_drill', ?, 0)").run(JSON.stringify({ at: Date.UTC(2026, 8, 1, 5), ok: true, report: {} }));
    vi.stubGlobal("fetch", async () => Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 401 }));
    await expect(restoreDrill(h.env, Date.UTC(2026, 10, 1, 5))).rejects.toThrow();
    const board = await statusReport(h.env, Date.UTC(2026, 10, 1, 6));
    expect(board.backups.drill).toMatchObject({ ok: false, overdue: false });
    expect(board.backups.drill?.problems[0]).toMatch(/401|Authentication/);
  });
});

describe("backup alerts", () => {
  it("email when a job throws or reports ok: false, only in production", async () => {
    await expect(alerting(h.env, "database backup", async () => Promise.reject(new Error("export timed out")))).rejects.toThrow("export timed out");
    await alerting(h.env, "database backup", async () => ({ ok: false, errors: ["other-db: not found"] }));
    await alerting(h.env, "database backup", async () => ({ ok: true }));
    expect(sent.map(subject)).toEqual(["⚠️ Pulse database backup failed", "⚠️ Pulse database backup failed"]);
    expect(decode(sent[0]!)).toContain("export timed out");
    expect(decode(sent[1]!)).toContain("other-db: not found");
    h.env.ENVIRONMENT = "development";
    await alerting(h.env, "database backup", async () => ({ ok: false }));
    expect(sent).toHaveLength(2);
  });

  it("warn once a day when the newest backup is older than 8 days, whatever the key shape", async () => {
    const pulse = new MemR2(true);
    const ops = new MemR2(true);
    Object.assign(h.env, { BACKUPS: pulse, OPS_BACKUPS: ops });
    await putSetting(h.db, "ops", { ...DEFAULT_OPS, backup_databases: ["app-db", "other-db"] }, "test");
    const now = Date.UTC(2026, 9, 19, 3);
    await pulse.put("production/2026-10-18T0400/events.ndjson.gz", "x");
    await ops.put("app-db/2026-10-18.sql.gz", "x");
    await ops.put("other-db/2026-10-04.sql.gz", "x");
    await ops.put("other-db/2026-10-11T0930.sql.gz", "x");
    expect((await backupFreshness(h.env, now)).stale).toEqual([]);
    expect(sent).toHaveLength(0);

    const later = Date.UTC(2026, 9, 21, 3);
    expect((await backupFreshness(h.env, later)).stale).toEqual(["ops-backups/other-db/: newest backup 9 days old"]);
    await backupFreshness(h.env, later + 3_600_000);
    expect(sent).toHaveLength(1);
    expect(subject(sent[0]!)).toBe("⚠️ Pulse backups are out of date");

    await ops.delete("app-db/2026-10-18.sql.gz");
    const r = await backupFreshness(h.env, Date.UTC(2026, 9, 22, 3));
    expect(r.stale).toContain("ops-backups/app-db/: no backup found");
    expect(sent).toHaveLength(2);
  });
});

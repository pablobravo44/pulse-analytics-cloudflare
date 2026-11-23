import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backup, monthsBack, rollupAndDelete, scheduled } from "../../src/worker/cron/jobs.ts";
import { backupDatabases, countInserts, restoreOrder } from "../../src/worker/ops/backups.ts";
import { backupStamps, newestBackupKey, stampTime } from "../../src/worker/lib/backupkeys.ts";
import { putSetting, DEFAULT_OPS } from "../../src/worker/lib/settings.ts";
import { buildMime } from "../../src/worker/ops/email.ts";
import { jsonNonEmpty, pruneChecks, LAST_LIVE_EVENT, LAST_LIVE_EVENT_SITE, usualEventsInWindow, runCheck, runMonitors, statusReport, type Monitor } from "../../src/worker/ops/monitor.ts";
import { buildReport, getReport, reportView } from "../../src/worker/ops/reports.ts";
import { insertSite, OTHER, SITE, hit } from "./fixtures.ts";
import { makeEnv, MemR2 } from "./harness.ts";

let h: ReturnType<typeof makeEnv>;
const sent: { from: string; to: string; raw: string }[] = [];

beforeEach(async () => {
  h = makeEnv();
  sent.length = 0;
  Object.assign(h.env, { ENVIRONMENT: "production", ALERT_EMAIL: "owner@example.com", SEND_EMAIL: { send: async (m: { from: string; to: string; raw: string }) => void sent.push(m) } });
  // Only one temporary monitor, to keep the test hermetic.
  h.db.sqlite.exec("DELETE FROM monitors");
  h.db.sqlite.prepare("INSERT INTO monitors (id, name, kind, url, created_at) VALUES ('t', 'Temp 404', 'http', 'https://example.test/404', 0)").run();
  await insertSite(h.db, SITE);
});
afterEach(() => vi.unstubAllGlobals());

describe("monitor", () => {
  it("opens an incident after two failures, emails, and emails again on recovery", async () => {
    // Status checks are notices: they email only with "email only for errors" turned off.
    await putSetting(h.db, "ops", { ...DEFAULT_OPS, email_only_errors: false }, "test");
    let status = 404;
    vi.stubGlobal("fetch", async () => new Response("x", { status }));
    await runMonitors(h.env, 1_000_000);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents").get()).toEqual({ n: 0 });
    await runMonitors(h.env, 1_300_000);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL").get()).toEqual({ n: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.raw).toContain("Subject:");
    await runMonitors(h.env, 1_600_000);
    expect(sent).toHaveLength(1);
    status = 200;
    await runMonitors(h.env, 1_900_000);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NOT NULL").get()).toEqual({ n: 1 });
    expect(sent).toHaveLength(2);
    const st = await statusReport(h.env, 2_000_000);
    expect(st.monitors[0]).toMatchObject({ id: "t", status: "up" });
    expect(st.incidents).toHaveLength(1);
  });

  it("status board cells come from monitor_days and match the raw checks", async () => {
    let ok = true;
    vi.stubGlobal("fetch", async () => new Response("x", { status: ok ? 200 : 500 }));
    const start = Date.UTC(2026, 9, 1, 12);
    for (let i = 0; i < 12; i++) {
      ok = i % 4 !== 0;
      await runMonitors(h.env, start + i * 8 * 3600_000);
    }
    const now = start + 4 * 86_400_000;
    const st = await statusReport(h.env, now);
    const raw = h.db.sqlite.prepare("SELECT CAST(ts / 86400000 AS INTEGER) AS d, COUNT(*) AS n, SUM(ok) AS up FROM checks WHERE monitor_id = 't' GROUP BY d").all() as { d: number; n: number; up: number }[];
    const cells = st.monitors[0]!.days.filter((c) => c.checks > 0);
    expect(cells).toEqual(raw.map((r) => ({ day: new Date(r.d * 86_400_000).toISOString().slice(0, 10), checks: r.n, up: r.up })));
    const n = raw.reduce((a, r) => a + r.n, 0);
    const up = raw.reduce((a, r) => a + r.up, 0);
    expect(st.monitors[0]!.uptime_30d).toBeCloseTo((100 * up) / n, 6);
  });

  it("json_nonempty", () => {
    expect(jsonNonEmpty({ success: true, data: { movies: [{ id: 1 }] } })).toBe(true);
    expect(jsonNonEmpty({ success: true, data: { movies: [] } })).toBe(false);
    expect(jsonNonEmpty([])).toBe(false);
  });
});

describe("check history", () => {
  it("is pruned once a day, not on every run", async () => {
    const now = Date.UTC(2026, 9, 15, 12);
    h.db.sqlite.prepare("INSERT INTO checks (monitor_id, ts, ok) VALUES ('t', ?, 1), ('t', ?, 1)").run(now - 91 * 86_400_000, now - 10 * 86_400_000);
    vi.stubGlobal("fetch", async () => new Response("ok"));
    await runMonitors(h.env, now);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM checks").get()).toEqual({ n: 3 });
    await scheduled({ cron: "0 3 * * *", scheduledTime: now, noRetry() {} } as unknown as ScheduledController, h.env);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM checks").get()).toEqual({ n: 2 });
    expect(await pruneChecks(h.env, now)).toBe(0);
  });
});

describe("ingest lag check", () => {
  it("finds the newest live event per site or overall through the (site_id, ts) index", async () => {
    await insertSite(h.db, OTHER);
    const now = Date.UTC(2026, 9, 15, 12);
    await hit(h.db, { u: "https://example.com/a" }, now - 200 * 60_000);
    await hit(h.db, { u: "https://other.com/b" }, now - 30 * 60_000, {}, OTHER);
    // A newer imported row doesn't count as live.
    const imported = await hit(h.db, { u: "https://example.com/c" }, now - 5 * 60_000);
    h.db.sqlite.prepare("UPDATE events SET source = 'rybbit' WHERE id = ?").run((imported as { id: string }).id);
    const check = (cfg: Record<string, unknown>) => runCheck(h.env, { id: "i", name: "Ingest", kind: "pulse_ingest", url: "self:ingest", config_json: JSON.stringify(cfg), created_at: 0 } as Monitor, now);
    expect(await check({ max_lag_min: 120, adaptive: false })).toMatchObject({ ok: true });
    expect(await check({ max_lag_min: 120, site_id: "test", adaptive: false })).toMatchObject({ ok: false, error: "no events for 200 min" });
    expect(await check({ max_lag_min: 120, site_id: "other", adaptive: false })).toMatchObject({ ok: true });
    expect(await check({ max_lag_min: 10, adaptive: false })).toMatchObject({ ok: false, error: "no events for 30 min" });
    for (const sql of [LAST_LIVE_EVENT, LAST_LIVE_EVENT_SITE]) {
      const plan = (h.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.includes("?") ? ["x"] : [])) as { detail: string }[]).map((r) => r.detail).join(" | ");
      expect(plan).toContain("USING INDEX events_site_ts");
    }
  });

  it("stays quiet in hours that are usually quiet, and alerts when they usually aren't", async () => {
    const now = Date.UTC(2026, 9, 15, 4); // 04:00, last event at 01:00
    await hit(h.db, { u: "https://example.com/a" }, now - 180 * 60_000);
    const check = () => runCheck(h.env, { id: "i", name: "Ingest", kind: "pulse_ingest", url: "self:ingest", config_json: JSON.stringify({ max_lag_min: 120 }), created_at: 0 } as Monitor, now);
    // No events between 01:00 and 04:00 on the previous days either: a quiet night, not an outage.
    expect(await check()).toMatchObject({ ok: true });
    expect(await usualEventsInWindow(h.env.DB, now - 180 * 60_000, now)).toBe(0);
    // Most of the last 7 days had several events in that stretch: now the silence is unusual.
    for (let d = 1; d <= 5; d++) for (let i = 0; i < 4; i++) await hit(h.db, { u: `https://example.com/n${i}` }, now - d * 86_400_000 - (30 + i * 20) * 60_000);
    expect(await usualEventsInWindow(h.env.DB, now - 180 * 60_000, now)).toBe(4);
    expect(await check()).toMatchObject({ ok: false, error: "no events for 180 min (usually 4 at this time)" });
  });
});

describe("D1 size guard", () => {
  it("runs hourly and warns once a day", async () => {
    Object.assign(h.env, { PULSE_OPS_TOKEN: "t" });
    await putSetting(h.db, "ops", { ...DEFAULT_OPS, email_only_errors: false }, "test");
    vi.stubGlobal("fetch", async (u: string | Request) => {
      const url = String(typeof u === "string" ? u : u.url);
      if (url.includes("/d1/database?")) return Response.json({ success: true, result: [{ uuid: "1", name: "big", file_size: 7 * 1024 ** 3 }] });
      return new Response("ok");
    });
    const at = (hour: number, minute: number) => ({ cron: "*/5 * * * *", scheduledTime: Date.UTC(2026, 9, 15, hour, minute), noRetry() {} }) as unknown as ScheduledController;
    await scheduled(at(10, 0), h.env);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM ops_metrics").get()).toEqual({ n: 0 });
    await scheduled(at(10, 5), h.env);
    await scheduled(at(11, 5), h.env);
    expect(h.db.sqlite.prepare("SELECT name, value FROM ops_metrics").all()).toEqual([{ name: "d1:big", value: 7 * 1024 ** 3 }]);
    expect(sent.filter((m) => m.raw.includes("Subject: =?UTF-8?B?"))).toHaveLength(1);
  });
});

describe("email", () => {
  it("builds valid MIME with encoded subject", () => {
    const m = buildMime("alerts@example.com", "o@x.com", "🔴 Down: Café", "hola", "<p>hola</p>");
    expect(m).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(m).toContain("multipart/alternative");
    expect(m.split("\r\n\r\n").length).toBeGreaterThan(2);
  });
});

describe("backups", () => {
  it("counts inserts per table in a D1 export", () => {
    const sql = `PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE a (x);\nINSERT INTO "a" VALUES(1);\nINSERT INTO "a" VALUES(2);\nINSERT INTO b VALUES(1);\n`;
    expect(countInserts(sql)).toEqual({ a: 2, b: 1 });
  });

  it("weekly NDJSON backup writes every table and records success", async () => {
    const puts: string[] = [];
    Object.assign(h.env, { BACKUPS: { put: async (k: string) => void puts.push(k), list: async () => ({ objects: [], delimitedPrefixes: [] }), delete: async () => {} } });
    await hit(h.db, { u: "https://example.com/" }, Date.now());
    const r = await backup(h.env, Date.UTC(2026, 9, 18, 4));
    expect(r.tables.events).toBe(1);
    expect(puts).toContain("production/2026-10-18/events.ndjson.gz");
    const meta = h.db.sqlite.prepare("SELECT value FROM kv_meta WHERE key = 'last_backup'").get() as { value: string };
    expect(JSON.parse(meta.value).ok).toBe(true);
  });
});

describe("backup keys under a retention lock", () => {
  it("never reuse a key: a second run on the same day gets a time suffix", () => {
    expect(backupStamps(Date.UTC(2026, 9, 18, 4, 7, 9))).toEqual(["2026-10-18", "2026-10-18T0407", "2026-10-18T040709"]);
    expect(stampTime("2026-10-18T0407.sql.gz")).toBe(Date.UTC(2026, 9, 18, 4, 7));
    expect(stampTime("2026-10-18/")).toBe(Date.UTC(2026, 9, 18));
    expect(stampTime("notes.txt")).toBeNull();
    const keys = ["db/2026-10-11.sql.gz", "db/2026-10-18.sql.gz", "db/2026-10-18T0407.sql.gz", "db/2026-10-04T2359.sql.gz", "db/README"].map((key) => ({ key }));
    expect(newestBackupKey(keys, "db/")?.key).toBe("db/2026-10-18T0407.sql.gz");
  });

  it("the NDJSON backup writes a new folder each run and prunes only old stamped folders", async () => {
    const r2 = new MemR2(true);
    Object.assign(h.env, { BACKUPS: r2 });
    await r2.put("production/2026-01-04/events.ndjson.gz", "old");
    await r2.put("production/2026-01-04T0400/events.ndjson.gz", "old");
    await r2.put("production/notes/readme.txt", "keep");
    await r2.put("production/2026-10-11/events.ndjson.gz", "recent");
    const a = await backup(h.env, Date.UTC(2026, 9, 18, 4));
    const b = await backup(h.env, Date.UTC(2026, 9, 18, 9, 30));
    expect(a.key).toBe("production/2026-10-18/");
    expect(b.key).toBe("production/2026-10-18T0930/");
    const keys = [...r2.objects.keys()];
    expect(keys).toContain("production/2026-10-18T0930/events.ndjson.gz");
    expect(keys.filter((k) => k.startsWith("production/2026-01-04"))).toEqual([]);
    expect(keys).toContain("production/notes/readme.txt");
    expect(keys).toContain("production/2026-10-11/events.ndjson.gz");
  });

  it("D1 SQL exports get a suffixed key on a second run the same day", async () => {
    const r2 = new MemR2(true);
    Object.assign(h.env, { OPS_BACKUPS: r2, PULSE_OPS_TOKEN: "t" });
    await putSetting(h.db, "ops", { ...DEFAULT_OPS, backup_databases: ["app-db"] }, "test");
    vi.stubGlobal("fetch", async (u: string | Request) => {
      const url = String(typeof u === "string" ? u : u.url);
      if (url.includes("/d1/database?")) return Response.json({ success: true, result: [{ uuid: "c1", name: "app-db" }] });
      if (url.endsWith("/export")) return Response.json({ success: true, result: { status: "complete", result: { signed_url: "https://r2.example/dump.sql" } } });
      if (url === "https://r2.example/dump.sql") return new Response("CREATE TABLE a (x);\nINSERT INTO a VALUES(1);\n");
      return new Response("nope", { status: 404 });
    });
    expect((await backupDatabases(h.env, Date.UTC(2026, 9, 18, 4))).ok).toBe(true);
    expect((await backupDatabases(h.env, Date.UTC(2026, 9, 18, 4, 12))).ok).toBe(true);
    expect([...r2.objects.keys()].sort()).toEqual(["app-db/2026-10-18.sql.gz", "app-db/2026-10-18T0412.sql.gz"]);
  });

  it("a chosen database that no longer exists is listed apart, not a failed backup, and the status board shows it", async () => {
    const r2 = new MemR2(true);
    Object.assign(h.env, { OPS_BACKUPS: r2, PULSE_OPS_TOKEN: "t" });
    await putSetting(h.db, "ops", { ...DEFAULT_OPS, backup_databases: ["app-db", "gone"] }, "test");
    vi.stubGlobal("fetch", async (u: string | Request) => {
      const url = String(typeof u === "string" ? u : u.url);
      if (url.includes("/d1/database?")) return Response.json({ success: true, result: [{ uuid: "c1", name: "app-db" }] });
      if (url.endsWith("/export")) return Response.json({ success: true, result: { status: "complete", result: { signed_url: "https://r2.example/dump.sql" } } });
      if (url === "https://r2.example/dump.sql") return new Response("CREATE TABLE a (x);\n");
      return new Response("nope", { status: 404 });
    });
    const now = Date.UTC(2026, 9, 18, 4);
    expect(await backupDatabases(h.env, now)).toMatchObject({ ok: true, errors: [], missing: ["gone"] });
    expect((await statusReport(h.env, now + 60_000)).backups).toMatchObject({ ok: true, errors: [], missing: ["gone"] });
  });
});

describe("retention", () => {
  it("months back clamps month ends", () => {
    expect(monthsBack("2026-10-12", 25)).toBe("2024-09-12");
    expect(monthsBack("2026-03-31", 1)).toBe("2026-02-28");
  });
  it("rolls a day up then deletes raw rows", async () => {
    const t = Date.UTC(2024, 0, 10, 10);
    await hit(h.db, { u: "https://example.com/a" }, t);
    await hit(h.db, { u: "https://example.com/b" }, t + 60_000);
    const r = await rollupAndDelete(h.db, SITE.id, "2024-01-10");
    expect(r.events).toBe(2);
    const total = h.db.sqlite.prepare("SELECT * FROM rollups_daily WHERE dimension = '_total'").get() as Record<string, number>;
    expect(total).toMatchObject({ pageviews: 2, sessions: 1, visitors: 1 });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM rollups_daily WHERE dimension = 'page'").get()).toEqual({ n: 2 });
  });
});

describe("weekly digest report", () => {
  it("builds the weekly digest with numbers matching the API", async () => {
    const now = Date.UTC(2026, 9, 19, 6); // Monday 08:00 Madrid
    await hit(h.db, { u: "https://example.com/" }, Date.UTC(2026, 9, 14, 10));
    const d = await buildReport(h.env, reportView(await getReport(h.env.DB, "weekly-digest")), now);
    expect(d.range).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(d.numbers[0]).toMatchObject({ site: "test", pageviews: 1 });
    expect(d.text).toContain("Ops");
    expect(d.html).toContain("Weekly digest");
  });
});


describe("restoreOrder", () => {
  it("moves every CREATE TABLE ahead of the rows, keeping the PRAGMA first", () => {
    const sql = [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE a (",
      "  id INTEGER",
      ");",
      "INSERT INTO a VALUES(1);",
      "CREATE TABLE b (id INTEGER, a_id INTEGER REFERENCES c(id));",
      "INSERT INTO b VALUES(1,1);",
      'CREATE TABLE IF NOT EXISTS "c" (id INTEGER);',
      "INSERT INTO c VALUES(1);",
      "CREATE INDEX i ON c(id);",
      "",
    ].join("\n");
    const out = restoreOrder(sql);
    expect(out.split("\n")[0]).toBe("PRAGMA defer_foreign_keys=TRUE;");
    expect(out.indexOf('CREATE TABLE IF NOT EXISTS "c"')).toBeLessThan(out.indexOf("INSERT INTO a"));
    expect(out.indexOf("CREATE INDEX i")).toBeGreaterThan(out.indexOf("INSERT INTO c"));
    expect(out.indexOf("INSERT INTO c")).toBeLessThan(out.indexOf("INSERT INTO b"));
    expect(countInserts(out)).toEqual(countInserts(sql));
    expect(out.length).toBe(sql.length);
  });
});

describe("quiet hours", () => {
  it("a failure inside the quiet window opens no incident; the same failure outside does", async () => {
    const { inQuietHours } = await import("../../src/worker/ops/monitor.ts");
    const night = { config_json: JSON.stringify({ quiet_hours: { from: "23:00", to: "07:00", tz: "Europe/Madrid" } }) };
    expect(inQuietHours(night, Date.UTC(2026, 10, 18, 23, 30))).toBe(true); // 00:30 Madrid
    expect(inQuietHours(night, Date.UTC(2026, 10, 18, 12, 0))).toBe(false); // 13:00 Madrid
    h.db.sqlite.prepare("UPDATE monitors SET config_json = ?, failures_to_alert = 1 WHERE id = 't'").run(night.config_json);
    vi.stubGlobal("fetch", async () => new Response("x", { status: 500 }));
    await runMonitors(h.env, Date.UTC(2026, 10, 18, 23, 30));
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents").get()).toEqual({ n: 0 });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM checks").get()).toEqual({ n: 1 });
    await runMonitors(h.env, Date.UTC(2026, 10, 18, 12, 0));
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents").get()).toEqual({ n: 1 });
  });
});

describe("Cloudflare account", () => {
  it("uses the only account the ops token can see when CF_ACCOUNT_ID isn't set", async () => {
    const { listD1 } = await import("../../src/worker/ops/cfapi.ts");
    Object.assign(h.env, { PULSE_OPS_TOKEN: "tok-discover", CF_ACCOUNT_ID: undefined });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: string | Request) => {
      const url = String(typeof u === "string" ? u : u.url);
      urls.push(url);
      if (url.includes("/accounts?")) return Response.json({ success: true, result: [{ id: "acc123" }] });
      return Response.json({ success: true, result: [] });
    });
    expect(await listD1(h.env)).toEqual([]);
    expect(urls[1]).toContain("/accounts/acc123/d1/database");
    Object.assign(h.env, { PULSE_OPS_TOKEN: "tok-two" });
    vi.stubGlobal("fetch", async () => Response.json({ success: true, result: [{ id: "a" }, { id: "b" }] }));
    await expect(listD1(h.env)).rejects.toThrow(/CF_ACCOUNT_ID/);
  });
});

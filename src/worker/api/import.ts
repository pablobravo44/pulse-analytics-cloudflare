import { z } from "@hono/zod-openapi";
import { audit } from "../lib/audit.ts";
import { INSERT_EVENT_SQL, eventValues } from "../queue/consumer.ts";
import { invalidateRollups } from "../query/rollup.ts";
import { importAnnotation } from "../lib/annotations.ts";

const s = z.string().max(2000).nullable().optional();
const n = z.number().nullable().optional();

export const importEventSchema = z.object({
  id: z.string().min(1).max(80),
  ts: z.number().int(),
  local_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  local_hour: z.number().int().min(0).max(23),
  type: z.enum(["pageview", "event", "engagement", "outbound", "download", "vitals", "error"]),
  session_id: z.string().min(1).max(80),
  visitor_id: z.string().min(1).max(80),
  pageview_id: s, hostname: s, pathname: s, query: s, title: s, referrer: s, referrer_host: s, channel: s,
  utm_source: s, utm_medium: s, utm_campaign: s, utm_term: s, utm_content: s,
  country: s, region: s, city: s, continent: s, device: s, browser: s, browser_version: s, os: s, os_version: s,
  screen_w: n, screen_h: n, language: s, name: s, props_json: s, engaged_ms: n, scroll_pct: n, url: s,
  lcp: n, inp: n, cls: n, fcp: n, ttfb: n,
});

export const importSessionSchema = z.object({
  id: z.string().min(1).max(80),
  visitor_id: z.string().min(1).max(80),
  started_at: z.number().int(),
  last_seen_at: z.number().int(),
  local_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entry_path: s, exit_path: s,
  pageviews: z.number().int().min(0),
  events: z.number().int().min(0),
  engaged_ms: z.number().int().min(0).default(0),
  duration_ms: z.number().int().min(0),
  bounced: z.union([z.literal(0), z.literal(1)]),
  hostname: s, referrer: s, referrer_host: s, channel: s, utm_source: s, utm_medium: s, utm_campaign: s, utm_term: s, utm_content: s,
  country: s, region: s, city: s, continent: s, device: s, browser: s, browser_version: s, os: s, os_version: s,
  screen_w: n, screen_h: n, language: s,
});

export const importSchema = z
  .object({
    site_id: z.string().min(1).max(64),
    source: z.enum(["rybbit"]),
    import_id: z.string().min(1).max(80),
    range_from: z.string().optional(),
    range_to: z.string().optional(),
    final: z.boolean().optional(),
    report: z.unknown().optional(),
    sessions: z.array(importSessionSchema).max(500).default([]),
    events: z.array(importEventSchema).max(500).default([]),
  })
  .openapi("ImportBatch");
export type ImportBatch = z.infer<typeof importSchema>;

const SESSION_COLS = [
  "id", "site_id", "visitor_id", "started_at", "last_seen_at", "local_day", "entry_path", "exit_path", "pageviews", "events",
  "engaged_ms", "duration_ms", "bounced", "hostname", "referrer", "referrer_host", "channel", "utm_source", "utm_medium",
  "utm_campaign", "utm_term", "utm_content", "country", "region", "city", "continent", "device", "browser", "browser_version",
  "os", "os_version", "screen_w", "screen_h", "language", "source",
] as const;
const INSERT_SESSION_SQL = `INSERT OR REPLACE INTO sessions (${SESSION_COLS.join(", ")}) VALUES (${SESSION_COLS.map(() => "?").join(", ")})`;
const UPSERT_EVENT_SQL = INSERT_EVENT_SQL.replace("INSERT OR IGNORE", "INSERT OR REPLACE");

export async function importBatch(db: D1Database, b: ImportBatch, actor: string) {
  const stmts: D1PreparedStatement[] = [];
  for (const x of b.sessions) {
    const row: Record<string, unknown> = { ...x, site_id: b.site_id, source: b.source };
    stmts.push(db.prepare(INSERT_SESSION_SQL).bind(...SESSION_COLS.map((c) => row[c] ?? null)));
  }
  for (const e of b.events) {
    stmts.push(db.prepare(UPSERT_EVENT_SQL).bind(...eventValues({ ...e, site_id: b.site_id, source: b.source })));
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  // Rollups from the first imported day on are rebuilt by the next cron runs.
  const days = [...b.sessions.map((s) => s.local_day), ...b.events.map((e) => e.local_day)].filter((d): d is string => typeof d === "string").sort();
  if (days.length) await invalidateRollups(db, b.site_id, days[0]!);

  await db
    .prepare(
      `INSERT INTO imports (id, site_id, source, range_from, range_to, rows_events, rows_sessions, status, report_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET rows_events = rows_events + excluded.rows_events, rows_sessions = rows_sessions + excluded.rows_sessions,
         range_from = COALESCE(excluded.range_from, range_from), range_to = COALESCE(excluded.range_to, range_to),
         status = excluded.status, report_json = COALESCE(excluded.report_json, report_json)`,
    )
    .bind(b.import_id, b.site_id, b.source, b.range_from ?? null, b.range_to ?? null, b.events.length, b.sessions.length, b.final ? "done" : "running", b.report === undefined ? null : JSON.stringify(b.report), Date.now())
    .run();
  if (b.final) {
    // Where the imported data ends, mark that bounce and time measures change definition.
    const end = await db.prepare("SELECT MAX(range_to) AS d FROM imports WHERE site_id = ? AND range_to IS NOT NULL").bind(b.site_id).first<{ d: string | null }>();
    if (end?.d) await importAnnotation(db, b.site_id, b.source, end.d).run();
    await audit(db, actor, "import.done", b.site_id, { import_id: b.import_id });
  }
  return { sessions: b.sessions.length, events: b.events.length };
}

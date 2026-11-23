// Status checks: run on the 5-minute cron (each at its own interval), incidents after N consecutive failures,
// email on open and recovery. Every check is data in the `monitors` table, editable in the dashboard, REST and MCP.
import { z } from "zod";
import type { Env } from "../env.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { getOpsSettings } from "../lib/settings.ts";
import { isValidTimeZone, localParts } from "../lib/time.ts";
import { d1Query, listD1 } from "./cfapi.ts";
import { sendMail } from "./email.ts";
import { notify } from "./notify.ts";

export const MONITOR_KINDS = ["http", "json", "json_nonempty", "heartbeat", "d1_query", "pulse_ingest", "dns", "domain_expiry"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];
export const INTERVALS = [5, 10, 15, 30, 60, 360, 1440] as const;

export const KIND_INFO: Record<MonitorKind, string> = {
  http: "Fetch a URL; up when the status matches (and the keyword rules hold)",
  json: "Fetch JSON; up when a value at a path exists, is non-empty, equals something or is recent",
  json_nonempty: "Fetch JSON; up when it contains a non-empty array (older kind; use json)",
  heartbeat: "Your job calls a secret URL; up while the calls keep arriving",
  d1_query: "Run a read-only SELECT on one of your D1 databases; up when the `ok` column is true (admin only: it can read any database in the account)",
  pulse_ingest: "Pulse itself: up while live events keep arriving",
  dns: "Resolve a DNS record; up when it resolves (and contains the expected value)",
  domain_expiry: "Domain registration (RDAP); down when it expires within the warning window",
};

export interface Monitor {
  id: string;
  name: string;
  kind: MonitorKind;
  url: string;
  expect_status: number;
  enabled: number;
  temporary: number;
  created_at: number;
  site_id: string | null;
  config_json: string;
  interval_min: number;
  timeout_ms: number;
  failures_to_alert: number;
  degraded_ms: number | null;
  paused_until: number | null;
  notify: number;
  sort: number;
  last_ping_at: number | null;
  updated_at: number | null;
  channel_ids_json?: string | null;
}

export interface CheckResult {
  ok: boolean;
  status: number | null;
  ms: number | null;
  error: string | null;
}

const READ_ONLY_FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback|savepoint)\b/i;

/**
 * The SQL with every string literal, quoted identifier and comment blanked, scanning left to right so a quote
 * character inside another kind of quote can't hide a keyword. Returns null when a quote or comment never closes.
 */
export function sqlSkeleton(sql: string): string | null {
  let out = "";
  let i = 0;
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      if (end < 0) break;
      out += " ";
      i = end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return null;
      out += " ";
      i = end + 2;
    } else if (c in closers) {
      const close = closers[c]!;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) return null;
        // A doubled quote is an escaped quote inside the literal.
        if (close !== "]" && sql[k + 1] === close) {
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      out += " _ ";
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** A single SELECT/WITH statement with no write keywords anywhere. Checks run with an account token, so be strict. */
export function isReadOnlySql(sql: string): boolean {
  const skel = sqlSkeleton(sql);
  if (skel === null) return false;
  const s = skel.trim().replace(/;\s*$/, "");
  return /^(select|with)\b/i.test(s) && !s.includes(";") && !READ_ONLY_FORBIDDEN.test(s);
}

const STATUS_SPEC = /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/;

const request = {
  method: z.enum(["GET", "HEAD", "POST"]).default("GET"),
  body: z.string().max(10_000).optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(500)).optional().describe("Request headers; don't put secrets here"),
  expect_status: z.string().regex(STATUS_SPEC, 'e.g. "200", "200-299" or "200,301"').optional(),
  follow_redirects: z.boolean().default(false),
  keyword: z.string().min(1).max(200).optional().describe("The body must contain this text"),
  keyword_absent: z.string().min(1).max(200).optional().describe("The body must not contain this text"),
};

export const configSchemas = {
  http: z.object(request),
  json: z.object({
    ...request,
    path: z.string().max(200).optional().describe('Dot path into the JSON, e.g. "data.items" or "results[0].date"; empty = the whole document'),
    expect: z.enum(["non_empty", "exists", "equals", "max_age_minutes"]).default("non_empty"),
    value: z.union([z.string(), z.number(), z.boolean()]).optional().describe("For expect = equals"),
    max_age_minutes: z.number().positive().max(525_600).optional().describe("For expect = max_age_minutes: the value is a date no older than this"),
  }),
  json_nonempty: z.object(request),
  heartbeat: z.object({
    period_min: z.number().int().min(1).max(10_080).describe("How often your job calls the URL"),
    grace_min: z.number().int().min(0).max(1440).default(5),
    token_hash: z.string().optional(),
  }),
  d1_query: z.object({
    database: z.string().min(1).max(64),
    sql: z.string().min(6).max(2000).refine(isReadOnlySql, "must be a single read-only SELECT; :today is replaced by the local date"),
    timezone: z.string().refine(isValidTimeZone, "unknown time zone").default("UTC"),
  }),
  pulse_ingest: z.object({
    max_lag_min: z.number().int().min(5).max(10_080).default(120),
    site_id: z.string().max(64).optional(),
    // Quiet nights aren't outages: only alert when the same hours of the last 7 days usually had events.
    adaptive: z.boolean().default(true),
  }),
  dns: z.object({ name: z.string().min(3).max(253), type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]).default("A"), expect_contains: z.string().max(200).optional() }),
  domain_expiry: z.object({ domain: z.string().min(3).max(253), warn_days: z.number().int().min(1).max(365).default(21) }),
} satisfies Record<MonitorKind, z.ZodTypeAny>;

export function parseConfig<K extends MonitorKind>(kind: K, raw: unknown): z.infer<(typeof configSchemas)[K]> {
  return configSchemas[kind].parse(raw ?? {}) as z.infer<(typeof configSchemas)[K]>;
}

/** Human-readable target for lists, never a secret. */
export function displayTarget(env: Pick<Env, "PUBLIC_ORIGIN">, m: Pick<Monitor, "kind" | "url" | "config_json">): string {
  const cfg = (() => {
    try {
      return JSON.parse(m.config_json || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  switch (m.kind) {
    case "http":
    case "json":
    case "json_nonempty":
      return m.url.startsWith("self:") ? env.PUBLIC_ORIGIN + m.url.slice(5) : m.url;
    case "d1_query":
      return `${String(cfg.database ?? m.url.replace(/^d1:/, ""))} database`;
    case "heartbeat":
      return `heartbeat every ${String(cfg.period_min ?? "?")} min`;
    case "pulse_ingest":
      return cfg.site_id ? `Pulse ingest for ${String(cfg.site_id)}` : "Pulse ingest";
    case "dns":
      return `${String(cfg.type ?? "A")} ${String(cfg.name ?? "")}`;
    case "domain_expiry":
      return `${String(cfg.domain ?? "")} registration`;
  }
}

function expectStatus(spec: string, status: number): boolean {
  return spec.split(",").some((part) => {
    const [a, b] = part.split("-").map((x) => Number(x.trim()));
    return b === undefined ? status === a : status >= a! && status <= b;
  });
}

/** "a.b[0].c" → value, or undefined. */
export function atPath(j: unknown, path: string | undefined): unknown {
  if (!path) return j;
  let cur: unknown = j;
  for (const seg of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Is a JSON payload "non-empty"? Looks for a non-empty array anywhere at the first two levels. */
export function jsonNonEmpty(j: unknown): boolean {
  if (Array.isArray(j)) return j.length > 0;
  if (j && typeof j === "object") {
    for (const v of Object.values(j)) {
      if (Array.isArray(v) && v.length) return true;
      if (v && typeof v === "object") for (const w of Object.values(v)) if (Array.isArray(w) && w.length) return true;
    }
  }
  return false;
}

/** User-Agent of checks, pointing at this install's docs. */
const ua = (env: Pick<Env, "PUBLIC_ORIGIN">) => `PulseMonitor/1.0 (+${env.PUBLIC_ORIGIN}/docs)`;

// Newest live event, every 5 minutes. `MAX(ts) … WHERE source = 'pulse'` scanned the whole events table (no index
// leads with source). Walking events_site_ts (site_id, ts) backwards stops at the first live row, so this costs a
// few index steps per site and no extra index (which every insert would have to write).
export const LAST_LIVE_EVENT_SITE = "SELECT ts AS last FROM events WHERE site_id = ? AND source = 'pulse' ORDER BY ts DESC LIMIT 1";
/** The drill runs on the 1st of each month; older than this means a run was missed or never recorded. */
export const DRILL_OVERDUE_DAYS = 35;

/** Below this many events (the median of the same window on each of the last 7 days), silence is normal. */
export const QUIET_EVENTS = 3;

/**
 * Median count of live events in the window [from, to) shifted back by 1..7 days: what this stretch of the day
 * usually sees. Walks events_site_ts (site_id, ts) per site, one range per day.
 */
export async function usualEventsInWindow(db: D1Database, from: number, to: number, siteId?: string): Promise<number> {
  const span = Math.min(to - from, 86_400_000);
  const days = [1, 2, 3, 4, 5, 6, 7];
  const sites = siteId ? "site_id = ?" : "site_id IN (SELECT id FROM sites)";
  // Scalar subqueries, not UNION ALL: D1 caps compound selects at 5 terms.
  const sql = "SELECT " + days.map((d) => `(SELECT COUNT(*) FROM events WHERE ${sites} AND source = 'pulse' AND ts >= ? AND ts < ?) AS d${d}`).join(", ");
  const params = days.flatMap((d) => [...(siteId ? [siteId] : []), to - span - d * 86_400_000, to - d * 86_400_000]);
  const row = await db.prepare(sql).bind(...params).first<Record<string, number>>();
  const counts = days.map((d) => Number(row?.[`d${d}`] ?? 0)).sort((a, b) => a - b);
  return counts[Math.floor(counts.length / 2)] ?? 0;
}

export const LAST_LIVE_EVENT = "SELECT MAX((SELECT e.ts FROM events e WHERE e.site_id = s.id AND e.source = 'pulse' ORDER BY e.ts DESC LIMIT 1)) AS last FROM sites s";

async function checkHttp(env: Env, m: Monitor, fetcher: typeof fetch): Promise<CheckResult> {
  const kind = m.kind as "http" | "json" | "json_nonempty";
  const cfg = parseConfig(kind, JSON.parse(m.config_json || "{}"));
  const url = m.url.startsWith("self:") ? env.PUBLIC_ORIGIN + m.url.slice(5) : m.url;
  const t0 = Date.now();
  const res = await fetcher(url, {
    method: cfg.method,
    body: cfg.method === "POST" ? (cfg.body ?? "") : undefined,
    headers: { "User-Agent": ua(env), ...(cfg.headers ?? {}) },
    redirect: cfg.follow_redirects ? "follow" : "manual",
    signal: AbortSignal.timeout(m.timeout_ms || 10_000),
  });
  const ms = Date.now() - t0;
  if (!expectStatus(cfg.expect_status ?? String(m.expect_status || 200), res.status)) {
    await res.body?.cancel();
    return { ok: false, status: res.status, ms, error: `HTTP ${res.status}` };
  }
  const needBody = kind !== "http" || cfg.keyword || cfg.keyword_absent;
  if (!needBody) {
    await res.body?.cancel();
    return { ok: true, status: res.status, ms, error: null };
  }
  const text = (await res.text()).slice(0, 2_000_000);
  if (cfg.keyword && !text.includes(cfg.keyword)) return { ok: false, status: res.status, ms, error: `"${cfg.keyword.slice(0, 40)}" not found` };
  if (cfg.keyword_absent && text.includes(cfg.keyword_absent)) return { ok: false, status: res.status, ms, error: `"${cfg.keyword_absent.slice(0, 40)}" found` };
  if (kind === "http") return { ok: true, status: res.status, ms, error: null };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, ms, error: "not JSON" };
  }
  if (kind === "json_nonempty") return jsonNonEmpty(j) ? { ok: true, status: res.status, ms, error: null } : { ok: false, status: res.status, ms, error: "empty response" };
  const jc = cfg as z.infer<typeof configSchemas.json>;
  const v = atPath(j, jc.path);
  const where = jc.path ? `"${jc.path}"` : "the response";
  switch (jc.expect) {
    case "exists":
      return v !== undefined && v !== null ? { ok: true, status: res.status, ms, error: null } : { ok: false, status: res.status, ms, error: `${where} is missing` };
    case "equals":
      return v === jc.value || String(v) === String(jc.value) ? { ok: true, status: res.status, ms, error: null } : { ok: false, status: res.status, ms, error: `${where} is ${JSON.stringify(v)?.slice(0, 60)}` };
    case "max_age_minutes": {
      const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
      if (!Number.isFinite(t)) return { ok: false, status: res.status, ms, error: `${where} is not a date` };
      const age = (Date.now() - t) / 60_000;
      return age <= (jc.max_age_minutes ?? 60) ? { ok: true, status: res.status, ms, error: null } : { ok: false, status: res.status, ms, error: `${where} is ${Math.round(age)} min old` };
    }
    default: {
      const nonEmpty = Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? (jc.path ? Object.keys(v).length > 0 : jsonNonEmpty(v)) : v !== undefined && v !== null && v !== "";
      return nonEmpty ? { ok: true, status: res.status, ms, error: null } : { ok: false, status: res.status, ms, error: `${where} is empty` };
    }
  }
}

export async function runCheck(env: Env, m: Monitor, now = Date.now(), fetcher: typeof fetch = fetch): Promise<CheckResult> {
  try {
    const raw = JSON.parse(m.config_json || "{}") as unknown;
    switch (m.kind) {
      case "http":
      case "json":
      case "json_nonempty":
        return await checkHttp(env, m, fetcher);
      case "heartbeat": {
        const cfg = parseConfig("heartbeat", raw);
        const limit = (cfg.period_min + cfg.grace_min) * 60_000;
        const since = m.last_ping_at ?? m.created_at;
        const ageMin = Math.round((now - since) / 60_000);
        if (now - since <= limit) return { ok: true, status: null, ms: null, error: m.last_ping_at ? null : "waiting for the first ping" };
        return { ok: false, status: null, ms: null, error: m.last_ping_at ? `no ping for ${ageMin} min` : "never pinged" };
      }
      case "d1_query": {
        const cfg = parseConfig("d1_query", raw);
        const dbs = await listD1(env);
        const db = dbs.find((d) => d.name === cfg.database);
        if (!db) return { ok: false, status: null, ms: null, error: `database ${cfg.database} not found` };
        const today = localParts(now, cfg.timezone).day;
        const params: string[] = [];
        const sql = cfg.sql.trim().replace(/;\s*$/, "").replace(/:today\b/g, () => (params.push(today), "?"));
        const t0 = Date.now();
        const [row] = await d1Query<Record<string, unknown>>(env, db.uuid, sql, params);
        const ms = Date.now() - t0;
        const ok = row ? ("ok" in row ? row.ok : Object.values(row)[0]) : null;
        if (ok && ok !== "0") return { ok: true, status: null, ms, error: null };
        return { ok: false, status: null, ms, error: row && "detail" in row ? `query returned false (detail: ${String(row.detail).slice(0, 80)})` : "query returned false" };
      }
      case "pulse_ingest": {
        const cfg = parseConfig("pulse_ingest", raw);
        const r = await env.DB.prepare(cfg.site_id ? LAST_LIVE_EVENT_SITE : LAST_LIVE_EVENT).bind(...(cfg.site_id ? [cfg.site_id] : [])).first<{ last: number | null }>();
        if (!r?.last) return { ok: true, status: null, ms: null, error: null };
        const lagMin = (now - r.last) / 60_000;
        if (lagMin <= cfg.max_lag_min) return { ok: true, status: null, ms: null, error: null };
        if (cfg.adaptive) {
          const usual = await usualEventsInWindow(env.DB, r.last, now, cfg.site_id);
          if (usual < QUIET_EVENTS) return { ok: true, status: null, ms: null, error: null };
          return { ok: false, status: null, ms: null, error: `no events for ${Math.round(lagMin)} min (usually ${usual} at this time)` };
        }
        return { ok: false, status: null, ms: null, error: `no events for ${Math.round(lagMin)} min` };
      }
      case "dns": {
        const cfg = parseConfig("dns", raw);
        const t0 = Date.now();
        const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(cfg.name)}&type=${cfg.type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(m.timeout_ms || 10_000) });
        const j = (await res.json()) as { Status?: number; Answer?: { data: string }[] };
        const ms = Date.now() - t0;
        const answers = (j.Answer ?? []).map((a) => a.data);
        if (j.Status !== 0 || !answers.length) return { ok: false, status: null, ms, error: `no ${cfg.type} record` };
        if (cfg.expect_contains && !answers.some((a) => a.toLowerCase().includes(cfg.expect_contains!.toLowerCase()))) return { ok: false, status: null, ms, error: `got ${answers.join(", ").slice(0, 120)}` };
        return { ok: true, status: null, ms, error: null };
      }
      case "domain_expiry": {
        const cfg = parseConfig("domain_expiry", raw);
        const res = await fetcher(`https://rdap.org/domain/${encodeURIComponent(cfg.domain)}`, { redirect: "follow", signal: AbortSignal.timeout(m.timeout_ms || 10_000), headers: { accept: "application/rdap+json", "User-Agent": ua(env) } });
        if (!res.ok) return { ok: true, status: res.status, ms: null, error: "the registry doesn't publish RDAP data for this domain" };
        const j = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
        const exp = j.events?.find((e) => e.eventAction === "expiration")?.eventDate;
        if (!exp) return { ok: true, status: null, ms: null, error: "no expiry date published" };
        const days = Math.floor((Date.parse(exp) - now) / 86_400_000);
        return days > cfg.warn_days ? { ok: true, status: null, ms: null, error: null } : { ok: false, status: null, ms: null, error: `expires in ${days} days (${exp.slice(0, 10)})` };
      }
      default:
        return { ok: false, status: null, ms: null, error: "unknown check kind" };
    }
  } catch (err) {
    const msg = err instanceof z.ZodError ? `invalid config: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` : String((err as Error).message ?? err);
    return { ok: false, status: null, ms: null, error: msg.slice(0, 200) };
  }
}

/** Is a check due on this run of the every-5-minutes cron? */
export function isDue(m: Pick<Monitor, "interval_min" | "paused_until">, now: number): boolean {
  if (m.paused_until && m.paused_until > now) return false;
  const every = Math.max(1, Math.round((m.interval_min || 5) / 5));
  return Math.floor(now / 300_000) % every === 0;
}

/** Store one check result and count it in its status board cell (monitor_days). */
function checkStmts(env: Env, m: Monitor, r: CheckResult, now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare("INSERT OR REPLACE INTO checks (monitor_id, ts, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)").bind(m.id, now, r.ok ? 1 : 0, r.status, r.ms, r.error),
    env.DB.prepare(
      "INSERT INTO monitor_days (monitor_id, day, checks, up) VALUES (?, ?, 1, ?) ON CONFLICT (monitor_id, day) DO UPDATE SET checks = checks + 1, up = up + excluded.up",
    ).bind(m.id, Math.floor(now / 86_400_000), r.ok ? 1 : 0),
  ];
}

export async function recordCheck(env: Env, m: Monitor, r: CheckResult, now: number): Promise<void> {
  await env.DB.batch(checkStmts(env, m, r, now));
}

function channelsOf(m: Monitor): string[] | null {
  try {
    return m.channel_ids_json ? (JSON.parse(m.channel_ids_json) as string[]) : null;
  } catch {
    return null;
  }
}

/** Is `now` inside the check's quiet hours ({from, to, tz} in local HH:MM; a window may cross midnight)? */
export function inQuietHours(m: Pick<Monitor, "config_json">, now: number): boolean {
  let q: { from?: string; to?: string; tz?: string } | undefined;
  try {
    q = (JSON.parse(m.config_json || "{}") as { quiet_hours?: typeof q }).quiet_hours;
  } catch {
    return false;
  }
  if (!q?.from || !q.to) return false;
  let p: { hour: number; minute: number };
  try {
    p = localParts(now, q.tz || "UTC");
  } catch {
    return false;
  }
  const at = p.hour * 60 + p.minute;
  const [fh, fm] = q.from.split(":").map(Number) as [number, number];
  const [th, tm] = q.to.split(":").map(Number) as [number, number];
  const a = fh * 60 + fm;
  const b = th * 60 + tm;
  return a <= b ? at >= a && at < b : at >= a || at < b;
}

/** Open or resolve incidents after a recorded check; notify the check's channels on state changes only. */
export async function updateIncident(env: Env, m: Monitor, r: CheckResult, now: number): Promise<void> {
  const open = await env.DB.prepare("SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL").bind(m.id).first<{ id: string; notified_open: number; started_at: number }>();
  const target = displayTarget(env, m);
  const need = Math.max(1, m.failures_to_alert || 2);
  const sendDown = async (id: string) => {
    const sent = await notify(
      env,
      { title: `Down: ${m.name}`, text: `${m.name} failed ${need} time(s) in a row.\nCheck: ${target}\nError: ${r.error}\nTime: ${new Date(now).toISOString()}`, url: `${env.PUBLIC_ORIGIN}/status`, severity: "down", data: { check: m.id, error: r.error } },
      channelsOf(m),
    ).catch((e) => {
      console.error(JSON.stringify({ msg: "alert_send_failed", error: String(e).slice(0, 200) }));
      return 0;
    });
    if (sent) await env.DB.prepare("UPDATE incidents SET notified_open = 1 WHERE id = ?").bind(id).run();
  };
  // The Down message reached nobody when the incident opened (a channel briefly unreachable): retry it while the
  // check keeps failing, so the outage and then its recovery are both heard about.
  if (!r.ok && open && !open.notified_open && m.notify && !inQuietHours(m, now)) return sendDown(open.id);
  if (!r.ok && !open) {
    // Inside the check's quiet hours a failure is recorded (it shows on the board) but opens nothing.
    if (inQuietHours(m, now)) return;
    const { results: last } = await env.DB.prepare("SELECT ok FROM checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT ?").bind(m.id, need).all<{ ok: number }>();
    if (last.length === need && last.every((x) => !x.ok)) {
      const id = ulid();
      await env.DB.prepare("INSERT INTO incidents (id, monitor_id, started_at, error) VALUES (?, ?, ?, ?)").bind(id, m.id, now, r.error).run();
      // A check that belongs to a site marks the outage on that site's charts.
      if (m.site_id)
        await env.DB.prepare("INSERT OR IGNORE INTO annotations (id, site_id, ts, title, body, url, category, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'incident', 'status', ?)")
          .bind(`inc-${id}`, m.site_id, now, `${m.name} down`, r.error ? String(r.error).slice(0, 300) : null, `${env.PUBLIC_ORIGIN}/status`, now)
          .run();
      if (!m.notify) return;
      await sendDown(id);
    }
  } else if (r.ok && open) {
    await env.DB.prepare("UPDATE incidents SET resolved_at = ? WHERE id = ?").bind(now, open.id).run();
    await env.DB.prepare("UPDATE annotations SET body = COALESCE(body || '. ', '') || ? WHERE id = ?").bind(`Back up after ${Math.max(1, Math.round((now - open.started_at) / 60_000))} min`, `inc-${open.id}`).run();
    if (!m.notify || !open.notified_open) return;
    const sent = await notify(env, { title: `Recovered: ${m.name}`, text: `${m.name} is back up.\nCheck: ${target}\nTime: ${new Date(now).toISOString()}`, url: `${env.PUBLIC_ORIGIN}/status`, severity: "up", data: { check: m.id } }, channelsOf(m)).catch(() => 0);
    if (sent) await env.DB.prepare("UPDATE incidents SET notified_resolved = 1 WHERE id = ?").bind(open.id).run();
  }
}

export async function runMonitors(env: Env, now = Date.now()): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM monitors WHERE enabled = 1").all<Monitor>();
  const due = results.filter((m) => isDue(m, now));
  const checked = await Promise.all(due.map(async (m) => ({ m, r: await runCheck(env, m, now) })));
  if (checked.length) {
    await env.DB.batch(checked.flatMap(({ m, r }) => checkStmts(env, m, r, now)));
  }
  for (const { m, r } of checked) await updateIncident(env, m, r, now);
}

/** Daily (03:00 cron): drop check results older than the 90 days the status page shows. */
export async function pruneChecks(env: Env, now = Date.now()): Promise<number> {
  const [r] = await env.DB.batch([
    env.DB.prepare("DELETE FROM checks WHERE ts < ?").bind(now - 90 * 86_400_000),
    env.DB.prepare("DELETE FROM monitor_days WHERE day < ?").bind(Math.floor(now / 86_400_000) - 90),
  ]);
  return r!.meta.changes ?? 0;
}

/** A heartbeat ping: `GET|POST /hb/<token>`. Returns true when the token belongs to a check. */
export async function recordPing(env: Env, token: string, now = Date.now()): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return false;
  const hash = await sha256Hex(token);
  const res = await env.DB.prepare("UPDATE monitors SET last_ping_at = ? WHERE kind = 'heartbeat' AND json_extract(config_json, '$.token_hash') = ?").bind(now, hash).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Record every D1 database size daily; warn by email at the configured size. */
export async function recordDbSizes(env: Env, now = Date.now(), warnBytes?: number): Promise<{ name: string; bytes: number }[]> {
  const limit = warnBytes ?? (await getOpsSettings(env.DB)).d1_warn_gb * 1024 ** 3;
  const day = new Date(now).toISOString().slice(0, 10);
  const dbs = await listD1(env);
  const rows = dbs.map((d) => ({ name: d.name, bytes: d.file_size ?? 0 }));
  await env.DB.batch(rows.map((r) => env.DB.prepare("INSERT OR REPLACE INTO ops_metrics (day, name, value) VALUES (?, ?, ?)").bind(day, `d1:${r.name}`, r.bytes)));
  const big = rows.filter((r) => r.bytes >= limit);
  if (big.length) {
    const flag = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'd1_size_warned'").first<{ value: string }>();
    if (flag?.value !== day) {
      await sendMail(env, `⚠️ D1 database size warning`, big.map((b) => `${b.name}: ${(b.bytes / 1024 ** 3).toFixed(2)} GB (hard cap 10 GB)`).join("\n"), undefined, "notice");
      await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value, updated_at) VALUES ('d1_size_warned', ?, ?)").bind(day, now).run();
    }
  }
  return rows;
}

export type MonitorStatus = "up" | "down" | "degraded" | "paused" | "unknown";

export async function statusReport(env: Env, now = Date.now()) {
  const { results: monitors } = await env.DB.prepare("SELECT * FROM monitors WHERE enabled = 1 ORDER BY sort, name").all<Monitor>();
  const since90 = now - 90 * 86_400_000;
  const today = Math.floor(now / 86_400_000);
  // Daily cells come from monitor_days (kept as checks are recorded), not from 90 days of raw checks.
  const { results: daily } = await env.DB.prepare("SELECT monitor_id, day AS d, checks AS n, up FROM monitor_days WHERE day > ?")
    .bind(today - 90)
    .all<{ monitor_id: string; d: number; n: number; up: number }>();
  const { results: openIncidents } = await env.DB.prepare("SELECT monitor_id, started_at FROM incidents WHERE resolved_at IS NULL").all<{ monitor_id: string; started_at: number }>();
  const out = await Promise.all(
    monitors.map(async (m) => {
      const mine = daily.filter((x) => x.monitor_id === m.id);
      // 7 d and 30 d: whole UTC days, today included (the cells on the board); 24 h stays a rolling window.
      const lastDays = (n: number) => mine.filter((x) => x.d > today - n).reduce((a, x) => ({ n: a.n + x.n, up: a.up + x.up }), { n: 0, up: 0 });
      const [d1, last, med] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n, SUM(ok) AS up FROM checks WHERE monitor_id = ? AND ts >= ?").bind(m.id, now - 86_400_000).first<{ n: number; up: number | null }>(),
        env.DB.prepare("SELECT ts, ok, ms, error FROM checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT 1").bind(m.id).first<{ ts: number; ok: number; ms: number | null; error: string | null }>(),
        env.DB.prepare("SELECT ms FROM checks WHERE monitor_id = ? AND ts >= ? AND ms IS NOT NULL ORDER BY ms LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM checks WHERE monitor_id = ? AND ts >= ? AND ms IS NOT NULL)")
          .bind(m.id, now - 86_400_000, m.id, now - 86_400_000)
          .first<{ ms: number }>(),
      ]);
      const d7 = lastDays(7);
      const d30 = lastDays(30);
      const d90 = mine.reduce((a, x) => ({ n: a.n + x.n, up: a.up + x.up }), { n: 0, up: 0 });
      const pct = (s: { n: number; up: number | null } | null) => (s && s.n ? (100 * (s.up ?? 0)) / s.n : null);
      const paused = !!m.paused_until && m.paused_until > now;
      const incident = openIncidents.find((i) => i.monitor_id === m.id);
      const status: MonitorStatus = paused ? "paused" : !last ? "unknown" : !last.ok ? "down" : m.degraded_ms && last.ms !== null && last.ms > m.degraded_ms ? "degraded" : "up";
      const days = Array.from({ length: 90 }, (_, i) => {
        const d = today - 89 + i;
        const x = mine.find((y) => y.d === d);
        return { day: new Date(d * 86_400_000).toISOString().slice(0, 10), checks: x?.n ?? 0, up: x?.up ?? 0 };
      });
      return {
        id: m.id,
        name: m.name,
        kind: m.kind,
        site_id: m.site_id,
        url: displayTarget(env, m),
        status,
        incident_since: incident ? new Date(incident.started_at).toISOString() : null,
        uptime_24h: pct(d1),
        uptime_7d: pct(d7),
        uptime_30d: pct(d30),
        uptime_90d: pct(d90),
        p50_ms: m.kind === "pulse_ingest" || m.kind === "heartbeat" ? null : (med?.ms ?? null),
        last_checked_at: last ? new Date(last.ts).toISOString() : null,
        last_error: last && !last.ok ? last.error : null,
        interval_min: m.interval_min,
        paused_until: paused ? new Date(m.paused_until!).toISOString() : null,
        days,
      };
    }),
  );
  const { results: incidents } = await env.DB.prepare(
    "SELECT i.id, i.monitor_id, m.name AS monitor_name, m.site_id, i.started_at, i.resolved_at, i.error, i.note, i.acknowledged_at, i.acknowledged_by FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE i.started_at > ? ORDER BY i.started_at DESC LIMIT 50",
  )
    .bind(since90)
    .all<{ id: string; monitor_id: string; monitor_name: string; site_id: string | null; started_at: number; resolved_at: number | null; error: string | null; note: string | null; acknowledged_at: number | null; acknowledged_by: string | null }>();
  const { results: sizes } = await env.DB.prepare("SELECT name, day, value FROM ops_metrics WHERE name LIKE 'd1:%' AND day >= ? ORDER BY day")
    .bind(new Date(now - 8 * 86_400_000).toISOString().slice(0, 10))
    .all<{ name: string; day: string; value: number }>();
  const byDb = new Map<string, { day: string; value: number }[]>();
  for (const s of sizes) byDb.set(s.name, [...(byDb.get(s.name) ?? []), s]);
  const databases = [...byDb].map(([name, pts]) => {
    const last = pts[pts.length - 1]!;
    const first = pts[0]!;
    const days = (Date.parse(last.day) - Date.parse(first.day)) / 86_400_000;
    return { name: name.slice(3), size_mb: last.value / 1048576, growth_mb_per_week: days >= 1 ? ((last.value - first.value) / 1048576) * (7 / days) : null };
  });
  const meta = async (k: string) => (await env.DB.prepare("SELECT value FROM kv_meta WHERE key = ?").bind(k).first<{ value: string }>())?.value ?? null;
  const ops = await meta("last_ops_backup");
  const drill = await meta("last_restore_drill");
  const opsB = ops ? (JSON.parse(ops) as { at: number; ok: boolean; errors?: string[]; missing?: string[] }) : null;
  const drillR = drill ? (JSON.parse(drill) as { at: number; ok: boolean; error?: string; report?: Record<string, { ok: boolean; mismatches: string[]; skipped?: string }> }) : null;
  const drillProblems = drillR
    ? [...(drillR.error ? [drillR.error] : []), ...Object.entries(drillR.report ?? {}).flatMap(([db, r]) => (r.ok ? [] : r.mismatches.slice(0, 3).map((m) => `${db}: ${m}`)))]
    : [];
  const drillSkipped = Object.entries(drillR?.report ?? {}).flatMap(([db, r]) => (r.skipped ? [`${db}: ${r.skipped}`] : []));
  const down = out.filter((m) => m.status === "down");
  return {
    summary: !out.length ? "No checks yet." : down.length ? `${down.length} of ${out.length} checks down: ${down.map((m) => m.name).join(", ")}.` : `All ${out.length} checks up.`,
    monitors: out,
    incidents: incidents.map((i) => ({
      ...i,
      started_at: new Date(i.started_at).toISOString(),
      resolved_at: i.resolved_at ? new Date(i.resolved_at).toISOString() : null,
      acknowledged_at: i.acknowledged_at ? new Date(i.acknowledged_at).toISOString() : null,
    })),
    databases,
    backups: {
      last: opsB ? new Date(opsB.at).toISOString() : null,
      ok: opsB?.ok ?? null,
      errors: opsB?.errors ?? [],
      // Chosen in Settings → Backups but no longer in the Cloudflare account: remove them there.
      missing: opsB?.missing ?? [],
      drill: drillR
        ? { at: new Date(drillR.at).toISOString(), ok: drillR.ok, problems: drillProblems, skipped: drillSkipped, overdue: now - drillR.at > DRILL_OVERDUE_DAYS * 86_400_000 }
        : null,
    },
  };
}

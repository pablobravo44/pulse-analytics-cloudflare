// Daily rollups inside the query engine (rule 7: the numbers come from here, the same as the raw SQL in build.ts).
//
// stat_days holds, per site × dimension × local day × value, the additive parts of every metric the engine computes
// per (value, session) group: active sessions, distinct active visitors, pageviews, events, engaged ms, scroll sums,
// bounces, durations, entries, exits and revenue. A session or a visitor active on two consecutive days would be counted
// on both, so each row also stores the part that continues from the day before (c_*). Over a run of consecutive days
//   total = Σ day − Σ continuation (for every day but the first)
// which is exactly what the raw engine counts, as long as a session's or a visitor's active days are consecutive: true
// for sessions (they end after 30 idle minutes) and for visitor ids (they rotate every day). Goal conversions are stored
// the same way under dim 'goal', one value per goal definition. test/unit/rollup.test.ts checks rollup = raw.
//
// Closed days (built_through) are final. Today, and yesterday until it closes 90 minutes after midnight, are rebuilt by
// the 5-minute cron (refreshRollups); a read uses them while fresh and computes any newer day from raw events in the same
// statement. Filters, inline goals, rolling windows (24h, last_minutes) and UTC days read raw events (build.ts).
import { addDays, localParts, startOfLocalDay } from "../lib/time.ts";
import type { Site } from "../lib/sites.ts";
import { dimAlias, dimExpr, goalPredicate, TIME_DIMS, type AggregateSpec, type BuildContext, type Sql } from "./build.ts";
import { VITAL_METRICS, type GoalMatch, type Metric } from "./schema.ts";

/** Bump when the builder changes: every site is rebuilt from its first day. */
export const ROLLUP_VERSION = 2; // 2: scroll depth per pageview
/** Non-time dimensions kept in stat_days ('' = whole site, 'hour' = per local hour, 'goal' = conversions). */
export const ROLLUP_DIMS = [
  "page", "entry_page", "exit_page", "hostname", "referrer_host", "channel", "source_name", "utm_source", "utm_medium", "utm_campaign",
  "country", "region", "city", "device", "browser", "os", "language", "event_name", "outbound_url",
] as const;
const STORED = ["", "hour", ...ROLLUP_DIMS];
/** A day closes this long after its local midnight (sessions have ended by then). */
const CLOSE_AFTER_MS = 90 * 60_000;
/** Open-day rows older than this aren't trusted: the read computes those days from raw events. */
const OPEN_FRESH_MS = 15 * 60_000;
/** Closed days built per site per cron run while catching up (backfill). */
const BACKFILL_DAYS = 14;
const NULL_VALUE = "char(1)";

const SUMS = ["sessions", "visitors", "pv", "ce", "eng", "sc_sum", "sc_n", "bounces", "dur", "ent", "ext", "rev", "rev_n"] as const;
const CONT: Record<string, string> = { sessions: "c_sessions", visitors: "c_visitors", bounces: "c_bounces", dur: "c_dur", ent: "c_ent", ext: "c_ext", rev_n: "c_rev_n" };
const COLS = [...SUMS, ...Object.values(CONT)];

/** Metrics a rollup can answer; conversions need a stored goal, vitals are percentiles and stay raw. */
const OUTER: Partial<Record<Metric, string>> = {
  visitors: "vis",
  sessions: "ses",
  pageviews: "pv",
  views_per_session: "ROUND(CAST(pv AS REAL) / NULLIF(ses, 0), 2)",
  bounce_rate: "ROUND(100.0 * bounces / NULLIF(ses, 0), 1)",
  avg_session_duration: "ROUND(CAST(dur AS REAL) / NULLIF(ses, 0) / 1000.0, 1)",
  avg_engaged_time: "ROUND(eng / 1000.0 / NULLIF(pv, 0), 1)",
  events: "ce",
  conversions: "conv",
  conversion_rate: "ROUND(100.0 * conv / NULLIF(ses, 0), 2)",
  entries: "ent",
  exits: "ext",
  exit_rate: "ROUND(100.0 * ext / NULLIF(pv, 0), 1)",
  scroll_depth: "ROUND(CAST(sc_sum AS REAL) / NULLIF(sc_n, 0), 0)",
  revenue: "ROUND(rev, 2)",
  average_revenue: "ROUND(rev / NULLIF(rev_n, 0), 2)",
  revenue_per_visitor: "ROUND(rev / NULLIF(vis, 0), 2)",
};

export interface RollupState {
  version: number;
  built_through: string;
  open_to: string | null;
  open_built_at: number | null;
  /** JSON {goal id: goalKey} of the goals stored under dim 'goal'. */
  goals_sig: string | null;
  goals_through: string | null;
}

export interface StoredGoal {
  id: string;
  match: GoalMatch;
}

/** Stored value of a goal: its id plus a hash of its definition, so an edited goal never reads old rows. */
export function goalKey(id: string, g: GoalMatch): string {
  const canon = JSON.stringify([g.kind, g.path ?? null, g.event ?? null, g.prop ? [g.prop.key, g.prop.value] : null, g.host ?? null]);
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) h = Math.imul(h ^ canon.charCodeAt(i), 0x01000193) >>> 0;
  return `${id}#${h.toString(36)}`;
}

function goalsSig(goals: StoredGoal[]): string {
  return JSON.stringify(Object.fromEntries([...goals].sort((a, b) => a.id.localeCompare(b.id)).map((g) => [g.id, goalKey(g.id, g.match)])));
}

// ---------- builder ----------

/**
 * Events of the days the rows are built for, plus the day before for continuations: with `prev: "all"` every event of
 * it (closed days, exact); with "sessions" only the events of sessions still alive at `from` and of visitors active from
 * `from` on (open days, cheap).
 */
function source(siteId: string, timeZone: string, from: string, to: string, prev: "all" | "sessions", until?: number): Sql {
  const before = addDays(from, -1);
  const cut = until !== undefined ? { sql: " AND ts < ?", params: [until] } : { sql: "", params: [] };
  if (prev === "all") return { sql: `SELECT * FROM events WHERE site_id = ? AND local_day BETWEEN ? AND ?${cut.sql}`, params: [siteId, before, to, ...cut.params] };
  const start = startOfLocalDay(from, timeZone);
  return {
    sql: `SELECT * FROM events WHERE site_id = ? AND local_day BETWEEN ? AND ?${cut.sql}
      UNION ALL SELECT * FROM events WHERE site_id = ? AND local_day = ? AND session_id IN (
        SELECT id FROM sessions WHERE site_id = ? AND local_day BETWEEN ? AND ? AND (last_seen_at >= ? OR visitor_id IN (
          SELECT visitor_id FROM sessions WHERE site_id = ? AND local_day BETWEEN ? AND ?)))`,
    params: [siteId, from, to, ...cut.params, siteId, before, siteId, addDays(before, -1), before, start - 60_000, siteId, from, to],
  };
}

/** Per-day rows of one stored dimension for local days [from, to], from raw events. */
export function buildDays(siteId: string, timeZone: string, dim: string, from: string, to: string, prev: "all" | "sessions", until?: number): Sql {
  const d = dim === "" ? { expr: "''", params: [] as unknown[], rowType: null as string | null } : dimExpr(dim, "site");
  const src = source(siteId, timeZone, from, to, prev, until);
  const params: unknown[] = [...src.params, ...d.params];
  if (d.rowType) params.push(d.rowType);
  // Scroll depth: the deepest scroll of each pageview that day (as in build.ts), from the same events.
  const sql = `WITH src AS (${src.sql}),
    sp AS (SELECT pageview_id AS pid, local_day AS pday, MAX(scroll_pct) AS m FROM src WHERE type = 'engagement' AND scroll_pct IS NOT NULL AND pageview_id IS NOT NULL GROUP BY 1, 2),
    g AS (
      SELECT e.local_day AS day, ${d.expr} AS v, e.session_id AS sid, MAX(e.visitor_id) AS vid,
        SUM(e.type = 'pageview') AS pv, SUM(e.type = 'event') AS ce, SUM(e.type IN ('outbound', 'download')) AS ox,
        SUM(COALESCE(e.engaged_ms, 0)) AS eng, COALESCE(SUM(sp.m), 0) AS sc_sum, COUNT(sp.m) AS sc_n,
        MAX(COALESCE(s.bounced, 0)) AS b, MAX(COALESCE(s.duration_ms, 0)) AS dur,
        MAX(e.type = 'pageview' AND e.pathname = s.entry_path) AS ent, MAX(e.type = 'pageview' AND e.pathname = s.exit_path) AS ext,
        SUM(CASE WHEN e.type = 'event' THEN COALESCE(CAST(json_extract(e.props_json, '$.revenue') AS REAL), 0) ELSE 0 END) AS rev
      FROM src e LEFT JOIN sessions s ON s.id = e.session_id
        LEFT JOIN sp ON e.type = 'pageview' AND sp.pid = e.pageview_id AND sp.pday = e.local_day
      ${d.rowType ? "WHERE e.type = ?" : ""}
      GROUP BY 1, 2, 3
    ), a AS (SELECT *, (pv + ce + ox) > 0 AS act FROM g),
    av AS (SELECT DISTINCT day, v, vid FROM a WHERE act)
    SELECT c.day AS day, COALESCE(c.v, ${NULL_VALUE}) AS value,
      SUM(c.act) AS sessions, COUNT(DISTINCT CASE WHEN c.act THEN c.vid END) AS visitors,
      SUM(c.pv) AS pv, SUM(c.ce) AS ce, SUM(c.eng) AS eng, SUM(c.sc_sum) AS sc_sum, SUM(c.sc_n) AS sc_n,
      SUM(CASE WHEN c.act THEN c.b ELSE 0 END) AS bounces, SUM(CASE WHEN c.act THEN c.dur ELSE 0 END) AS dur,
      SUM(c.ent) AS ent, SUM(c.ext) AS ext, SUM(c.rev) AS rev, SUM(c.rev > 0) AS rev_n,
      SUM(CASE WHEN c.act AND p.act THEN 1 ELSE 0 END) AS c_sessions,
      COUNT(DISTINCT CASE WHEN c.act AND pv0.vid IS NOT NULL THEN c.vid END) AS c_visitors,
      SUM(CASE WHEN c.act AND p.act THEN c.b ELSE 0 END) AS c_bounces,
      SUM(CASE WHEN c.act AND p.act THEN c.dur ELSE 0 END) AS c_dur,
      SUM(COALESCE(c.ent AND p.ent, 0)) AS c_ent, SUM(COALESCE(c.ext AND p.ext, 0)) AS c_ext,
      SUM(COALESCE(c.rev > 0 AND p.rev > 0, 0)) AS c_rev_n
    FROM a c
    LEFT JOIN a p ON p.sid = c.sid AND p.v IS c.v AND p.day = date(c.day, '-1 day')
    LEFT JOIN av pv0 ON pv0.vid = c.vid AND pv0.v IS c.v AND pv0.day = date(c.day, '-1 day')
    WHERE c.day BETWEEN ? AND ?
    GROUP BY c.day, c.v`;
  params.push(from, to);
  return { sql, params };
}

/**
 * Per-day conversions of one goal in the stat_days column layout: `sessions` = active sessions that converted that day,
 * `c_sessions` = those that also converted the day before (the raw engine counts a converting session once).
 */
export function buildGoalDays(siteId: string, timeZone: string, key: string, goal: GoalMatch, from: string, to: string, prev: "all" | "sessions", until?: number): Sql {
  const src = source(siteId, timeZone, from, to, prev, until);
  const gp = goalPredicate(goal);
  const zeros = COLS.filter((c) => c !== "sessions" && c !== "c_sessions").map((c) => `0 AS ${c}`).join(", ");
  const sql = `WITH a AS (
      SELECT e.local_day AS day, e.session_id AS sid, SUM(e.type IN ('pageview', 'event', 'outbound', 'download')) > 0 AS act, MAX(${gp.sql}) AS conv
      FROM (${src.sql}) e GROUP BY 1, 2
    )
    SELECT c.day AS day, ? AS value, SUM(c.act AND c.conv) AS sessions, SUM(COALESCE(c.act AND c.conv AND p.act AND p.conv, 0)) AS c_sessions, ${zeros}
    FROM a c LEFT JOIN a p ON p.sid = c.sid AND p.day = date(c.day, '-1 day')
    WHERE c.day BETWEEN ? AND ?
    GROUP BY c.day HAVING SUM(c.act AND c.conv) > 0`;
  return { sql, params: [...gp.params, ...src.params, key, from, to] };
}

const insertRows = (db: D1Database, siteId: string, dim: string, b: Sql) =>
  db.prepare(`INSERT INTO stat_days (site_id, dim, day, value, ${COLS.join(", ")}) SELECT ?, ?, day, value, ${COLS.join(", ")} FROM (${b.sql})`).bind(siteId, dim, ...b.params);

/** Statements that (re)write stored rows of every dimension (and, with `goals`, every goal) for [from, to]. */
function writeStmts(db: D1Database, site: Site, from: string, to: string, prev: "all" | "sessions", goals: StoredGoal[] | null): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [db.prepare(`DELETE FROM stat_days WHERE site_id = ? AND day BETWEEN ? AND ?${goals ? "" : " AND dim <> 'goal'"}`).bind(site.id, from, to)];
  for (const dim of STORED) out.push(insertRows(db, site.id, dim, buildDays(site.id, site.timezone, dim, from, to, prev)));
  for (const g of goals ?? []) out.push(insertRows(db, site.id, "goal", buildGoalDays(site.id, site.timezone, goalKey(g.id, g.match), g.match, from, to, prev)));
  return out;
}

function goalWriteStmts(db: D1Database, site: Site, from: string, to: string, goals: StoredGoal[]): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM stat_days WHERE site_id = ? AND dim = 'goal' AND day BETWEEN ? AND ?").bind(site.id, from, to),
    ...goals.map((g) => insertRows(db, site.id, "goal", buildGoalDays(site.id, site.timezone, goalKey(g.id, g.match), g.match, from, to, "all"))),
  ];
}

// ---------- state ----------

let stateCache = new WeakMap<D1Database, Map<string, { at: number; state: RollupState | null }>>();
const cacheFor = (db: D1Database) => {
  let m = stateCache.get(db);
  if (!m) stateCache.set(db, (m = new Map()));
  return m;
};
const STATE_TTL_MS = 30_000;
const STATE_SQL = "SELECT version, built_through, open_to, open_built_at, goals_sig, goals_through FROM stat_state WHERE site_id = ?";

export function invalidateRollupState(): void {
  stateCache = new WeakMap();
}

export async function rollupState(db: D1Database, siteId: string, now = Date.now()): Promise<RollupState | null> {
  const hit = cacheFor(db).get(siteId);
  if (hit && now - hit.at < STATE_TTL_MS && now >= hit.at) return hit.state;
  const state = await db.prepare(STATE_SQL).bind(siteId).first<RollupState>();
  const s = state && state.version === ROLLUP_VERSION ? state : null;
  cacheFor(db).set(siteId, { at: now, state: s });
  return s;
}

/** Data for days from `day` on changed (import, deletion): those days are rebuilt by the next cron runs. */
export async function invalidateRollups(db: D1Database, siteId: string, day: string): Promise<void> {
  const d = addDays(day, -1);
  await db
    .prepare("UPDATE stat_state SET built_through = MIN(built_through, ?), goals_through = MIN(COALESCE(goals_through, ?), ?), open_to = NULL, open_built_at = NULL WHERE site_id = ?")
    .bind(d, d, d, siteId)
    .run();
  cacheFor(db).delete(siteId);
}

/** Last day that may be closed at `now` (90 minutes after the next local midnight). */
export function closableThrough(now: number, timeZone: string): string {
  return addDays(localParts(now - CLOSE_AFTER_MS, timeZone).day, -1);
}

async function siteGoals(db: D1Database, siteId: string): Promise<StoredGoal[]> {
  const { results } = await db.prepare("SELECT id, kind, definition_json FROM goals WHERE site_id = ? ORDER BY id").bind(siteId).all<{ id: string; kind: GoalMatch["kind"]; definition_json: string }>();
  return results.map((r) => ({ id: r.id, match: { ...(JSON.parse(r.definition_json) as Omit<GoalMatch, "kind">), kind: r.kind } }));
}

/**
 * Cron step: close days that are final (catching up at most BACKFILL_DAYS per run), keep goal rows in step with the
 * goals, then rebuild the open days. Returns what it did per site.
 */
export async function refreshRollups(db: D1Database, sites: Site[], now = Date.now()): Promise<{ site: string; closed: string | null; goals: string | null; open: string | null }[]> {
  const out: { site: string; closed: string | null; goals: string | null; open: string | null }[] = [];
  for (const site of sites) {
    let state = await db.prepare(STATE_SQL).bind(site.id).first<RollupState>();
    const first = async () => {
      const r = await db.prepare("SELECT MIN(local_day) AS d FROM events WHERE site_id = ?").bind(site.id).first<{ d: string | null }>();
      return addDays(r?.d ?? localParts(now, site.timezone).day, -1);
    };
    if (!state || state.version !== ROLLUP_VERSION) {
      const start = await first();
      await db.batch([
        db.prepare("DELETE FROM stat_days WHERE site_id = ?").bind(site.id),
        db
          .prepare(
            `INSERT INTO stat_state (site_id, version, built_through) VALUES (?, ?, ?) ON CONFLICT (site_id) DO UPDATE SET version = excluded.version,
               built_through = excluded.built_through, open_to = NULL, open_built_at = NULL, goals_sig = NULL, goals_through = NULL`,
          )
          .bind(site.id, ROLLUP_VERSION, start),
      ]);
      state = { version: ROLLUP_VERSION, built_through: start, open_to: null, open_built_at: null, goals_sig: null, goals_through: null };
    }
    // Goals changed (added, edited, removed): their rows are rebuilt from the first day, separately from the rest.
    const goals = await siteGoals(db, site.id);
    const sig = goalsSig(goals);
    if (sig !== state.goals_sig) {
      const start = await first();
      await db.batch([
        db.prepare("DELETE FROM stat_days WHERE site_id = ? AND dim = 'goal'").bind(site.id),
        db.prepare("UPDATE stat_state SET goals_sig = ?, goals_through = ? WHERE site_id = ?").bind(sig, start, site.id),
      ]);
      state.goals_sig = sig;
      state.goals_through = start;
    }
    const inStep = () => state.goals_through === state.built_through;
    const today = localParts(now, site.timezone).day;
    const closable = closableThrough(now, site.timezone);
    let closed: string | null = null;
    if (state.built_through < closable) {
      const from = addDays(state.built_through, 1);
      let to = addDays(from, BACKFILL_DAYS - 1);
      if (to > closable) to = closable;
      const withGoals = inStep();
      await db.batch([
        ...writeStmts(db, site, from, to, "all", withGoals ? goals : null),
        db.prepare(`UPDATE stat_state SET built_through = ?${withGoals ? ", goals_through = ?" : ""} WHERE site_id = ?`).bind(...(withGoals ? [to, to] : [to]), site.id),
      ]);
      state.built_through = to;
      if (withGoals) state.goals_through = to;
      closed = `${from}..${to}`;
    }
    let goalRun: string | null = null;
    if (!inStep() && state.goals_through! < state.built_through) {
      const from = addDays(state.goals_through!, 1);
      let to = addDays(from, BACKFILL_DAYS * 2 - 1);
      if (to > state.built_through) to = state.built_through;
      await db.batch([...goalWriteStmts(db, site, from, to, goals), db.prepare("UPDATE stat_state SET goals_through = ? WHERE site_id = ?").bind(to, site.id)]);
      state.goals_through = to;
      goalRun = `${from}..${to}`;
    }
    let open: string | null = null;
    // Open days only once caught up (a backfill would make them a long range); until then reads compute them raw.
    if (state.built_through >= addDays(today, -2)) {
      const from = addDays(state.built_through, 1);
      if (from <= today) {
        await db.batch([
          ...writeStmts(db, site, from, today, "sessions", inStep() ? goals : null),
          db.prepare("UPDATE stat_state SET open_to = ?, open_built_at = ? WHERE site_id = ?").bind(today, now, site.id),
        ]);
        open = `${from}..${today}`;
      }
    }
    cacheFor(db).delete(site.id);
    out.push({ site: site.id, closed, goals: goalRun, open });
  }
  return out;
}

// ---------- reader ----------

type Key = { exprs: string[]; dim: string; subtract: string };

/** Which stored dimension answers these dimensions, and how its keys and day continuations work. */
function plan(dims: string[], from: string): Key | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
  const notFirst = `day > '${from}'`; // validated YYYY-MM-DD, inlined so every UNION branch shares it
  const val = `NULLIF(value, ${NULL_VALUE})`;
  if (dims.length === 0) return { exprs: [], dim: "", subtract: notFirst };
  if (dims.length === 2 && dims[0] === "weekday" && dims[1] === "hour") return { exprs: ["CAST(strftime('%w', day) AS INTEGER)", "value"], dim: "hour", subtract: "0" };
  if (dims.length === 2 && dims[0] === "hour" && dims[1] === "weekday") return { exprs: ["value", "CAST(strftime('%w', day) AS INTEGER)"], dim: "hour", subtract: "0" };
  if (dims.length !== 1) return null;
  const d = dims[0]!;
  switch (d) {
    case "day":
      return { exprs: ["day"], dim: "", subtract: "0" };
    case "weekday":
      return { exprs: ["CAST(strftime('%w', day) AS INTEGER)"], dim: "", subtract: "0" };
    case "week":
      return { exprs: ["date(day, '-6 days', 'weekday 1')"], dim: "", subtract: `${notFirst} AND strftime('%w', day) <> '1'` };
    case "month":
      return { exprs: ["substr(day, 1, 7)"], dim: "", subtract: `${notFirst} AND substr(day, 9, 2) <> '01'` };
    case "hour":
      return { exprs: ["value"], dim: "hour", subtract: "0" };
    case "datehour":
      return { exprs: ["(day || ' ' || printf('%02d', value))"], dim: "hour", subtract: "0" };
  }
  if ((ROLLUP_DIMS as readonly string[]).includes(d)) return { exprs: [val], dim: d, subtract: notFirst };
  return null;
}

/**
 * The aggregate for `spec` from stat_days, or null when a rollup can't answer it exactly (filters, inline or unstored
 * goals, vitals, rolling or UTC windows, unsupported dimensions) or there is no rollup state for the site yet.
 * `goalId` is the id the query named its goal by (stored goal rows are keyed by id and definition).
 */
export function buildRollupAggregate(ctx: BuildContext, spec: AggregateSpec, state: RollupState | null, timeZone: string, now: number, goalId?: string | null): Sql | null {
  if (!state || ctx.tzMode !== "site" || ctx.range.ts || spec.filters.length || ctx.forcedFilters?.length) return null;
  // Vitals percentiles come from their own statements (run.ts); everything else must be answerable here.
  const own = spec.metrics.filter((m) => !(VITAL_METRICS as readonly string[]).includes(m));
  if (!own.every((m) => m in OUTER)) return null;
  const p = plan(spec.dimensions, ctx.range.from);
  if (!p) return null;
  let gkey: string | null = null;
  if (spec.goal) {
    // Goal rows exist per day of the whole site only, for the goals as currently defined and built in step.
    if (!goalId || p.dim !== "" || state.goals_through !== state.built_through) return null;
    gkey = goalKey(goalId, spec.goal);
    let sig: Record<string, string> = {};
    try {
      sig = JSON.parse(state.goals_sig ?? "{}") as Record<string, string>;
    } catch {
      return null;
    }
    if (sig[goalId] !== gkey) return null;
  } else if (own.some((m) => m === "conversions" || m === "conversion_rate")) return null;
  const { from, to } = ctx.range;
  // Stored rows: closed days, plus open days while their build is fresh. Anything newer is computed from raw events.
  let storedTo = state.open_to && state.open_built_at && now - state.open_built_at < OPEN_FRESH_MS ? state.open_to : state.built_through;
  // A period cut at a time of day (`until`) computes its last day from raw events.
  const until = ctx.range.until;
  if (until !== undefined && storedTo >= to) storedTo = addDays(to, -1);
  const params: unknown[] = [];
  const cols = `day, value, ${COLS.join(", ")}`;
  const zeroCols = `day, '' AS value, ${COLS.map((c) => (c === "sessions" ? "0 AS sessions" : c === "c_sessions" ? "0 AS c_sessions" : `0 AS ${c}`)).join(", ")}`;
  const conv = gkey ? ", 0 AS conv, 0 AS c_conv" : "";
  const branches: string[] = [];
  const storedEnd = storedTo < to ? storedTo : to;
  if (from <= storedEnd) {
    branches.push(`SELECT ${cols}${conv} FROM stat_days WHERE site_id = ? AND dim = ? AND day BETWEEN ? AND ?`);
    params.push(ctx.siteId, p.dim, from, storedEnd);
    if (gkey) {
      branches.push(`SELECT ${zeroCols}, sessions AS conv, c_sessions AS c_conv FROM stat_days WHERE site_id = ? AND dim = 'goal' AND day BETWEEN ? AND ? AND value = ?`);
      params.push(ctx.siteId, from, storedEnd, gkey);
    }
  }
  const liveFrom = storedTo >= from ? addDays(storedTo, 1) : from;
  if (liveFrom <= to) {
    const b = buildDays(ctx.siteId, timeZone, p.dim, liveFrom, to, "sessions", until);
    branches.push(`SELECT ${cols}${conv} FROM (${b.sql})`);
    params.push(...b.params);
    if (gkey && spec.goal) {
      const g = buildGoalDays(ctx.siteId, timeZone, gkey, spec.goal, liveFrom, to, "sessions", until);
      branches.push(`SELECT ${zeroCols}, sessions AS conv, c_sessions AS c_conv FROM (${g.sql})`);
      params.push(...g.params);
    }
  }
  if (!branches.length) return null;
  const sumOf = (c: string, cont?: string) => (cont ? `SUM(${c} - CASE WHEN ${p.subtract} THEN ${cont} ELSE 0 END)` : `SUM(${c})`);
  const names: Record<string, string> = { sessions: "ses", visitors: "vis" };
  const keySel = p.exprs.map((e, i) => `${e} AS ${dimAlias(i)}`);
  const sums = [...SUMS.map((c) => `${sumOf(c, CONT[c])} AS ${names[c] ?? c}`), ...(gkey ? [`${sumOf("conv", "c_conv")} AS conv`] : [])];
  const inner = `SELECT ${[...keySel, ...sums].join(", ")}
    FROM (${branches.join(" UNION ALL ")})${p.exprs.length ? ` GROUP BY ${p.exprs.map((_, i) => dimAlias(i)).join(", ")}` : ""}`;
  const metrics = own.length ? own : (["sessions"] as Metric[]);
  const select = [...p.exprs.map((_, i) => dimAlias(i)), ...metrics.map((m) => `${OUTER[m]} AS ${m}`)];
  let sql = `SELECT ${select.join(", ")} FROM (${inner})`;
  if (p.exprs.length) {
    sql += " WHERE ses > 0 OR pv > 0";
    const ob = spec.orderBy;
    const aliases = p.exprs.map((_, i) => dimAlias(i));
    let order: string;
    if (ob && (metrics as string[]).includes(ob[0])) order = `${ob[0]} ${ob[1]}`;
    else if (ob && spec.dimensions.includes(ob[0])) order = `${dimAlias(spec.dimensions.indexOf(ob[0]))} ${ob[1]}`;
    else if (spec.dimensions.some((d) => TIME_DIMS.includes(d))) order = aliases.map((a) => `${a} ASC`).join(", ");
    else order = `${metrics[0]} DESC`;
    sql += ` ORDER BY ${order}, ${aliases.join(", ")} LIMIT ? OFFSET ?`;
    params.push(spec.limit ?? 100, spec.offset ?? 0);
  }
  return { sql, params };
}

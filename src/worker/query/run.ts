import type { Site } from "../lib/sites.ts";
import { buildAggregate, buildVitalsP75, TIME_DIMS, type BuildContext, type Sql } from "./build.ts";
import { compareRange, resolveRange, type DayRange } from "./range.ts";
import { buildRollupAggregate, rollupState, type RollupState } from "./rollup.ts";
import { METRICS, VITAL_METRICS, type GoalMatch, type Metric, type Query } from "./schema.ts";

export type Row = Record<string, string | number | null>;

export interface QueryResult {
  rows: Row[];
  totals: Row;
  comparison: { date_range: DayRange; totals: Row; rows: Row[] } | null;
  next_cursor: string | null;
  meta: QueryMeta;
}

export interface QueryMeta {
  site: string;
  date_range: DayRange;
  timezone: string;
  generated_at: string;
  /** Imported vs live rows in the range; only when the query asks for it (`source_counts: true`). */
  source_counts?: { pulse: number; rybbit: number };
}

export class QueryError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ o: offset }));
}
function decodeCursor(c: string | undefined): number {
  if (!c) return 0;
  try {
    const o = (JSON.parse(atob(c)) as { o?: number }).o;
    return typeof o === "number" && o >= 0 ? Math.floor(o) : 0;
  } catch {
    throw new QueryError("invalid_cursor", "cursor is not valid");
  }
}

export async function resolveGoal(db: D1Database, siteId: string, goal: Query["goal"]): Promise<GoalMatch | null> {
  if (!goal) return null;
  if (typeof goal !== "string") return goal;
  const row = await db
    .prepare("SELECT kind, definition_json FROM goals WHERE id = ? AND site_id = ?")
    .bind(goal, siteId)
    .first<{ kind: GoalMatch["kind"]; definition_json: string }>();
  if (!row) throw new QueryError("goal_not_found", "goal not found", 404);
  return { ...(JSON.parse(row.definition_json) as Omit<GoalMatch, "kind">), kind: row.kind };
}

/** Load the goals named by `goal` filters (scoped to the site) so the SQL builder can inline them. */
export async function resolveFilterGoals(db: D1Database, siteId: string, filters: readonly (readonly [string, string, readonly (string | number)[]])[] | undefined): Promise<Record<string, GoalMatch>> {
  const ids = [...new Set((filters ?? []).filter(([, d]) => d === "goal").flatMap(([, , v]) => v.map(String)))];
  const out: Record<string, GoalMatch> = {};
  for (const id of ids) out[id] = (await resolveGoal(db, siteId, id))!;
  return out;
}

export async function firstDay(db: D1Database, siteId: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT MIN(local_day) AS d FROM events WHERE site_id = ?")
    .bind(siteId)
    .first<{ d: string | null }>();
  return r?.d ?? null;
}

/** Metrics that are counts or sums (0 when there is nothing); every other metric is a rate or average. */
export const COUNT_METRICS = new Set<string>(["visitors", "sessions", "pageviews", "events", "conversions", "entries", "exits", "revenue"]);

function mapRows(raw: Record<string, unknown>[], dims: string[]): Row[] {
  return raw.map((r) => {
    const out: Row = {};
    dims.forEach((d, i) => {
      const v = r[`d${i}`];
      out[d] = v === undefined || v === null || v === "" ? null : (v as string | number);
    });
    // Counts of nothing are 0; rates and averages of nothing stay null (an empty day has no bounce rate, not 0 %).
    for (const [k, v] of Object.entries(r)) if (!/^d\d+$/.test(k)) out[k] = (v as number | null) ?? (COUNT_METRICS.has(k) ? 0 : null);
    return out;
  });
}

const keyOf = (r: Row, dims: string[]) => JSON.stringify(dims.map((d) => r[d]));

/** One SQL statement of a planned query, with the columns it returns (so several can be merged into one statement). */
export interface Part extends Sql {
  cols: string[];
}
type Results = Record<string, unknown>[][];

interface Prepared {
  parts: Part[];
  decode: (res: Results) => { rows: Row[]; totals: Row };
}

/** Rollup context for one query: null forces raw events. */
interface Rollups {
  state: RollupState | null;
  timeZone: string;
  now: number;
  /** The goal id the query named, when it named one (stored goal rows are keyed by it). */
  goalId: string | null;
}

const OUTER_METRICS = new Set<string>(METRICS.filter((m) => !(VITAL_METRICS as readonly string[]).includes(m)));

/** Statements for one period; the caller batches (or merges) every period of every query into one D1 round trip. */
function prepareOnce(
  ctx: BuildContext,
  q: Pick<Query, "metrics" | "dimensions" | "filters" | "order_by">,
  goal: GoalMatch | null,
  limit: number,
  offset: number,
  rollups: Rollups | null,
  withTotals: boolean,
): Prepared {
  const metrics = q.metrics as Metric[];
  const aggSpec = { metrics, dimensions: q.dimensions, filters: q.filters as never, goal, orderBy: q.order_by, limit: limit + 1, offset };
  const parts: Part[] = [];
  const dimCols = q.dimensions.map((_, i) => `d${i}`);
  const own = metrics.filter((m) => OUTER_METRICS.has(m));
  const metricCols = own.length ? own : ["sessions"];
  // Without dimensions the main statement already is the totals: run it once.
  const dims = q.dimensions.length > 0;
  const totals = dims && withTotals;
  // Daily rollups answer what they can exactly (rollup.ts); everything else reads raw events.
  const agg = (spec: typeof aggSpec) => (rollups && buildRollupAggregate(ctx, spec, rollups.state, rollups.timeZone, rollups.now, rollups.goalId)) || buildAggregate(ctx, spec);
  parts.push({ ...agg(aggSpec), cols: [...dimCols, ...metricCols] });
  if (totals) parts.push({ ...agg({ ...aggSpec, dimensions: [] }), cols: metricCols });
  const base = parts.length;
  const vitals = metrics.filter((m): m is (typeof VITAL_METRICS)[number] => (VITAL_METRICS as readonly string[]).includes(m));
  const per = (dims ? 1 : 0) + (dims && !totals ? 0 : 1);
  for (const v of vitals) {
    const col = v.slice(0, 3) as "lcp" | "inp" | "cls";
    if (dims) parts.push({ ...buildVitalsP75(ctx, col, { dimensions: q.dimensions, filters: q.filters as never }), cols: [...dimCols, "v"] });
    if (!dims || totals) parts.push({ ...buildVitalsP75(ctx, col, { dimensions: [], filters: q.filters as never }), cols: ["v"] });
  }
  const decode = (res: Results) => {
    const rows = dims ? mapRows(res[0]!, q.dimensions) : [];
    const tot = dims ? (totals ? (mapRows(res[1]!, [])[0] ?? {}) : {}) : (mapRows(res[0]!, [])[0] ?? {});
    vitals.forEach((v, i) => {
      if (dims) {
        const byKey = mapRows(res[base + i * per]!, q.dimensions);
        const map = new Map(byKey.map((r) => [keyOf(r, q.dimensions), r.v]));
        for (const r of rows) r[v] = (map.get(keyOf(r, q.dimensions)) as number | undefined) ?? null;
      }
      if (!dims || totals) tot[v] = (mapRows(res[base + i * per + per - 1]!, [])[0]?.v as number | undefined) ?? null;
    });
    for (const r of rows) delete r.v;
    return { rows, totals: tot };
  };
  return { parts, decode };
}

function sourceCountsPart(siteId: string, range: DayRange): Part {
  return { sql: "SELECT source, COUNT(*) AS n FROM events WHERE site_id = ? AND local_day BETWEEN ? AND ? GROUP BY source", params: [siteId, range.from, range.to], cols: ["source", "n"] };
}

function decodeSourceCounts(results: Record<string, unknown>[]): { pulse: number; rybbit: number } {
  const out = { pulse: 0, rybbit: 0 };
  for (const r of results as { source: string; n: number }[]) if (r.source === "pulse" || r.source === "rybbit") out[r.source] = r.n;
  return out;
}

export async function sourceCounts(db: D1Database, siteId: string, range: DayRange): Promise<{ pulse: number; rybbit: number }> {
  const p = sourceCountsPart(siteId, range);
  return decodeSourceCounts((await db.prepare(p.sql).bind(...p.params).all<Record<string, unknown>>()).results);
}

export interface RunOptions {
  /** Return every comparison row as the database gave it instead of aligning them to the main rows (movers). */
  rawComparison?: boolean;
  /** Read raw events only, never the daily rollups (tests compare the two). */
  raw?: boolean;
  /** Skip the totals statement of a query with dimensions (totals come back empty). */
  noTotals?: boolean;
  /** Goals already loaded by the caller, by id (saves one lookup per goal). */
  goals?: Record<string, GoalMatch>;
}

/** A query planned into statements, and how to turn their results into a QueryResult. */
export interface PlannedQuery {
  parts: Part[];
  finish: (results: Results) => QueryResult;
}

export async function planQuery(db: D1Database, site: Site, q: Query, now = Date.now(), opts: RunOptions = {}): Promise<PlannedQuery> {
  const first = typeof q.date_range === "string" && q.date_range === "all" ? await firstDay(db, site.id) : null;
  const range = resolveRange(q.date_range, site.timezone, now, first);
  const tzMode = q.timezone;
  const forcedFilters = site.forcedFilters as Query["filters"] | undefined;
  const ctx: BuildContext = { siteId: site.id, timeZone: site.timezone, tzMode, range, goals: await resolveFilterGoals(db, site.id, [...q.filters, ...(forcedFilters ?? [])]), forcedFilters };
  const goal = typeof q.goal === "string" && opts.goals?.[q.goal] ? opts.goals[q.goal]! : await resolveGoal(db, site.id, q.goal);
  if ((q.metrics.includes("conversions") || q.metrics.includes("conversion_rate")) && !goal)
    throw new QueryError("goal_required", "conversions and conversion_rate need `goal`");
  const offset = decodeCursor(q.cursor);
  const rollups: Rollups | null = opts.raw ? null : { state: await rollupState(db, site.id, now), timeZone: site.timezone, now, goalId: typeof q.goal === "string" ? q.goal : null };
  const main = prepareOnce(ctx, q, goal, q.limit, offset, rollups, !opts.noTotals);
  const cr = q.compare ? compareRange(range, q.compare, tzMode === "site" ? site.timezone : "UTC", now) : null;
  const cmpLimit = opts.rawComparison ? 1000 : q.limit;
  const cmpPrep = cr ? prepareOnce({ ...ctx, range: cr }, { ...q, filters: q.filters }, goal, cmpLimit, 0, rollups, !opts.noTotals) : null;
  // Imported/live counts scan every event in the range, so only on request; site-wide, so never for a share link bound to a view.
  const withCounts = q.source_counts && !forcedFilters?.length;
  const parts = [...main.parts, ...(cmpPrep?.parts ?? []), ...(withCounts ? [sourceCountsPart(site.id, range)] : [])];
  const finish = (res: Results): QueryResult => {
    const cur = main.decode(res.slice(0, main.parts.length));
    const cmp = cmpPrep ? cmpPrep.decode(res.slice(main.parts.length, main.parts.length + cmpPrep.parts.length)) : null;
    const counts = withCounts ? decodeSourceCounts(res[res.length - 1]!) : undefined;
    const hasMore = cur.rows.length > q.limit;
    if (hasMore) cur.rows.length = q.limit;
    let comparison: QueryResult["comparison"] = null;
    if (cr && cmp) {
      // Align comparison rows to the main rows by dimension key (time dims don't align by value; keep order).
      // Calendar dimensions (day, week…) differ between periods, so rows align by position; hour and weekday repeat,
      // so they align by value like any other dimension.
      const timeDims = q.dimensions.some((d) => TIME_DIMS.includes(d) && d !== "hour" && d !== "weekday");
      let rows = cmp.rows;
      if (cmp.rows.length > cmpLimit) rows = cmp.rows.slice(0, cmpLimit);
      if (!opts.rawComparison && !timeDims && q.dimensions.length) {
        const m = new Map(cmp.rows.map((r) => [keyOf(r, q.dimensions), r]));
        rows = cur.rows.map((r) => m.get(keyOf(r, q.dimensions)) ?? { ...Object.fromEntries(q.dimensions.map((d) => [d, r[d] ?? null])) });
      }
      comparison = { date_range: cr, totals: cmp.totals, rows };
    }
    return {
      rows: cur.rows,
      totals: cur.totals,
      comparison,
      next_cursor: hasMore ? encodeCursor(offset + q.limit) : null,
      meta: {
        site: site.id,
        date_range: range,
        timezone: tzMode === "site" ? site.timezone : "UTC",
        generated_at: new Date(now).toISOString(),
        ...(counts ? { source_counts: counts } : {}),
      },
    };
  };
  return { parts, finish };
}

/** Main period, comparison period and source counts go to D1 as one batch: one round trip per query. */
export async function runQuery(db: D1Database, site: Site, q: Query, now = Date.now(), opts: RunOptions = {}): Promise<QueryResult> {
  const p = await planQuery(db, site, q, now, opts);
  const res = await db.batch<Record<string, unknown>>(p.parts.map((x) => db.prepare(x.sql).bind(...x.params)));
  return p.finish(res.map((r) => r.results));
}

/**
 * Several statements as one: each part's rows come back as a JSON array in its own row, so a whole report is one D1
 * query instead of one per panel (D1 runs one query at a time; fewer, cheaper queries is what keeps it from overloading).
 */
/** D1 accepts at most 5 terms in one compound SELECT (a compound nested in a subquery counts on its own). */
export const D1_MAX_COMPOUND = 5;

/** UNION ALL of the selects, nested so no compound has more than `max` terms; the text order (and so the order of
 * the bound parameters) is kept. */
export function unionAll(selects: string[], max = D1_MAX_COMPOUND): string {
  if (selects.length <= max) return selects.join("\nUNION ALL\n");
  const groups: string[] = [];
  for (let i = 0; i < selects.length; i += max) groups.push(`SELECT * FROM (${selects.slice(i, i + max).join("\nUNION ALL\n")})`);
  return unionAll(groups, max);
}

export function mergeParts(parts: Part[]): Sql {
  const branches = parts.map((p, i) => {
    const obj = p.cols.map((c) => `'${c}', ${c}`).join(", ");
    return `SELECT ${i} AS p, json_group_array(json_object(${obj})) AS j FROM (${p.sql})`;
  });
  return { sql: unionAll(branches), params: parts.flatMap((p) => p.params) };
}

export function splitMerged(rows: { p: number; j: string }[], n: number): Results {
  const out: Results = Array.from({ length: n }, () => []);
  for (const r of rows) out[r.p] = JSON.parse(r.j) as Record<string, unknown>[];
  return out;
}

/** D1 accepts at most 100 bound parameters per statement. */
export const D1_MAX_PARAMS = 100;

/** Pack parts, in order, into groups whose parameters fit in one D1 statement. */
export function packParts(parts: Part[], max = D1_MAX_PARAMS): Part[][] {
  const groups: Part[][] = [];
  let cur: Part[] = [];
  let n = 0;
  for (const p of parts) {
    if (p.params.length > max) throw new Error(`a query part binds ${p.params.length} parameters (D1 allows ${max})`);
    if (cur.length && n + p.params.length > max) {
      groups.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(p);
    n += p.params.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Plan several queries and run their statements merged: as few D1 statements as D1's 100-parameter limit allows,
 * all in one batch (one round trip), plus `extra` statements in the same batch.
 */
export async function runMerged(db: D1Database, plans: PlannedQuery[], extra: D1PreparedStatement[] = []): Promise<{ results: QueryResult[]; extra: D1Result<Record<string, unknown>>[]; rowsRead: number; statements: number }> {
  const parts = plans.flatMap((p) => p.parts);
  const groups = packParts(parts);
  const stmts = groups.map((g) => {
    const m = mergeParts(g);
    return db.prepare(m.sql).bind(...m.params);
  });
  const res = await db.batch<Record<string, unknown>>([...stmts, ...extra]);
  const all = groups.flatMap((g, i) => splitMerged(res[i]!.results as { p: number; j: string }[], g.length));
  let at = 0;
  const results = plans.map((p) => {
    const slice = all.slice(at, at + p.parts.length);
    at += p.parts.length;
    return p.finish(slice);
  });
  const rowsRead = res.reduce((a, r) => a + Number((r.meta as { rows_read?: number } | undefined)?.rows_read ?? 0), 0);
  return { results, extra: res.slice(groups.length), rowsRead, statements: res.length };
}

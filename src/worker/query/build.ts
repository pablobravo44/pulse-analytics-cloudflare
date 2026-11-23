// Pure SQL builder for the query engine. Every value is a bound parameter; identifiers come only
// from closed lists below. The site filter is always the first WHERE clause.

import { sourceNameSql } from "../lib/channels.ts";
import { startOfLocalDay, addDays } from "../lib/time.ts";
import type { DayRange } from "./range.ts";
import type { Filter, GoalMatch, Metric } from "./schema.ts";

export interface BuildContext {
  siteId: string;
  timeZone: string; // site tz (used when tzMode = "site")
  tzMode: "site" | "UTC";
  range: DayRange;
  /** Goal ids used by `goal` filters, resolved by the caller (see resolveFilterGoals in run.ts). */
  goals?: Record<string, GoalMatch>;
  /** Filters that always apply on top of the caller's (share links bound to a saved view). */
  forcedFilters?: Filter[];
}

export interface Sql {
  sql: string;
  params: unknown[];
}

const SESSION_DIMS: Record<string, string> = {
  entry_page: "s.entry_path",
  exit_page: "s.exit_path",
  referrer: "s.referrer",
  referrer_host: "s.referrer_host",
  channel: "s.channel",
  source_name: sourceNameSql("s.referrer_host", "s.utm_source"),
  utm_source: "s.utm_source",
  utm_medium: "s.utm_medium",
  utm_campaign: "s.utm_campaign",
  utm_term: "s.utm_term",
  utm_content: "s.utm_content",
  country: "s.country",
  region: "s.region",
  city: "s.city",
  continent: "s.continent",
  device: "s.device",
  browser: "s.browser",
  browser_version: "(s.browser || ' ' || COALESCE(s.browser_version, ''))",
  os: "s.os",
  os_version: "(s.os || ' ' || COALESCE(s.os_version, ''))",
  screen: "(s.screen_w || 'x' || s.screen_h)",
  language: "s.language",
};

const EVENT_DIMS: Record<string, string> = {
  page: "e.pathname",
  hostname: "e.hostname",
  title: "e.title",
  type: "e.type",
  source: "e.source",
  search_term: "e.search_term",
};

/** Dimensions that only exist on a specific event type. As a dimension they restrict rows to that type. */
const TYPED_DIMS: Record<string, { type: string; expr: string }> = {
  event_name: { type: "event", expr: "e.name" },
  outbound_url: { type: "outbound", expr: "e.url" },
  download_url: { type: "download", expr: "e.url" },
};

function timeDim(dim: string, tzMode: "site" | "UTC"): string | null {
  const day = tzMode === "site" ? "e.local_day" : "strftime('%Y-%m-%d', e.ts / 1000, 'unixepoch')";
  switch (dim) {
    case "day":
      return day;
    case "hour":
      return tzMode === "site" ? "e.local_hour" : "CAST(strftime('%H', e.ts / 1000, 'unixepoch') AS INTEGER)";
    case "datehour":
      return tzMode === "site" ? "(e.local_day || ' ' || printf('%02d', e.local_hour))" : "strftime('%Y-%m-%d %H', e.ts / 1000, 'unixepoch')";
    case "weekday":
      return `CAST(strftime('%w', ${day}) AS INTEGER)`;
    case "week":
      return `date(${day}, '-6 days', 'weekday 1')`;
    case "month":
      return `substr(${day}, 1, 7)`;
    default:
      return null;
  }
}

function propKey(dim: string): string | null {
  const m = /^event_prop:(.+)$/.exec(dim);
  return m ? m[1]! : null;
}

export interface DimExpr {
  expr: string;
  params: unknown[];
  rowType: string | null; // restricts rows to this event type when used as a dimension
}

export function dimExpr(dim: string, tzMode: "site" | "UTC"): DimExpr {
  const t = timeDim(dim, tzMode);
  if (t) return { expr: t, params: [], rowType: null };
  if (dim in EVENT_DIMS) return { expr: EVENT_DIMS[dim]!, params: [], rowType: null };
  if (dim in SESSION_DIMS) return { expr: SESSION_DIMS[dim]!, params: [], rowType: null };
  if (dim in TYPED_DIMS) return { expr: TYPED_DIMS[dim]!.expr, params: [], rowType: TYPED_DIMS[dim]!.type };
  const key = propKey(dim);
  if (key) return { expr: "json_extract(e.props_json, ?)", params: [`$."${key.replace(/"/g, "")}"`], rowType: "event" };
  throw new Error(`unknown dimension ${dim}`);
}

/** Time-range predicate on alias `alias`. */
export function rangePredicate(ctx: BuildContext, alias = "e"): Sql {
  if (ctx.range.ts) return { sql: `${alias}.ts >= ? AND ${alias}.ts < ?`, params: [ctx.range.ts.from, ctx.range.ts.to] };
  const cut = ctx.range.until !== undefined ? { sql: ` AND ${alias}.ts < ?`, params: [ctx.range.until] } : { sql: "", params: [] };
  if (ctx.tzMode === "site") {
    return { sql: `${alias}.local_day BETWEEN ? AND ?${cut.sql}`, params: [ctx.range.from, ctx.range.to, ...cut.params] };
  }
  const from = startOfLocalDay(ctx.range.from, "UTC");
  const to = startOfLocalDay(addDays(ctx.range.to, 1), "UTC");
  return { sql: `${alias}.ts >= ? AND ${alias}.ts < ?${cut.sql}`, params: [from, to, ...cut.params] };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `*` is the only wildcard; everything else is literal. */
function likeFromGlob(v: string): string {
  return escapeLike(v).replace(/\*/g, "%");
}

function predicate(op: Filter[0], expr: string, exprParams: unknown[], values: (string | number)[]): Sql {
  const params: unknown[] = [];
  let sql: string;
  // `expr` may contain `?` placeholders (exprParams); every use of it repeats them.
  const use = () => {
    params.push(...exprParams);
    return expr;
  };
  switch (op) {
    case "is":
    case "is_one_of": {
      const hasNone = values.some((v) => v === "(none)");
      const vals = values.filter((v) => v !== "(none)");
      const parts: string[] = [];
      if (vals.length) {
        parts.push(`${use()} IN (${vals.map(() => "?").join(", ")})`);
        params.push(...vals);
      }
      if (hasNone) parts.push(`COALESCE(${use()}, '') = ''`);
      sql = `(${parts.join(" OR ")})`;
      break;
    }
    case "is_not": {
      const hasNone = values.some((v) => v === "(none)");
      const vals = values.filter((v) => v !== "(none)");
      const parts: string[] = [];
      if (vals.length) {
        parts.push(`COALESCE(${use()}, '') NOT IN (${vals.map(() => "?").join(", ")})`);
        params.push(...vals.map(String));
      }
      if (hasNone) parts.push(`COALESCE(${use()}, '') <> ''`);
      sql = `(${parts.join(" AND ")})`;
      break;
    }
    case "contains":
    case "not_contains":
    case "starts_with": {
      const pats = values.map((v) =>
        op === "starts_with" ? `${escapeLike(String(v))}%` : `%${escapeLike(String(v))}%`,
      );
      const parts = pats.map((p) => {
        const e = `COALESCE(${use()}, '')`;
        params.push(p);
        return `${e} LIKE ? ESCAPE '\\'`;
      });
      sql = op === "not_contains" ? `NOT (${parts.join(" OR ")})` : `(${parts.join(" OR ")})`;
      break;
    }
    case "matches":
    case "not_matches": {
      const parts = values.map((v) => {
        const e = `COALESCE(${use()}, '')`;
        params.push(likeFromGlob(String(v)));
        return `${e} LIKE ? ESCAPE '\\'`;
      });
      sql = op === "not_matches" ? `NOT (${parts.join(" OR ")})` : `(${parts.join(" OR ")})`;
      break;
    }
  }
  return { sql, params };
}

/** Build WHERE clauses for filters. Typed-event filters become session-level subqueries. */
export function filterClauses(ctx: BuildContext, filters: Filter[]): Sql {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [op, dim, values] of [...filters, ...(ctx.forcedFilters ?? [])]) {
    if (dim === "goal") {
      // Sessions that converted on any of the listed goals within the range.
      const preds = values.map((id) => {
        const g = ctx.goals?.[String(id)];
        if (!g) throw new Error(`goal ${id} not resolved`);
        const p = goalPredicate(g);
        return { sql: p.sql.replace(/\be\./g, "f."), params: p.params };
      });
      const r = rangePredicate(ctx, "f");
      parts.push(`e.session_id ${op === "is_not" ? "NOT IN" : "IN"} (SELECT f.session_id FROM events f WHERE f.site_id = ? AND ${r.sql} AND (${preds.map((p) => p.sql).join(" OR ")}))`);
      params.push(ctx.siteId, ...r.params, ...preds.flatMap((p) => p.params));
      continue;
    }
    const d = dimExpr(dim, ctx.tzMode);
    if (d.rowType) {
      const negated = op === "is_not" || op === "not_contains" || op === "not_matches";
      const positive = op === "is_not" ? "is" : op === "not_contains" ? "contains" : op === "not_matches" ? "matches" : op;
      const inner = predicate(positive, d.expr.replace(/\be\./g, "f."), d.params, values);
      const r = rangePredicate(ctx, "f");
      const sub = `e.session_id ${negated ? "NOT IN" : "IN"} (SELECT f.session_id FROM events f WHERE f.site_id = ? AND ${r.sql} AND f.type = ? AND ${inner.sql})`;
      parts.push(sub);
      params.push(ctx.siteId, ...r.params, d.rowType, ...inner.params);
    } else {
      const p = predicate(op, d.expr, d.params, values);
      parts.push(p.sql);
      params.push(...p.params);
    }
  }
  return { sql: parts.length ? parts.map((p) => `(${p})`).join(" AND ") : "1 = 1", params };
}

function globFromPattern(p: string): string {
  // Goal path patterns use `*` as wildcard, e.g. "/*/pricing".
  return p.replace(/[[\]?]/g, (c) => `[${c}]`);
}

export function goalPredicate(g: GoalMatch | null): Sql {
  if (!g) return { sql: "0", params: [] };
  switch (g.kind) {
    case "pageview":
      return { sql: "(e.type = 'pageview' AND e.pathname GLOB ?)", params: [globFromPattern(g.path ?? "/")] };
    case "event": {
      if (g.prop) {
        return {
          sql: "(e.type = 'event' AND e.name = ? AND json_extract(e.props_json, ?) = ?)",
          params: [g.event ?? "", `$."${g.prop.key.replace(/"/g, "")}"`, g.prop.value],
        };
      }
      return { sql: "(e.type = 'event' AND e.name = ?)", params: [g.event ?? ""] };
    }
    case "outbound": {
      const hosts = (g.host ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      if (!hosts.length) return { sql: "(e.type = 'outbound')", params: [] };
      return {
        sql: `(e.type = 'outbound' AND (${hosts.map(() => "instr(e.url, ?) > 0").join(" OR ")}))`,
        params: hosts,
      };
    }
  }
}

const OUTER_METRIC: Record<Exclude<Metric, "lcp_p75" | "inp_p75" | "cls_p75">, string> = {
  visitors: "COUNT(DISTINCT CASE WHEN act THEN vid END)",
  sessions: "SUM(act)",
  pageviews: "SUM(pv)",
  views_per_session: "ROUND(CAST(SUM(pv) AS REAL) / NULLIF(SUM(act), 0), 2)",
  bounce_rate: "ROUND(100.0 * SUM(CASE WHEN act THEN b ELSE 0 END) / NULLIF(SUM(act), 0), 1)",
  avg_session_duration: "ROUND(AVG(CASE WHEN act THEN dur END) / 1000.0, 1)",
  avg_engaged_time: "ROUND(SUM(eng) / 1000.0 / NULLIF(SUM(pv), 0), 1)",
  events: "SUM(ce)",
  conversions: "SUM(CASE WHEN act THEN conv ELSE 0 END)",
  conversion_rate: "ROUND(100.0 * SUM(CASE WHEN act THEN conv ELSE 0 END) / NULLIF(SUM(act), 0), 2)",
  entries: "SUM(ent)",
  exits: "SUM(ext)",
  exit_rate: "ROUND(100.0 * SUM(ext) / NULLIF(SUM(pv), 0), 1)",
  scroll_depth: "ROUND(CAST(SUM(sc_sum) AS REAL) / NULLIF(SUM(sc_n), 0), 0)",
  revenue: "ROUND(SUM(rev), 2)",
  average_revenue: "ROUND(SUM(rev) / NULLIF(SUM(rev > 0), 0), 2)",
  revenue_per_visitor: "ROUND(SUM(rev) / NULLIF(COUNT(DISTINCT CASE WHEN act THEN vid END), 0), 2)",
};
const REVENUE_METRICS = ["revenue", "average_revenue", "revenue_per_visitor"];

export interface AggregateSpec {
  metrics: Metric[];
  dimensions: string[];
  filters: Filter[];
  goal: GoalMatch | null;
  orderBy?: [string, "asc" | "desc"];
  limit?: number;
  offset?: number;
}

export const dimAlias = (i: number) => `d${i}`;
export const TIME_DIMS = ["day", "hour", "datehour", "weekday", "week", "month"];

export function buildAggregate(ctx: BuildContext, spec: AggregateSpec): Sql {
  const params: unknown[] = [];
  const dims = spec.dimensions.map((d) => dimExpr(d, ctx.tzMode));
  const selectDims = dims.map((d, i) => `${d.expr} AS ${dimAlias(i)}`);
  for (const d of dims) params.push(...d.params);

  const goal = goalPredicate(spec.goal);
  params.push(...goal.params);

  const where: string[] = ["e.site_id = ?"];
  const whereParams: unknown[] = [ctx.siteId];
  const r = rangePredicate(ctx);
  where.push(r.sql);
  whereParams.push(...r.params);
  const rowTypes = [...new Set(dims.map((d) => d.rowType).filter((t): t is string => !!t))];
  if (rowTypes.length === 1) {
    where.push("e.type = ?");
    whereParams.push(rowTypes[0]);
  } else if (rowTypes.length > 1) {
    where.push("0 = 1");
  }
  const f = filterClauses(ctx, spec.filters);
  where.push(f.sql);
  whereParams.push(...f.params);
  params.push(...whereParams);

  // Scroll depth is the deepest scroll of each pageview (its engagement beacons that day), averaged over pageviews;
  // averaging the beacons themselves would weight a page by how often its tab was hidden.
  const scroll = spec.metrics.includes("scroll_depth");
  let scrollJoin = "";
  const joinParams: unknown[] = [];
  if (scroll) {
    const fr = rangePredicate(ctx, "f");
    scrollJoin = `LEFT JOIN (SELECT f.pageview_id AS pid, f.local_day AS pday, MAX(f.scroll_pct) AS m FROM events f
        WHERE f.site_id = ? AND ${fr.sql} AND f.type = 'engagement' AND f.scroll_pct IS NOT NULL AND f.pageview_id IS NOT NULL GROUP BY 1, 2) sp
      ON e.type = 'pageview' AND sp.pid = e.pageview_id AND sp.pday = e.local_day`;
    joinParams.push(ctx.siteId, ...fr.params);
  }
  params.splice(params.length - whereParams.length, 0, ...joinParams);
  const groupInner = [...dims.map((_, i) => dimAlias(i)), "e.session_id"].join(", ");
  const inner = `SELECT ${selectDims.length ? selectDims.join(", ") + ", " : ""}e.session_id AS sid,
      MAX(e.visitor_id) AS vid,
      SUM(e.type = 'pageview') AS pv,
      SUM(e.type = 'event') AS ce,
      SUM(e.type IN ('outbound', 'download')) AS ox,
      SUM(COALESCE(e.engaged_ms, 0)) AS eng,
      ${scroll ? "SUM(sp.m)" : "NULL"} AS sc_sum,
      ${scroll ? "COUNT(sp.m)" : "0"} AS sc_n,
      MAX(COALESCE(s.bounced, 0)) AS b,
      MAX(COALESCE(s.duration_ms, 0)) AS dur,
      MAX(e.type = 'pageview' AND e.pathname = s.entry_path) AS ent,
      MAX(e.type = 'pageview' AND e.pathname = s.exit_path) AS ext,
      MAX(${goal.sql}) AS conv,
      ${spec.metrics.some((m) => REVENUE_METRICS.includes(m)) ? "SUM(CASE WHEN e.type = 'event' THEN COALESCE(CAST(json_extract(e.props_json, '$.revenue') AS REAL), 0) ELSE 0 END)" : "0"} AS rev
    FROM events e LEFT JOIN sessions s ON s.id = e.session_id ${scrollJoin}
    WHERE ${where.join(" AND ")}
    GROUP BY ${groupInner}`;

  const aggMetrics = spec.metrics.filter((m): m is keyof typeof OUTER_METRIC => m in OUTER_METRIC);
  const outerSelect = [
    ...dims.map((_, i) => dimAlias(i)),
    ...aggMetrics.map((m) => `${OUTER_METRIC[m]} AS ${m}`),
  ];
  if (!outerSelect.length) outerSelect.push("SUM(act) AS sessions");

  let sql = `WITH r AS (SELECT *, (pv + ce + ox) > 0 AS act FROM (${inner}))
    SELECT ${outerSelect.join(", ")} FROM r`;
  if (dims.length) {
    sql += ` GROUP BY ${dims.map((_, i) => dimAlias(i)).join(", ")}`;
    sql += ` HAVING SUM(act) > 0 OR SUM(pv) > 0`;
    const ob = spec.orderBy;
    let order: string;
    if (ob && (aggMetrics as string[]).includes(ob[0])) order = `${ob[0]} ${ob[1]}`;
    else if (ob && spec.dimensions.includes(ob[0])) order = `${dimAlias(spec.dimensions.indexOf(ob[0]))} ${ob[1]}`;
    else if (spec.dimensions.some((d) => TIME_DIMS.includes(d)))
      order = dims.map((_, i) => `${dimAlias(i)} ASC`).join(", ");
    else order = `${aggMetrics[0] ?? "sessions"} DESC`;
    sql += ` ORDER BY ${order}, ${dims.map((_, i) => dimAlias(i)).join(", ")}`;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(spec.limit ?? 100, spec.offset ?? 0);
  }
  return { sql, params };
}

/** p75 (nearest rank) of one vitals column per dimension group. */
export function buildVitalsP75(ctx: BuildContext, column: "lcp" | "inp" | "cls", spec: Omit<AggregateSpec, "metrics" | "goal">): Sql {
  const params: unknown[] = [];
  const dims = spec.dimensions.map((d) => dimExpr(d, ctx.tzMode));
  if (dims.some((d) => d.rowType)) return { sql: "SELECT NULL AS v WHERE 0", params: [] };
  const sel = dims.map((d, i) => `${d.expr} AS ${dimAlias(i)}`);
  for (const d of dims) params.push(...d.params);
  const r = rangePredicate(ctx);
  const f = filterClauses(ctx, spec.filters);
  params.push(ctx.siteId, ...r.params, ...f.params);
  const part = dims.length ? `PARTITION BY ${dims.map((_, i) => dimAlias(i)).join(", ")}` : "";
  const g = dims.map((_, i) => dimAlias(i)).join(", ");
  const sql = `WITH v AS (
      SELECT ${sel.length ? sel.join(", ") + ", " : ""}e.${column} AS val
      FROM events e LEFT JOIN sessions s ON s.id = e.session_id
      WHERE e.site_id = ? AND ${r.sql} AND e.type = 'vitals' AND e.${column} IS NOT NULL AND ${f.sql}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (${part} ORDER BY val) AS rn, COUNT(*) OVER (${part}) AS n FROM v
    )
    SELECT ${g ? g + ", " : ""}MIN(val) AS v FROM ranked WHERE rn >= 0.75 * n ${g ? `GROUP BY ${g}` : ""}`;
  return { sql, params };
}

import { pathMatches, type Site } from "../lib/sites.ts";
import { rangePredicate, filterClauses, dimExpr, type BuildContext } from "./build.ts";
import { addDays } from "../lib/time.ts";
import { compareRange, resolveRange, type DayRange } from "./range.ts";
import { runQuery, firstDay, planQuery, resolveFilterGoals, runMerged, type QueryResult } from "./run.ts";
import { q, type Common } from "./presets.ts";
import type { Filter, GoalMatch } from "./schema.ts";

const MAX_ROWS = 250_000;

interface EvRow {
  session_id: string;
  ts: number;
  type: string;
  pathname: string | null;
  name: string | null;
  props_json: string | null;
  url: string | null;
  grp?: string | null;
}

async function ctxFor(db: D1Database, site: Site, c: Common, now?: number): Promise<BuildContext> {
  const first = c.date_range === "all" ? await firstDay(db, site.id) : null;
  const range = resolveRange(c.date_range ?? "28d", site.timezone, now, first);
  const forcedFilters = site.forcedFilters as Filter[] | undefined;
  return { siteId: site.id, timeZone: site.timezone, tzMode: c.timezone ?? "site", range, goals: await resolveFilterGoals(db, site.id, [...((c.filters ?? []) as Filter[]), ...(forcedFilters ?? [])]), forcedFilters };
}


export function matchStep(step: GoalMatch, e: Pick<EvRow, "type" | "pathname" | "name" | "props_json" | "url">): boolean {
  switch (step.kind) {
    case "pageview":
      return e.type === "pageview" && pathMatches(step.path ?? "/", e.pathname ?? "");
    case "event": {
      if (e.type !== "event" || e.name !== step.event) return false;
      if (!step.prop) return true;
      try {
        return (JSON.parse(e.props_json ?? "{}") as Record<string, unknown>)[step.prop.key] === step.prop.value;
      } catch {
        return false;
      }
    }
    case "outbound": {
      if (e.type !== "outbound") return false;
      const hosts = (step.host ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      return !hosts.length || hosts.some((h) => (e.url ?? "").includes(h));
    }
  }
}

/** Session dimensions a funnel can be broken down by. */
export const FUNNEL_BREAKDOWNS = ["channel", "device", "country", "browser", "os", "referrer_host", "utm_source", "utm_medium", "utm_campaign", "utm_content", "entry_page"] as const;

async function loadEvents(db: D1Database, ctx: BuildContext, filters: Filter[], extra = "", groupBy?: string): Promise<EvRow[]> {
  const r = rangePredicate(ctx);
  const f = filterClauses(ctx, filters);
  const g = groupBy ? dimExpr(groupBy, ctx.tzMode) : null;
  const { results } = await db
    .prepare(
      `SELECT e.session_id, e.ts, e.type, e.pathname, e.name, e.props_json, e.url${g ? `, ${g.expr} AS grp` : ""}
       FROM events e LEFT JOIN sessions s ON s.id = e.session_id
       WHERE e.site_id = ? AND ${r.sql} AND e.type IN ('pageview', 'event', 'outbound') AND ${f.sql} ${extra}
       ORDER BY e.session_id, e.ts LIMIT ${MAX_ROWS}`,
    )
    .bind(...(g?.params ?? []), ctx.siteId, ...r.params, ...f.params)
    .all<EvRow>();
  return results;
}

function* bySession(rows: EvRow[]): Generator<EvRow[]> {
  let cur: EvRow[] = [];
  let id: string | null = null;
  for (const r of rows) {
    if (r.session_id !== id) {
      if (cur.length) yield cur;
      cur = [];
      id = r.session_id;
    }
    cur.push(r);
  }
  if (cur.length) yield cur;
}

export interface FunnelSpec {
  steps: { name?: string; match: GoalMatch }[];
  window_minutes: number;
  /** flexible (default): other events may come between steps. strict: any other pageview in between ends the run. */
  step_order?: "flexible" | "strict";
}

/** How far one session gets: the deepest step index reached (-1 = none) and the time of each step. */
function sessionDepth(evs: EvRow[], spec: FunnelSpec): { best: number; times: number[] } {
  const n = spec.steps.length;
  const strict = spec.step_order === "strict";
  let best = -1;
  let bestTimes: number[] = [];
  // Try each occurrence of step 0 as a start; keep the deepest progression.
  for (let i = 0; i < evs.length; i++) {
    if (!matchStep(spec.steps[0]!.match, evs[i]!)) continue;
    const times = [evs[i]!.ts];
    let k = 1;
    for (let j = i + 1; j < evs.length && k < n; j++) {
      if (evs[j]!.ts - times[0]! > spec.window_minutes * 60_000) break;
      if (matchStep(spec.steps[k]!.match, evs[j]!)) {
        times.push(evs[j]!.ts);
        k++;
      } else if (strict && evs[j]!.type === "pageview" && !matchStep(spec.steps[k - 1]!.match, evs[j]!)) break;
    }
    if (k - 1 > best) {
      best = k - 1;
      bestTimes = times;
    }
    if (best === n - 1) break;
  }
  return { best, times: bestTimes };
}

/** Ordered funnel within one session; each step must happen within `window_minutes` of the first step. */
export function computeFunnel(rows: EvRow[], spec: FunnelSpec) {
  const n = spec.steps.length;
  const reached = new Array<number>(n).fill(0);
  const gaps: number[][] = Array.from({ length: n }, () => []);
  for (const evs of bySession(rows)) {
    const { best, times: bestTimes } = sessionDepth(evs, spec);
    for (let s = 0; s <= best; s++) {
      reached[s]!++;
      if (s > 0) gaps[s]!.push(bestTimes[s]! - bestTimes[s - 1]!);
    }
  }
  const median = (a: number[]) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return Math.round(s[Math.floor((s.length - 1) / 2)]! / 1000);
  };
  return spec.steps.map((st, i) => ({
    step: i + 1,
    name: st.name ?? describeMatch(st.match),
    sessions: reached[i]!,
    conversion_from_start_pct: reached[0] ? Math.round((1000 * reached[i]!) / reached[0]) / 10 : 0,
    conversion_from_previous_pct: i === 0 ? 100 : reached[i - 1] ? Math.round((1000 * reached[i]!) / reached[i - 1]!) / 10 : 0,
    drop_off: i === 0 ? 0 : reached[i - 1]! - reached[i]!,
    median_seconds_from_previous: i === 0 ? null : median(gaps[i]!),
  }));
}

export function describeMatch(m: GoalMatch): string {
  if (m.kind === "pageview") return `Visit ${m.path}`;
  if (m.kind === "event") return `Event ${m.event}${m.prop ? ` (${m.prop.key}=${m.prop.value})` : ""}`;
  return `Outbound ${m.host ?? "any"}`;
}

/** Sessions reaching each step, per value of a session dimension (top values by sessions at step 1). */
export function funnelBreakdown(rows: EvRow[], spec: FunnelSpec, limit = 8) {
  const n = spec.steps.length;
  const groups = new Map<string, number[]>();
  for (const evs of bySession(rows)) {
    const { best } = sessionDepth(evs, spec);
    if (best < 0) continue;
    const key = evs[0]!.grp === null || evs[0]!.grp === undefined || evs[0]!.grp === "" ? "(none)" : String(evs[0]!.grp);
    const counts = groups.get(key) ?? new Array<number>(n).fill(0);
    for (let s = 0; s <= best; s++) counts[s]!++;
    groups.set(key, counts);
  }
  return [...groups]
    .map(([value, sessions]) => ({ value, sessions, conversion_pct: sessions[0] ? Math.round((1000 * sessions[n - 1]!) / sessions[0]) / 10 : 0 }))
    .sort((a, b) => b.sessions[0]! - a.sessions[0]!)
    .slice(0, limit);
}

export async function funnel(db: D1Database, site: Site, c: Common & FunnelSpec & { breakdown?: (typeof FUNNEL_BREAKDOWNS)[number] }, now?: number) {
  const ctx = await ctxFor(db, site, c, now);
  const filters = (c.filters ?? []) as Filter[];
  const rows = await loadEvents(db, ctx, filters, "", c.breakdown);
  let comparison = null;
  if (c.compare) {
    const cr = compareRange(ctx.range, c.compare, c.timezone === "UTC" ? "UTC" : site.timezone, now);
    const prev = await loadEvents(db, { ...ctx, range: cr }, filters);
    comparison = { date_range: cr, steps: computeFunnel(prev, c) };
  }
  return {
    meta: { site: site.id, date_range: ctx.range, timezone: site.timezone, generated_at: new Date().toISOString(), truncated: rows.length >= MAX_ROWS },
    window_minutes: c.window_minutes,
    step_order: c.step_order ?? "flexible",
    steps: computeFunnel(rows, c),
    comparison,
    ...(c.breakdown ? { breakdown: { dimension: c.breakdown, rows: funnelBreakdown(rows, c) } } : {}),
  };
}

export async function paths(
  db: D1Database,
  site: Site,
  c: Common & { from: string; direction: "next" | "previous"; depth: number; limit?: number },
  now?: number,
) {
  const ctx = await ctxFor(db, site, c, now);
  const rows = (await loadEvents(db, ctx, (c.filters ?? []) as Filter[], "AND e.type = 'pageview'"));
  const counts = new Map<string, number>();
  let occurrences = 0;
  for (const evs of bySession(rows)) {
    const seq = evs.map((e) => e.pathname ?? "");
    // collapse consecutive reloads
    const s = seq.filter((p, i) => i === 0 || p !== seq[i - 1]);
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== c.from) continue;
      occurrences++;
      const part = c.direction === "next" ? s.slice(i + 1, i + 1 + c.depth) : s.slice(Math.max(0, i - c.depth), i).reverse();
      const key = part.length ? part.join(" → ") : c.direction === "next" ? "(exit)" : "(entrance)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const out = [...counts].map(([path, n]) => ({ path, count: n, share_pct: occurrences ? Math.round((1000 * n) / occurrences) / 10 : 0 }));
  out.sort((a, b) => b.count - a.count);
  return {
    meta: { site: site.id, date_range: ctx.range, timezone: site.timezone, generated_at: new Date().toISOString() },
    from: c.from,
    direction: c.direction,
    depth: c.depth,
    occurrences,
    paths: out.slice(0, c.limit ?? 25),
  };
}

/**
 * Weekly cohorts by first-seen week. Visitor ids rotate daily, so "returning" means a visitor with
 * more than one session on the same day. This is a documented limit of cookieless analytics.
 */
export async function retention(db: D1Database, site: Site, c: Common, now?: number) {
  const ctx = await ctxFor(db, site, c, now);
  const { results } = await db
    .prepare(
      `WITH v AS (
         SELECT local_day, visitor_id, COUNT(*) AS n FROM sessions
         WHERE site_id = ? AND local_day BETWEEN ? AND ? AND pageviews > 0
         GROUP BY local_day, visitor_id
       )
       SELECT date(local_day, '-6 days', 'weekday 1') AS week,
              COUNT(*) AS visitor_days,
              SUM(n > 1) AS returning_same_day,
              ROUND(100.0 * SUM(n > 1) / COUNT(*), 1) AS return_rate_pct,
              ROUND(AVG(n), 2) AS sessions_per_visitor_day
       FROM v GROUP BY week ORDER BY week`,
    )
    .bind(site.id, ctx.range.from, ctx.range.to)
    .all();
  return {
    meta: { site: site.id, date_range: ctx.range, timezone: site.timezone, generated_at: new Date().toISOString() },
    caveat: "Visitor ids rotate every day (no cookies), so retention is measured as returning within the same day only.",
    cohorts: results,
  };
}

const THRESH = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] } as const;

export async function vitals(db: D1Database, site: Site, c: Common & { dimension?: "page" | "device" | "page,device" }, now?: number) {
  const ctx = await ctxFor(db, site, c, now);
  const dims = (c.dimension ?? "page").split(",");
  const p75 = await runQuery(
    db,
    site,
    q({ date_range: { from: ctx.range.from, to: ctx.range.to }, timezone: c.timezone, filters: c.filters ?? [], metrics: ["lcp_p75", "inp_p75", "cls_p75", "pageviews"], dimensions: dims, limit: 200 }),
    now,
  );
  const r = rangePredicate(ctx);
  const f = filterClauses(ctx, (c.filters ?? []) as Filter[]);
  const share = (col: "lcp" | "inp" | "cls") =>
    `SUM(e.${col} IS NOT NULL) AS ${col}_n, SUM(e.${col} <= ${THRESH[col][0]}) AS ${col}_good, SUM(e.${col} > ${THRESH[col][0]} AND e.${col} <= ${THRESH[col][1]}) AS ${col}_ni, SUM(e.${col} > ${THRESH[col][1]}) AS ${col}_poor`;
  const totals = await db
    .prepare(`SELECT ${share("lcp")}, ${share("inp")}, ${share("cls")} FROM events e LEFT JOIN sessions s ON s.id = e.session_id WHERE e.site_id = ? AND ${r.sql} AND e.type = 'vitals' AND ${f.sql}`)
    .bind(site.id, ...r.params, ...f.params)
    .first<Record<string, number>>();
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const shares = Object.fromEntries(
    (["lcp", "inp", "cls"] as const).map((m) => [
      m,
      { samples: totals?.[`${m}_n`] ?? 0, good_pct: pct(totals?.[`${m}_good`] ?? 0, totals?.[`${m}_n`] ?? 0), needs_improvement_pct: pct(totals?.[`${m}_ni`] ?? 0, totals?.[`${m}_n`] ?? 0), poor_pct: pct(totals?.[`${m}_poor`] ?? 0, totals?.[`${m}_n`] ?? 0) },
    ]),
  );
  return {
    meta: p75.meta,
    thresholds: { lcp_ms: THRESH.lcp, inp_ms: THRESH.inp, cls: THRESH.cls },
    p75: p75.totals,
    shares,
    rows: p75.rows.filter((x) => x.lcp_p75 !== null || x.inp_p75 !== null || x.cls_p75 !== null),
  };
}

export async function errors(db: D1Database, site: Site, c: Common & { limit?: number }, now?: number) {
  const ctx = await ctxFor(db, site, c, now);
  const r = rangePredicate(ctx);
  const f = filterClauses(ctx, (c.filters ?? []) as Filter[]);
  const where = `FROM events e LEFT JOIN sessions s ON s.id = e.session_id WHERE e.site_id = ? AND ${r.sql} AND e.type = 'error' AND ${f.sql}`;
  const params = [site.id, ...r.params, ...f.params];
  const [groups, days] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT e.name AS message, json_extract(e.props_json, '$.source') AS source, COUNT(*) AS occurrences,
                COUNT(DISTINCT e.session_id) AS sessions, COUNT(DISTINCT e.pathname) AS pages,
                MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen
         ${where} GROUP BY 1, 2 ORDER BY occurrences DESC LIMIT ?`,
      )
      .bind(...params, c.limit ?? 50),
    db.prepare(`SELECT e.name AS message, json_extract(e.props_json, '$.source') AS source, e.local_day AS day, COUNT(*) AS n ${where} GROUP BY 1, 2, 3`).bind(...params),
  ]);
  // Daily occurrences per group, every day of the range (zeros included) so sparklines keep their shape.
  const counts = new Map<string, Map<string, number>>();
  for (const d of days!.results) {
    const k = `${String(d.message)}\u0000${String(d.source)}`;
    counts.set(k, (counts.get(k) ?? new Map()).set(String(d.day), Number(d.n)));
  }
  const allDays: string[] = [];
  for (let d = ctx.range.from; d <= ctx.range.to && allDays.length < 400; d = addDays(d, 1)) allDays.push(d);
  const daily = new Map([...counts].map(([k, m]) => [k, allDays.map((day) => ({ day, n: m.get(day) ?? 0 }))]));
  return {
    meta: { site: site.id, date_range: ctx.range, timezone: site.timezone, generated_at: new Date().toISOString(), errors_enabled: site.settings.features.errors },
    groups: (groups!.results as { message: string; source: string | null; occurrences: number; sessions: number; pages: number; first_seen: number; last_seen: number }[]).map((g) => ({ ...g, daily: (daily.get(`${String(g.message)}\u0000${String(g.source)}`) ?? []).sort((a, b) => a.day.localeCompare(b.day)) })),
  };
}

export async function pageReport(db: D1Database, site: Site, c: Common & { path: string }, now?: number) {
  const pageFilter: Filter = ["is", "page", [c.path]];
  const base = { date_range: c.date_range, timezone: c.timezone, compare: c.compare ?? "previous_period" };
  const filters = [...((c.filters ?? []) as Filter[]), pageFilter];
  const [kpi, sources, devices, entryExit, next, prev, vit] = await Promise.all([
    runQuery(db, site, q({ ...base, filters, metrics: ["pageviews", "visitors", "entries", "exits", "exit_rate", "avg_engaged_time", "scroll_depth"] }), now),
    runQuery(db, site, q({ ...base, compare: null, filters, metrics: ["visitors"], dimensions: ["channel"], limit: 10 }), now),
    runQuery(db, site, q({ ...base, compare: null, filters, metrics: ["visitors"], dimensions: ["device"], limit: 5 }), now),
    runQuery(db, site, q({ ...base, compare: null, filters: c.filters ?? [], metrics: ["sessions", "bounce_rate"], dimensions: ["entry_page"], limit: 1000 }), now),
    paths(db, site, { ...c, from: c.path, direction: "next", depth: 1, limit: 10 }, now),
    paths(db, site, { ...c, from: c.path, direction: "previous", depth: 1, limit: 10 }, now),
    runQuery(db, site, q({ ...base, compare: null, filters, metrics: ["lcp_p75", "inp_p75", "cls_p75"] }), now),
  ]);
  const asEntry = entryExit.rows.find((r) => r.entry_page === c.path);
  return {
    meta: kpi.meta,
    path: c.path,
    totals: kpi.totals,
    comparison: kpi.comparison ? { date_range: kpi.comparison.date_range, totals: kpi.comparison.totals } : null,
    as_landing_page: asEntry ? { sessions: asEntry.sessions, bounce_rate: asEntry.bounce_rate } : null,
    channels: sources.rows,
    devices: devices.rows,
    next_pages: next.paths,
    previous_pages: prev.paths,
    vitals_p75: vit.totals,
  };
}

export type { DayRange };

/** Property keys seen on custom events (optionally one event), with how often each appears. */
export async function propertyKeys(db: D1Database, site: Site, c: Common & { event?: string }, now?: number) {
  const ctx = await ctxFor(db, site, c, now);
  const r = rangePredicate(ctx);
  const f = filterClauses(ctx, (c.filters ?? []) as Filter[]);
  const { results } = await db
    .prepare(
      `SELECT j.key AS key, COUNT(*) AS events, COUNT(DISTINCT e.name) AS event_names
       FROM (SELECT e.name, e.props_json FROM events e LEFT JOIN sessions s ON s.id = e.session_id WHERE e.site_id = ? AND ${r.sql} AND e.type = 'event' AND e.props_json IS NOT NULL ${c.event ? "AND e.name = ?" : ""} AND ${f.sql} LIMIT 50000) e, json_each(e.props_json) j
       GROUP BY j.key ORDER BY events DESC LIMIT 100`,
    )
    .bind(site.id, ...r.params, ...(c.event ? [c.event] : []), ...f.params)
    .all<{ key: string; events: number; event_names: number }>();
  return { meta: { site: site.id, date_range: ctx.range, generated_at: new Date().toISOString() }, event: c.event ?? null, keys: results };
}

/** Recent sessions (anonymous, same-day by construction), newest first, matching the filters. */
export async function listSessions(db: D1Database, site: Site, c: Common & { limit?: number; before?: number }, now?: number) {
  const ctx = await ctxFor(db, site, c, now);
  const r = rangePredicate(ctx);
  const f = filterClauses(ctx, (c.filters ?? []) as Filter[]);
  const limit = Math.min(c.limit ?? 50, 100);
  const { results } = await db
    .prepare(
      `SELECT s.id, s.started_at, s.last_seen_at, s.entry_path, s.exit_path, s.pageviews, s.events, s.engaged_ms, s.duration_ms, s.bounced,
              s.channel, s.referrer_host, s.utm_campaign, s.country, s.city, s.device, s.browser, s.os, s.source
       FROM sessions s
       WHERE s.site_id = ? AND s.id IN (SELECT e.session_id FROM events e LEFT JOIN sessions s ON s.id = e.session_id WHERE e.site_id = ? AND ${r.sql} AND ${f.sql})
         ${c.before ? "AND s.started_at < ?" : ""}
       ORDER BY s.started_at DESC LIMIT ?`,
    )
    .bind(site.id, site.id, ...r.params, ...f.params, ...(c.before ? [c.before] : []), limit)
    .all<Record<string, string | number | null>>();
  const rows = results.map((x) => ({ ...x, started_at: new Date(Number(x.started_at)).toISOString(), last_seen_at: new Date(Number(x.last_seen_at)).toISOString(), bounced: !!x.bounced }));
  const last = results[results.length - 1];
  return { meta: { site: site.id, date_range: ctx.range, generated_at: new Date().toISOString() }, sessions: rows, next_before: results.length === limit && last ? Number(last.started_at) : null };
}

/** One session's hits in order. */
export async function sessionDetail(db: D1Database, site: Site, id: string) {
  const s = await db.prepare("SELECT * FROM sessions WHERE id = ? AND site_id = ?").bind(id, site.id).first<Record<string, unknown>>();
  if (!s) return null;
  const { results } = await db
    .prepare("SELECT ts, type, pathname, title, name, props_json, url, engaged_ms, scroll_pct FROM events WHERE session_id = ? AND site_id = ? ORDER BY ts LIMIT 500")
    .bind(id, site.id)
    .all<Record<string, unknown>>();
  const { visitor_id: _v, ...session } = s;
  return {
    session: { ...session, started_at: new Date(Number(s.started_at)).toISOString(), last_seen_at: new Date(Number(s.last_seen_at)).toISOString() },
    events: results.map((e) => ({ ...e, ts: new Date(Number(e.ts)).toISOString(), props: e.props_json ? JSON.parse(String(e.props_json)) : null, props_json: undefined })),
  };
}

export interface Insight {
  kind: string;
  /** Stable id of the finding (traffic_up, page_gaining…), so clients can word it in their own language. */
  code: string;
  /** The values the title and detail are written from. */
  params: Record<string, number | string>;
  title: string;
  detail: string;
  numbers: Record<string, number | string | null>;
}

/** Rule-based findings for a range, every number from the query engine. */
export async function insights(db: D1Database, site: Site, c: Common, now?: number): Promise<{ meta: unknown; insights: Insight[] }> {
  const { moversFrom, moversQuery } = await import("./presets.ts");
  const base = { ...c, compare: c.compare ?? "previous_period" } as Common;
  const goalsRes = await db.prepare("SELECT id, name, kind, definition_json FROM goals WHERE site_id = ?").bind(site.id).all<{ id: string; name: string; kind: GoalMatch["kind"]; definition_json: string }>();
  const goals = Object.fromEntries(goalsRes.results.map((g) => [g.id, { ...(JSON.parse(g.definition_json) as Omit<GoalMatch, "kind">), kind: g.kind }]));
  // Every query of the findings as one merged D1 statement (run.ts runMerged).
  const plans = await Promise.all([
    planQuery(db, site, q({ date_range: base.date_range, timezone: base.timezone, filters: base.filters ?? [], compare: base.compare, metrics: ["visitors", "pageviews", "bounce_rate"] }), now),
    planQuery(db, site, moversQuery({ ...base, dimension: "page", metric: "visitors" }), now, { rawComparison: true }),
    planQuery(db, site, moversQuery({ ...base, dimension: "referrer_host", metric: "visitors" }), now, { rawComparison: true }),
    planQuery(db, site, q({ date_range: base.date_range, timezone: base.timezone, filters: base.filters ?? [], compare: base.compare, metrics: ["lcp_p75", "inp_p75"] }), now),
    ...goalsRes.results.map((g) => planQuery(db, site, q({ date_range: base.date_range, timezone: base.timezone, filters: base.filters ?? [], compare: base.compare, metrics: ["conversions"], goal: g.id }), now, { goals })),
  ]);
  const { results } = await runMerged(db, plans);
  const [kpi, pageRows, refRows, vit] = results as [QueryResult, QueryResult, QueryResult, QueryResult];
  const pages = moversFrom(pageRows, { dimension: "page", metric: "visitors", limit: 3 });
  const refs = moversFrom(refRows, { dimension: "referrer_host", metric: "visitors", limit: 5 });
  const out: Insight[] = [];
  const v = Number(kpi.totals.visitors ?? 0);
  const pv = Number(kpi.comparison?.totals.visitors ?? 0);
  if (pv >= 10 && Math.abs(v - pv) / pv >= 0.15)
    out.push({ kind: "traffic", code: v > pv ? "traffic_up" : "traffic_down", params: { pct: Math.round((Math.abs(v - pv) / pv) * 100), current: v, previous: pv }, title: `Visitors ${v > pv ? "up" : "down"} ${Math.round((Math.abs(v - pv) / pv) * 100)}%`, detail: `${v} visitors against ${pv} in the previous period.`, numbers: { current: v, previous: pv } });
  for (const g of pages.gainers.slice(0, 1)) if (g.change >= 5) out.push({ kind: "page", code: "page_gaining", params: { page: String(g.value), change: g.change, previous: g.previous, current: g.current }, title: `${g.value} is gaining`, detail: `+${g.change} visitors (${g.previous} → ${g.current}).`, numbers: { current: g.current, previous: g.previous } });
  for (const l of pages.losers.slice(0, 1)) if (l.change <= -5) out.push({ kind: "page", code: "page_losing", params: { page: String(l.value), change: l.change, previous: l.previous, current: l.current }, title: `${l.value} is losing visitors`, detail: `${l.change} visitors (${l.previous} → ${l.current}).`, numbers: { current: l.current, previous: l.previous } });
  for (const r of refs.gainers) if (r.previous === 0 && r.current >= 3 && r.value) out.push({ kind: "referrer", code: "new_referrer", params: { host: String(r.value), current: r.current }, title: `New referrer: ${r.value}`, detail: `${r.current} visitors from a site that sent none in the previous period.`, numbers: { current: r.current } });
  const lcp = Number(vit.totals.lcp_p75 ?? 0);
  const plcp = Number(vit.comparison?.totals.lcp_p75 ?? 0);
  if (lcp > 2500 && plcp && lcp > plcp * 1.2) out.push({ kind: "vitals", code: "lcp_slower", params: { current: Math.round(lcp), previous: Math.round(plcp) }, title: "Pages got slower", detail: `LCP p75 is ${Math.round(lcp)} ms, up from ${Math.round(plcp)} ms.`, numbers: { current: lcp, previous: plcp } });
  const inp = Number(vit.totals.inp_p75 ?? 0);
  if (inp > 500) out.push({ kind: "vitals", code: "inp_slow", params: { current: Math.round(inp) }, title: "Interactions feel slow", detail: `INP p75 is ${Math.round(inp)} ms (poor above 500 ms).`, numbers: { current: inp } });
  const goalRuns = results.slice(4);
  for (const [i, g] of goalsRes.results.entries()) {
    const r = goalRuns[i]!;
    const cur = Number(r.totals.conversions ?? 0);
    const prev = Number(r.comparison?.totals.conversions ?? 0);
    if (prev >= 5 && Math.abs(cur - prev) / prev >= 0.25) out.push({ kind: "goal", code: cur > prev ? "goal_up" : "goal_down", params: { goal: g.name, pct: Math.round((Math.abs(cur - prev) / prev) * 100), current: cur, previous: prev }, title: `${g.name} ${cur > prev ? "up" : "down"} ${Math.round((Math.abs(cur - prev) / prev) * 100)}%`, detail: `${cur} conversions against ${prev}.`, numbers: { current: cur, previous: prev } });
  }
  return { meta: kpi.meta, insights: out };
}

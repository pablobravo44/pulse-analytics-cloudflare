// Thin presets over runQuery so REST, MCP and the dashboard always agree.
import { AI_HOSTS } from "../lib/channels.ts";
import type { Site } from "../lib/sites.ts";
import { addDays, localParts, startOfLocalDay } from "../lib/time.ts";
import { daySpanMs, notComparable, type AnnotationRow } from "../lib/annotations.ts";
import { compareRange } from "./range.ts";
import { COUNT_METRICS, planQuery, runMerged, runQuery, type QueryResult, type Row } from "./run.ts";
import type { DayRange } from "./range.ts";
import { resolveRange } from "./range.ts";
import { querySchema, type Filter, type GoalMatch, type Metric, type QueryInput } from "./schema.ts";

export type Common = Pick<QueryInput, "date_range" | "timezone" | "compare" | "filters">;

const KPI: Metric[] = ["visitors", "sessions", "pageviews", "views_per_session", "bounce_rate", "avg_session_duration", "avg_engaged_time", "events"];

function delta(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

export function q(input: QueryInput) {
  return querySchema.parse(input);
}

export async function summary(db: D1Database, site: Site, c: Common, now = Date.now()) {
  const base = { date_range: c.date_range, timezone: c.timezone, filters: c.filters ?? [] };
  const compare = c.compare === undefined ? "previous_period" : c.compare;
  const goals = (await db.prepare("SELECT id, name, kind, definition_json FROM goals WHERE site_id = ? ORDER BY name").bind(site.id).all<{ id: string; name: string; kind: GoalMatch["kind"]; definition_json: string }>()).results;
  const goalMatch = Object.fromEntries(goals.map((g) => [g.id, { ...(JSON.parse(g.definition_json) as Omit<GoalMatch, "kind">), kind: g.kind }]));
  const plan = (input: QueryInput) => planQuery(db, site, q(input), now, { goals: goalMatch, noTotals: !!input.dimensions?.length });
  // Every query of the summary as one merged D1 statement. Referrers: the top 6 including direct, then direct dropped,
  // is the same top 5 as filtering direct out first (the filter is on the dimension itself), and stays on the rollups.
  const plans = await Promise.all([
    plan({ ...base, metrics: KPI, compare }),
    plan({ ...base, metrics: ["visitors", "pageviews"], dimensions: ["page"], limit: 5, order_by: ["pageviews", "desc"] }),
    plan({ ...base, metrics: ["visitors", "sessions"], dimensions: ["channel"], limit: 5 }),
    plan({ ...base, metrics: ["visitors", "sessions"], dimensions: ["referrer_host"], limit: 6 }),
    plan({ ...base, metrics: ["visitors"], dimensions: ["country"], limit: 5 }),
    plan({ ...base, metrics: ["visitors"], dimensions: ["device"], limit: 5 }),
    ...goals.map((g) => plan({ ...base, metrics: ["conversions", "conversion_rate"], goal: g.id })),
  ]);
  const range = resolveRange((c.date_range ?? "28d") as never, site.timezone, now, "2000-01-01");
  const cmp = compare ? compareRange(range, compare, site.timezone, now) : null;
  const span = daySpanMs(cmp && cmp.from < range.from ? cmp.from : range.from, range.to);
  const ann = db.prepare("SELECT id, site_id, ts, title, body, url, category, affects FROM annotations WHERE (site_id = ? OR site_id IS NULL) AND ts BETWEEN ? AND ? AND affects IS NOT NULL").bind(site.id, span.from, span.to);
  const { results, extra } = await runMerged(db, plans, [ann]);
  const [kpi, pages, channels, refs, countries, devices] = results as [QueryResult, QueryResult, QueryResult, QueryResult, QueryResult, QueryResult];
  const referrers = refs.rows.filter((r) => r.referrer_host !== null).slice(0, 5);
  // Data-quality annotations between the two periods hide the change of the metrics they affect.
  const blocked = kpi.comparison ? notComparable(extra[0]!.results as unknown as AnnotationRow[], startOfLocalDay(kpi.comparison.date_range.from, site.timezone), Math.min(now, startOfLocalDay(range.to, site.timezone) + 86_400_000)) : new Map();
  const kpis = Object.fromEntries(
    KPI.map((m) => {
      const note = blocked.get(m);
      return [m, { value: kpi.totals[m] ?? null, previous: kpi.comparison?.totals[m] ?? null, change_pct: note ? null : delta(kpi.totals[m] as number, kpi.comparison?.totals[m] as number), ...(note ? { not_comparable: note } : {}) }];
    }),
  );
  const goalStats = goals.map((g, i) => {
    const r = results[6 + i]!;
    return { id: g.id, name: g.name, kind: g.kind, conversions: r.totals.conversions ?? 0, conversion_rate: r.totals.conversion_rate ?? 0 };
  });
  const v = kpis.visitors as { value: number | null; change_pct: number | null };
  const sentence = `${v.value ?? 0} visitors${v.change_pct != null ? ` (${v.change_pct >= 0 ? "+" : ""}${v.change_pct}% vs previous period)` : ""}, ${kpi.totals.pageviews ?? 0} pageviews; top page ${pages.rows[0]?.page ?? "n/a"}, top channel ${channels.rows[0]?.channel ?? "n/a"}.`;
  return {
    meta: { ...kpi.meta, comparison_range: kpi.comparison?.date_range ?? null },
    summary: sentence,
    kpis,
    top: { pages: pages.rows, channels: channels.rows, referrers, countries: countries.rows, devices: devices.rows },
    goals: goalStats,
  };
}

export async function timeseries(
  db: D1Database,
  site: Site,
  c: Common & { metrics: Metric[]; interval: "hour" | "day" | "week" | "month" },
  now?: number,
) {
  const range = resolveRange((c.date_range ?? "28d") as never, site.timezone, now);
  const dim = c.interval === "hour" && range.from !== range.to ? "datehour" : c.interval;
  const r = await runQuery(
    db,
    site,
    q({ date_range: c.date_range, timezone: c.timezone, filters: c.filters ?? [], compare: c.compare ?? null, metrics: c.metrics, dimensions: [dim], limit: 1000 }),
    now,
  );
  const s = seriesOf(r, dim, c.metrics);
  return { meta: r.meta, interval: dim, series: s.series, comparison: r.comparison ? { date_range: r.comparison.date_range, totals: r.comparison.totals, series: s.comparison! } : null, totals: r.totals };
}

/** Every interval key of a period, in order: days, local hours of one day, "day HH" hours, Monday weeks or months. */
export function intervalKeys(range: DayRange, interval: string, now: number, timeZone: string): (string | number)[] {
  const out: (string | number)[] = [];
  const today = localParts(now, timeZone);
  const lastHour = (day: string) => (day === today.day ? today.hour : day > today.day ? -1 : 23);
  const days: string[] = [];
  for (let d = range.from; d <= range.to && days.length < 4000; d = addDays(d, 1)) days.push(d);
  switch (interval) {
    case "day":
      return days;
    case "hour":
      for (let h = 0; h <= lastHour(range.to); h++) out.push(h);
      return out;
    case "datehour":
      for (const d of days) for (let h = 0; h <= lastHour(d) && out.length < 4000; h++) out.push(`${d} ${String(h).padStart(2, "0")}`);
      return out;
    case "week": {
      const monday = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
      for (let w = monday(range.from); w <= range.to && out.length < 600; w = addDays(w, 7)) out.push(w);
      return out;
    }
    case "month":
      for (let m = range.from.slice(0, 7); m <= range.to.slice(0, 7) && out.length < 200; ) {
        out.push(m);
        const [y, mm] = m.split("-").map(Number) as [number, number];
        m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
      }
      return out;
    default:
      return [];
  }
}

/** A row for an interval with nothing in it: counts 0, rates and averages null. */
function emptyRow(interval: string, key: string | number | null, metrics: Metric[]): Row {
  return { [interval]: key, ...Object.fromEntries(metrics.map((m) => [m, COUNT_METRICS.has(m) ? 0 : null])) };
}

/** Fill every interval of the period so charts don't skip gaps (rows whose key isn't an interval are kept as they are). */
export function fillSeries(r: QueryResult, interval: string, metrics: Metric[]): Row[] {
  const keys = intervalKeys(r.meta.date_range, interval, Date.parse(r.meta.generated_at), r.meta.timezone);
  if (!keys.length) return r.rows;
  const byKey = new Map(r.rows.map((x) => [x[interval], x]));
  return keys.map((k) => byKey.get(k) ?? emptyRow(interval, k, metrics));
}

/**
 * The series and its comparison, both filled, the comparison aligned by position: row i of the comparison is the
 * i-th interval of the previous period (its own date), so a missing day never shifts the line.
 */
export function seriesOf(r: QueryResult, interval: string, metrics: Metric[]): { series: Row[]; comparison: Row[] | null } {
  const series = fillSeries(r, interval, metrics);
  if (!r.comparison) return { series, comparison: null };
  const prev = fillSeries({ ...r, rows: r.comparison.rows, meta: { ...r.meta, date_range: r.comparison.date_range } }, interval, metrics);
  return { series, comparison: series.map((_, i) => prev[i] ?? emptyRow(interval, null, metrics)) };
}

export async function breakdown(
  db: D1Database,
  site: Site,
  c: Common & { dimension: string; metrics: Metric[]; limit?: number; cursor?: string; search?: string },
  now?: number,
) {
  // `search` narrows the values (value suggestions in filter builders): a contains filter on the dimension itself.
  const filters = c.search ? [...(c.filters ?? []), ["contains", c.dimension, [c.search]] as Filter] : (c.filters ?? []);
  const r = await runQuery(
    db,
    site,
    q({ date_range: c.date_range, timezone: c.timezone, filters, compare: c.compare ?? null, metrics: c.metrics, dimensions: [c.dimension], limit: c.limit ?? 50, cursor: c.cursor }),
    now,
  );
  return { meta: r.meta, dimension: c.dimension, rows: r.rows, totals: r.totals, comparison: r.comparison, next_cursor: r.next_cursor };
}

export async function realtime(db: D1Database, site: Site, now = Date.now()) {
  const since5 = now - 5 * 60_000;
  const since30 = now - 30 * 60_000;
  // `+type` keeps SQLite on the (site_id, ts) index: the (site_id, type, local_day) one would read every pageview of the site.
  const [pages, sources, perMin, recent] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT pathname AS page, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE site_id = ? AND ts >= ? AND +type = 'pageview' GROUP BY pathname ORDER BY visitors DESC LIMIT 10")
      .bind(site.id, since5),
    db
      .prepare(
        "SELECT COALESCE(s.referrer_host, '(direct)') AS source, s.channel AS channel, COUNT(DISTINCT e.visitor_id) AS visitors FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.site_id = ? AND e.ts >= ? GROUP BY 1, 2 ORDER BY visitors DESC LIMIT 10",
      )
      .bind(site.id, since5),
    db
      .prepare("SELECT CAST((ts - ?) / 60000 AS INTEGER) AS minute, COUNT(*) AS hits FROM events WHERE site_id = ? AND ts >= ? GROUP BY minute ORDER BY minute")
      .bind(since30, site.id, since30),
    // The live feed: what happened, where and when. No visitor or session ids.
    db
      .prepare("SELECT ts, type, pathname AS page, name FROM events WHERE site_id = ? AND ts >= ? AND +type IN ('pageview', 'event', 'outbound', 'download') ORDER BY ts DESC LIMIT 25")
      .bind(site.id, since30),
  ]);
  const mins = new Map(perMin!.results.map((r) => [Number(r.minute), Number(r.hits)]));
  // The count and the visit list share one rule (a visit is on the site when it had a hit in the last 5 minutes).
  const { liveVisits } = await import("./live.ts");
  const live = await liveVisits(db, [site], now, 30);
  return {
    meta: { site: site.id, timezone: site.timezone, generated_at: new Date(now).toISOString(), window_minutes: 5 },
    visitors: live.per_site[0]?.visitors ?? 0,
    visits: live.visits.map(({ site: _s, ...v }) => v),
    pages: pages!.results,
    sources: sources!.results,
    hits_per_minute: Array.from({ length: 30 }, (_, i) => ({ minute_ago: 29 - i, hits: mins.get(i) ?? 0 })),
    recent: recent!.results.map((e) => ({ at: new Date(Number(e.ts)).toISOString(), type: e.type, page: e.page, name: e.name })),
  };
}

export async function aiSources(db: D1Database, site: Site, c: Common, now?: number) {
  const base = { date_range: c.date_range, timezone: c.timezone, filters: [...(c.filters ?? []), ["is", "channel", ["AI Assistants"]] as ["is", string, string[]]] };
  const [byHost, landing, trend, all] = await Promise.all([
    runQuery(db, site, q({ ...base, metrics: ["visitors", "sessions"], dimensions: ["referrer_host"], compare: c.compare ?? "previous_period" }), now),
    runQuery(db, site, q({ ...base, metrics: ["sessions", "visitors"], dimensions: ["entry_page"], limit: 20 }), now),
    runQuery(db, site, q({ ...base, metrics: ["sessions"], dimensions: ["day"], limit: 1000 }), now),
    runQuery(db, site, q({ date_range: c.date_range, timezone: c.timezone, filters: c.filters ?? [], metrics: ["sessions"] }), now),
  ]);
  const total = Number(all.totals.sessions ?? 0);
  const ai = Number(byHost.totals.sessions ?? 0);
  return {
    meta: byHost.meta,
    assistants_known: AI_HOSTS,
    share_of_sessions_pct: total ? Math.round((1000 * ai) / total) / 10 : 0,
    by_assistant: byHost.rows.map((r) => ({ assistant: r.referrer_host ?? "(utm only)", visitors: r.visitors, sessions: r.sessions })),
    landing_pages: landing.rows,
    trend: trend.rows,
    totals: byHost.totals,
    comparison: byHost.comparison ? { date_range: byHost.comparison.date_range, totals: byHost.comparison.totals } : null,
  };
}

export async function movers(
  db: D1Database,
  site: Site,
  c: Common & { dimension: string; metric: Metric; limit?: number },
  now?: number,
) {
  return moversFrom(await runQuery(db, site, moversQuery(c), now, { rawComparison: true }), c);
}

/** The query behind movers: both periods, every row of each (run with rawComparison, so rows aren't aligned). */
export function moversQuery(c: Common & { dimension: string; metric: Metric }) {
  return q({ date_range: c.date_range, timezone: c.timezone, filters: c.filters ?? [], compare: c.compare ?? "previous_period", metrics: [c.metric], dimensions: [c.dimension], limit: 1000 });
}

export function moversFrom(r: QueryResult, c: { dimension: string; metric: Metric; limit?: number }) {
  const cur = new Map(r.rows.map((x) => [String(x[c.dimension]), Number(x[c.metric] ?? 0)]));
  const prev = new Map(r.comparison!.rows.map((x) => [String(x[c.dimension]), Number(x[c.metric] ?? 0)]));
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  const changes = [...keys].map((k) => {
    const a = cur.get(k) ?? 0;
    const b = prev.get(k) ?? 0;
    return { value: k === "null" ? null : k, current: a, previous: b, change: a - b, change_pct: b ? Math.round(((a - b) / b) * 1000) / 10 : null };
  });
  const lim = c.limit ?? 10;
  return {
    meta: { ...r.meta, comparison_range: r.comparison!.date_range },
    dimension: c.dimension,
    metric: c.metric,
    gainers: [...changes].filter((x) => x.change > 0).sort((a, b) => b.change - a.change).slice(0, lim),
    losers: [...changes].filter((x) => x.change < 0).sort((a, b) => a.change - b.change).slice(0, lim),
    biggest_relative: [...changes].filter((x) => x.change_pct !== null && x.previous >= 5).sort((a, b) => Math.abs(b.change_pct!) - Math.abs(a.change_pct!)).slice(0, lim),
    totals: { current: r.totals[c.metric] ?? 0, previous: r.comparison!.totals[c.metric] ?? 0 },
  };
}

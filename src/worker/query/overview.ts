// The site view in one call: KPIs with comparison, the time series of every KPI, the top rows of each panel, goal
// conversions and annotations. A preset over the query engine (rule 7) whose statements are merged into one D1 query
// (run.ts mergeParts), so opening a site costs a handful of indexed reads of the daily rollups instead of ~20 requests.
import type { Site } from "../lib/sites.ts";
import { daysBetween } from "../lib/time.ts";
import { q, seriesOf, type Common } from "./presets.ts";
import { annotationView, daySpanMs, notComparable, type AnnotationRow } from "../lib/annotations.ts";
import { startOfLocalDay } from "../lib/time.ts";
import { compareRange, resolveRange } from "./range.ts";
import { planQuery, runMerged, type PlannedQuery, type Row } from "./run.ts";
import type { GoalMatch, Metric } from "./schema.ts";

export const OVERVIEW_KPIS: Metric[] = ["visitors", "sessions", "pageviews", "views_per_session", "bounce_rate", "avg_session_duration", "avg_engaged_time", "events", "revenue"];

/** Panels and the metrics each shows; `weekday_hour` is the "when visitors come" heat map. */
export const OVERVIEW_PANELS: Record<string, { dimensions: string[]; metrics: Metric[] }> = {
  page: { dimensions: ["page"], metrics: ["pageviews", "visitors"] },
  entry_page: { dimensions: ["entry_page"], metrics: ["sessions", "visitors"] },
  referrer_host: { dimensions: ["referrer_host"], metrics: ["visitors", "sessions"] },
  channel: { dimensions: ["channel"], metrics: ["visitors", "sessions"] },
  utm_campaign: { dimensions: ["utm_campaign"], metrics: ["visitors", "sessions"] },
  country: { dimensions: ["country"], metrics: ["visitors"] },
  device: { dimensions: ["device"], metrics: ["visitors"] },
  browser: { dimensions: ["browser"], metrics: ["visitors"] },
  os: { dimensions: ["os"], metrics: ["visitors"] },
  event_name: { dimensions: ["event_name"], metrics: ["events", "visitors"] },
  outbound_url: { dimensions: ["outbound_url"], metrics: ["sessions", "visitors"] },
  weekday_hour: { dimensions: ["weekday", "hour"], metrics: ["visitors"] },
};

export type Interval = "hour" | "day" | "week" | "month";

/** The chart's default interval for a range: hours for one day, weeks past ~4 months, days otherwise. */
export function defaultInterval(from: string, to: string): Interval {
  if (from === to) return "hour";
  return daysBetween(from, to) > 120 ? "week" : "day";
}

function delta(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

export interface OverviewOptions extends Common {
  interval?: Interval;
  panels?: string[];
  limit?: number;
}

export async function overview(db: D1Database, site: Site, c: OverviewOptions, now = Date.now()) {
  const base = { date_range: c.date_range, timezone: c.timezone, filters: c.filters ?? [] };
  const compare = c.compare === undefined ? "previous_period" : c.compare;
  const range = resolveRange((c.date_range ?? "28d") as never, site.timezone, now, "2000-01-01");
  const interval = c.interval ?? defaultInterval(range.from, range.to);
  const tsDim = interval === "hour" && range.from !== range.to ? "datehour" : interval;
  const limit = Math.min(Math.max(c.limit ?? 10, 1), 100);
  const panels = (c.panels?.length ? c.panels : Object.keys(OVERVIEW_PANELS)).filter((p) => p in OVERVIEW_PANELS);

  // Goals first (one small read) so each goal's plan reuses it instead of looking its goal up again.
  const goalRows = (await db.prepare("SELECT id, name, kind, definition_json FROM goals WHERE site_id = ? ORDER BY name").bind(site.id).all<{ id: string; name: string; kind: GoalMatch["kind"]; definition_json: string }>()).results;
  const goals = Object.fromEntries(goalRows.map((g) => [g.id, { ...(JSON.parse(g.definition_json) as Omit<GoalMatch, "kind">), kind: g.kind }]));

  const plans: PlannedQuery[] = [];
  const add = async (input: Parameters<typeof q>[0], opts = {}) => {
    plans.push(await planQuery(db, site, q(input), now, { goals, ...opts }));
    return plans.length - 1;
  };
  const kpiAt = await add({ ...base, metrics: OVERVIEW_KPIS, compare });
  const seriesAt = await add({ ...base, metrics: OVERVIEW_KPIS, dimensions: [tsDim], compare, limit: 1000 }, { noTotals: true });
  const panelAt: Record<string, number> = {};
  for (const p of panels) {
    const spec = OVERVIEW_PANELS[p]!;
    panelAt[p] = await add({ ...base, metrics: spec.metrics, dimensions: spec.dimensions, limit: p === "weekday_hour" ? 200 : limit }, { noTotals: true });
  }
  const goalAt = await Promise.all(goalRows.map((g) => add({ ...base, metrics: ["conversions", "conversion_rate"], goal: g.id, compare })));

  // Annotations from the start of the comparison period: the chart shows those in range, and data-quality ones anywhere
  // in between hide the change of the metrics they affect.
  const cmp = compare ? compareRange(range, compare, site.timezone, now) : null;
  const span = daySpanMs(cmp && cmp.from < range.from ? cmp.from : range.from, range.to);
  const shown = daySpanMs(range.from, range.to);
  const annStmt = db
    .prepare("SELECT id, site_id, ts, title, body, url, category, affects FROM annotations WHERE (site_id = ? OR site_id IS NULL) AND ts BETWEEN ? AND ? ORDER BY ts LIMIT 500")
    .bind(site.id, span.from, span.to);
  const { results, extra, rowsRead, statements } = await runMerged(db, plans, [annStmt]);
  const annRows = extra[0]!.results as unknown as AnnotationRow[];

  const kpi = results[kpiAt]!;
  const blocked = kpi.comparison ? notComparable(annRows, startOfLocalDay(kpi.comparison.date_range.from, site.timezone), Math.min(now, startOfLocalDay(range.to, site.timezone) + 86_400_000)) : new Map();
  const kpis = Object.fromEntries(
    OVERVIEW_KPIS.map((m) => {
      const note = blocked.get(m);
      return [m, { value: kpi.totals[m] ?? null, previous: kpi.comparison?.totals[m] ?? null, change_pct: note ? null : delta(kpi.totals[m] as number, kpi.comparison?.totals[m] as number), ...(note ? { not_comparable: note } : {}) }];
    }),
  );
  const ts = results[seriesAt]!;
  const breakdowns: Record<string, Row[]> = {};
  for (const p of panels) breakdowns[p] = results[panelAt[p]!]!.rows;
  return {
    meta: { ...kpi.meta, comparison_range: kpi.comparison?.date_range ?? null, interval: tsDim, d1: { statements, rows_read: rowsRead } },
    kpis,
    timeseries: { interval: tsDim, ...seriesOf(ts, tsDim, OVERVIEW_KPIS) },
    breakdowns,
    goals: goalRows.map((g, i) => {
      const r = results[goalAt[i]!]!;
      return {
        id: g.id,
        name: g.name,
        kind: g.kind,
        conversions: r.totals.conversions ?? 0,
        conversion_rate: r.totals.conversion_rate ?? 0,
        previous: r.comparison ? { conversions: r.comparison.totals.conversions ?? 0, conversion_rate: r.comparison.totals.conversion_rate ?? 0 } : null,
        change_pct: delta(r.totals.conversions as number, r.comparison?.totals.conversions as number),
      };
    }),
    annotations: annRows.filter((a) => a.ts >= shown.from && a.ts <= shown.to).map(annotationView),
  };
}

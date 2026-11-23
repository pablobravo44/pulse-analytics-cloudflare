// The home page in one call: every site's card (visitors with comparison and series, today against the same time
// yesterday, live now, top page and source, main goal, errors, vitals, uptime, last event) plus today's hours per site
// for the river chart. A preset over the query engine (rule 7) whose queries for all sites go to D1 as one statement.
import type { Env } from "../env.ts";
import { siteColorSlot, type Site } from "../lib/sites.ts";
import { addDays, localParts } from "../lib/time.ts";
import { q } from "./presets.ts";
import { resolveRange } from "./range.ts";
import { planQuery, runMerged, type PlannedQuery, type QueryResult, type Row } from "./run.ts";
import { seriesOf } from "./presets.ts";
import type { GoalMatch } from "./schema.ts";
import { planChanges, type Changes } from "./changes.ts";

export type HomeRange = "today" | "7d" | "30d";

function delta(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Average daily visitors below this draws the card as bars: a few visits read better as bars than as a flat line. */
export const LOW_TRAFFIC = 5;

/** `sites`: the sites to show (already access-checked); `allSites`: every site, for colours; `allAccess`: the caller sees every site (and so every check). */
export async function sitesSummary(env: Env, sites: Site[], allSites: Site[], dateRange: HomeRange = "7d", now = Date.now(), allAccess = true) {
  const db = env.DB;
  const goalIds = sites.map((s) => s.settings.primary_goal).filter((g): g is string => !!g);
  const goals: Record<string, GoalMatch & { name: string }> = {};
  if (goalIds.length) {
    const { results } = await db
      .prepare(`SELECT id, name, kind, definition_json FROM goals WHERE id IN (${goalIds.map(() => "?").join(", ")})`)
      .bind(...goalIds)
      .all<{ id: string; name: string; kind: GoalMatch["kind"]; definition_json: string }>();
    for (const g of results) goals[g.id] = { ...(JSON.parse(g.definition_json) as Omit<GoalMatch, "kind">), kind: g.kind, name: g.name };
  }

  const plans: PlannedQuery[] = [];
  type At = { kpi: number; series: number; today: number; hours: number; top: number; source: number; goal: number | null; errors: number; vitals: number; live: number; changes: { from: number; finish: (r: QueryResult[]) => Changes } };
  const at: At[] = [];
  for (const site of sites) {
    const add = async (input: Parameters<typeof q>[0], opts = {}) => {
      plans.push(await planQuery(db, site, q(input), now, { goals, ...opts }));
      return plans.length - 1;
    };
    const today = localParts(now, site.timezone).day;
    const yesterday = addDays(today, -1);
    const interval = dateRange === "today" ? "hour" : "day";
    const goalId = site.settings.primary_goal && goals[site.settings.primary_goal] ? site.settings.primary_goal : null;
    at.push({
      kpi: await add({ date_range: dateRange, metrics: ["visitors", "pageviews"], compare: "previous_period" }),
      series: await add({ date_range: dateRange, metrics: ["visitors"], dimensions: [interval], compare: "previous_period", limit: 1000 }, { noTotals: true }),
      // Today so far against yesterday at the same time of day (the comparison is cut at this time).
      today: await add({ date_range: "today", metrics: ["visitors"], compare: "previous_period" }),
      // The river: today's hours, and all of yesterday's as the ghost line.
      hours: await add({ date_range: "today", metrics: ["visitors"], dimensions: ["hour"], compare: { from: yesterday, to: yesterday }, limit: 24 }, { noTotals: true, rawComparison: true }),
      top: await add({ date_range: dateRange, metrics: ["visitors"], dimensions: ["page"], limit: 1 }, { noTotals: true }),
      source: await add({ date_range: dateRange, metrics: ["visitors"], dimensions: ["source_name"], filters: [], limit: 2 }, { noTotals: true }),
      goal: goalId ? await add({ date_range: dateRange, metrics: ["conversions", "conversion_rate"], goal: goalId, compare: "previous_period" }) : null,
      errors: await add({ date_range: "24h", metrics: ["events"], filters: [["is", "type", ["error"]]] }),
      vitals: await add({ date_range: dateRange, metrics: ["lcp_p75", "cls_p75"] }),
      live: await add({ date_range: { last_minutes: 5 }, metrics: ["visitors"] }),
      // Yesterday against the same weekday a week before, merged into the same statement.
      changes: await (async () => {
        const c = await planChanges(db, site, now);
        const from = plans.length;
        plans.push(...c.plans);
        return { from, finish: c.finish };
      })(),
    });
  }
  const edges = sites.map((s) =>
    db.prepare("SELECT (SELECT ts FROM events WHERE site_id = ?1 ORDER BY ts DESC LIMIT 1) AS last").bind(s.id),
  );
  const { results, extra } = plans.length ? await runMerged(db, plans, edges) : { results: [] as QueryResult[], extra: [] as D1Result<Record<string, unknown>>[] };
  const { statusReport } = await import("../ops/monitor.ts");
  const status = await statusReport(env, now);

  const cards = sites.map((site, i) => {
    const a = at[i]!;
    const kpi = results[a.kpi]!;
    const series = results[a.series]!;
    const s = seriesOf(series, dateRange === "today" ? "hour" : "day", ["visitors"]);
    const today = results[a.today]!;
    const hours = results[a.hours]!;
    const byHour = (rows: Row[]) => Array.from({ length: 24 }, (_, h) => Number(rows.find((r) => r.hour === h)?.visitors ?? 0));
    const sources = results[a.source]!.rows.filter((r) => r.source_name !== null);
    const goal = a.goal !== null ? results[a.goal]! : null;
    const mons = status.monitors.filter((m) => m.site_id === site.id);
    const days = Math.max(1, s.series.length / (dateRange === "today" ? 24 : 1));
    const visitors = num(kpi.totals.visitors) ?? 0;
    const last = (extra[i]?.results[0] as { last: number | null } | undefined)?.last ?? null;
    return {
      id: site.id,
      name: site.name,
      domains: site.domains,
      color: siteColorSlot(site, allSites),
      visitors: { value: visitors, previous: num(kpi.comparison?.totals.visitors), change_pct: delta(visitors, num(kpi.comparison?.totals.visitors)) },
      pageviews: num(kpi.totals.pageviews) ?? 0,
      series: s.series.map((r) => ({ at: r.hour ?? r.day, visitors: Number(r.visitors ?? 0) })),
      comparison: (s.comparison ?? []).map((r) => ({ at: r.hour ?? r.day, visitors: Number(r.visitors ?? 0) })),
      low_traffic: dateRange !== "today" && visitors / days < LOW_TRAFFIC,
      today: { visitors: num(today.totals.visitors) ?? 0, same_time_yesterday: num(today.comparison?.totals.visitors) ?? 0, change_pct: delta(num(today.totals.visitors), num(today.comparison?.totals.visitors)) },
      hours: { today: byHour(hours.rows), yesterday: byHour(hours.comparison?.rows ?? []) },
      live: num(results[a.live]!.totals.visitors) ?? 0,
      top_page: results[a.top]!.rows[0] ? { page: results[a.top]!.rows[0]!.page, visitors: results[a.top]!.rows[0]!.visitors } : null,
      top_source: sources[0] ? { source: sources[0].source_name, visitors: sources[0].visitors } : null,
      goal:
        goal && site.settings.primary_goal
          ? {
              id: site.settings.primary_goal,
              name: goals[site.settings.primary_goal]!.name,
              conversions: num(goal.totals.conversions) ?? 0,
              conversion_rate: num(goal.totals.conversion_rate),
              change_pct: delta(num(goal.totals.conversions), num(goal.comparison?.totals.conversions)),
            }
          : null,
      errors_24h: num(results[a.errors]!.totals.events) ?? 0,
      lcp_p75: num(results[a.vitals]!.totals.lcp_p75),
      cls_p75: num(results[a.vitals]!.totals.cls_p75),
      checks: {
        count: mons.length,
        down: mons.filter((m) => m.status === "down").length,
        uptime_7d: mons.length ? Math.min(...mons.map((m) => m.uptime_7d ?? 100)) : null,
        uptime_30d: mons.length ? Math.min(...mons.map((m) => m.uptime_30d ?? 100)) : null,
        incident_since: mons.map((m) => m.incident_since).filter(Boolean).sort()[0] ?? null,
      },
      last_event: last ? new Date(last).toISOString() : null,
      changes: a.changes.finish(results.slice(a.changes.from, a.changes.from + 4)),
    };
  });
  const sum = (f: (c: (typeof cards)[number]) => number | null) => cards.reduce((t, c) => t + (f(c) ?? 0), 0);
  const prevAll = cards.every((c) => c.visitors.previous === null) ? null : sum((c) => c.visitors.previous);
  const tz = sites[0]?.timezone ?? "UTC";
  const range = resolveRange(dateRange, tz, now);
  return {
    meta: { date_range: dateRange, range, generated_at: new Date(now).toISOString(), now_hour: localParts(now, tz).hour, timezone: tz },
    totals: {
      visitors: { value: sum((c) => c.visitors.value), previous: prevAll, change_pct: delta(sum((c) => c.visitors.value), prevAll) },
      today: { visitors: sum((c) => c.today.visitors), same_time_yesterday: sum((c) => c.today.same_time_yesterday), change_pct: delta(sum((c) => c.today.visitors), sum((c) => c.today.same_time_yesterday)) },
      live: sum((c) => c.live),
      checks: (() => {
        const ids = new Set(sites.map((s) => s.id));
        const mine = status.monitors.filter((m) => (m.site_id ? ids.has(m.site_id) : allAccess));
        return { count: mine.length, down: mine.filter((m) => m.status === "down").length };
      })(),
    },
    sites: cards,
  };
}

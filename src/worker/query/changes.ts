// What changed: one closed day (yesterday by default) against the same weekday a week earlier, so weekly rhythm
// doesn't read as change, with what drove it (the channel, page and country that moved most in the same direction).
// A preset over the query engine (rule 7); its queries can be merged into a bigger statement (home summary).
import type { Site } from "../lib/sites.ts";
import { addDays, localParts } from "../lib/time.ts";
import { moversFrom, moversQuery, q } from "./presets.ts";
import { planQuery, type PlannedQuery, type QueryResult } from "./run.ts";

const DRIVERS = ["channel", "page", "country"] as const;

export interface Changes {
  date: string;
  compared_with: string;
  visitors: { value: number; previous: number; change: number; change_pct: number | null };
  drivers: { dimension: (typeof DRIVERS)[number]; value: string | null; current: number; previous: number; change: number }[];
  sentence: string;
}

/** The queries behind `changes` for `day` (default: yesterday in the site's time zone), and how to read them. */
export async function planChanges(db: D1Database, site: Site, now = Date.now(), day?: string): Promise<{ plans: PlannedQuery[]; finish: (r: QueryResult[]) => Changes }> {
  const date = day ?? addDays(localParts(now, site.timezone).day, -1);
  const before = addDays(date, -7);
  const range = { from: date, to: date };
  const compare = { from: before, to: before };
  const plans = [
    await planQuery(db, site, q({ date_range: range, compare, metrics: ["visitors"] }), now),
    ...(await Promise.all(DRIVERS.map((d) => planQuery(db, site, moversQuery({ date_range: range, compare, dimension: d, metric: "visitors" }), now, { rawComparison: true })))),
  ];
  const finish = (r: QueryResult[]): Changes => {
    const value = Number(r[0]!.totals.visitors ?? 0);
    const previous = Number(r[0]!.comparison?.totals.visitors ?? 0);
    const change = value - previous;
    const up = change >= 0;
    const drivers = DRIVERS.map((dimension, i) => {
      const m = moversFrom(r[i + 1]!, { dimension, metric: "visitors", limit: 1 });
      const top = (up ? m.gainers : m.losers)[0];
      return top ? { dimension, value: top.value, current: top.current, previous: top.previous, change: top.change } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x && x.change !== 0);
    const pct = previous ? Math.round((change / previous) * 1000) / 10 : null;
    const why = drivers.map((d) => `${d.dimension === "page" ? "page " : ""}${d.value ?? "(none)"} ${d.change > 0 ? "+" : ""}${d.change}`).join(", ");
    const sentence = !value && !previous ? `No visits on ${date} or a week before.` : `${value} visitors on ${date}${pct === null ? "" : `, ${pct >= 0 ? "+" : ""}${pct}% against ${before}`}${why ? ` (${why})` : ""}.`;
    return { date, compared_with: before, visitors: { value, previous, change, change_pct: pct }, drivers, sentence };
  };
  return { plans, finish };
}

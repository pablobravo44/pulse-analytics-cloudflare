// The site view's data in one request (GET /sites/{site}/overview): KPIs, the series of every KPI, each panel's
// first tab, goals and annotations. Panels on other tabs still ask /query.
import { keepPreviousData, type QueryClient, useQuery } from "@tanstack/react-query";
import { api, rangeParams, type Filters, type Row } from "./api.ts";

export type Interval = "hour" | "day" | "week" | "month";

export interface Kpi {
  value: number | null;
  previous: number | null;
  change_pct: number | null;
  /** Set when a data-quality marker between the periods makes the change meaningless (its title). */
  not_comparable?: string;
}

export interface Overview {
  meta: {
    date_range: { from: string; to: string };
    comparison_range: { from: string; to: string } | null;
    interval: string;
  };
  kpis: Record<string, Kpi>;
  timeseries: { interval: string; series: Row[]; comparison: Row[] | null };
  breakdowns: Record<string, Row[]>;
  goals: {
    id: string;
    name: string;
    kind: string;
    conversions: number;
    conversion_rate: number;
    previous: { conversions: number; conversion_rate: number } | null;
    change_pct: number | null;
  }[];
  annotations: {
    id: string;
    ts: string;
    title: string;
    body: string | null;
    url: string | null;
    category: string | null;
  }[];
}

const PANEL_ROWS = 100;

export function overviewQuery(site: string, f: Filters, interval?: Interval) {
  return {
    queryKey: ["overview", site, f.range, f.compare, JSON.stringify(f.filters), interval ?? null] as const,
    queryFn: () =>
      api.get<Overview>(
        `/api/v1/sites/${site}/overview?${rangeParams(f)}&limit=${PANEL_ROWS}${interval ? `&interval=${interval}` : ""}`,
      ),
    staleTime: 30_000,
  };
}

/**
 * While new numbers load, keep showing the old ones (dimmed by the caller via isPlaceholderData) only for the same
 * site: switching sites never shows another site's numbers.
 */
export function useOverview(site: string, f: Filters, interval?: Interval) {
  return useQuery({
    ...overviewQuery(site, f, interval),
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === site ? keepPreviousData(prev) : undefined,
  });
}

/** Hovering a site link warms its default view (28 days, previous period, no filters). */
export function prefetchOverview(qc: QueryClient, site: string) {
  void qc.prefetchQuery(
    overviewQuery(site, { range: "28d", compare: "previous_period", filters: [] }, "day"),
  );
}

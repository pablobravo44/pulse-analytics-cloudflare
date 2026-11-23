import { useNavigate, useSearch } from "@tanstack/react-router";
import { createContext } from "react";

/** True on the public share page: hide everything that changes data. */
export const ReadOnly = createContext(false);
import type { Filters } from "./api.ts";

export interface SiteSearch {
  range?: string;
  /** absent = previous period; "YYYY-MM-DD,YYYY-MM-DD" = explicit days */
  compare?: string;
  f?: string;
}

export function validateSiteSearch(s: Record<string, unknown>): SiteSearch {
  const out: SiteSearch = {};
  if (typeof s.range === "string" && /^([a-z0-9_]{2,12}|\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2})$/.test(s.range))
    out.range = s.range;
  if (s.compare === false || s.compare === "false" || s.compare === "none") out.compare = "none";
  if (s.compare === "year") out.compare = "year";
  if (typeof s.compare === "string" && /^\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}$/.test(s.compare))
    out.compare = s.compare;
  if (typeof s.f === "string" && s.f.length < 4000) out.f = s.f;
  // A hand-written ?f=[["is","country",["ES"]]] arrives already parsed by the router.
  else if (Array.isArray(s.f) && JSON.stringify(s.f).length < 4000) out.f = JSON.stringify(s.f);
  return out;
}

/**
 * The report state (date range, comparison, filters) to keep when moving to another site or section,
 * so "Yesterday, from Spain" stays applied while you switch properties.
 */
export function carrySearch(prev: Record<string, unknown>): SiteSearch {
  const out: SiteSearch = {};
  if (typeof prev.range === "string") out.range = prev.range;
  if (typeof prev.compare === "string") out.compare = prev.compare;
  if (typeof prev.f === "string") out.f = prev.f;
  return out;
}

/** Filters live in the URL so views are shareable and survive reloads. */
export function useFilters(): [Filters, (patch: Partial<Filters>) => void] {
  const search = useSearch({ strict: false }) as SiteSearch;
  const navigate = useNavigate();
  let filters: Filters["filters"] = [];
  try {
    filters = search.f ? (JSON.parse(search.f) as Filters["filters"]) : [];
  } catch {
    filters = [];
  }
  const value: Filters = {
    range: search.range ?? "28d",
    compare:
      search.compare === "none"
        ? null
        : search.compare === "year"
          ? "previous_year"
          : search.compare?.includes(",")
            ? search.compare
            : "previous_period",
    filters,
  };
  const set = (patch: Partial<Filters>) => {
    const next = { ...value, ...patch };
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        range: next.range === "28d" ? undefined : next.range,
        compare:
          next.compare === "previous_period"
            ? undefined
            : next.compare === "previous_year"
              ? "year"
              : (next.compare ?? "none"),
        f: next.filters.length ? JSON.stringify(next.filters) : undefined,
      }),
      replace: true,
    } as never);
  };
  return [value, set];
}

export function addFilter(
  filters: Filters["filters"],
  dim: string,
  value: string | number | null,
): Filters["filters"] {
  const v = value === null ? "(none)" : value;
  return [...filters.filter(([, d]) => d !== dim), ["is", dim, [v]]];
}

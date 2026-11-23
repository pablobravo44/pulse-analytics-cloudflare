import { addDays, daysBetween, localParts, startOfLocalDay } from "../lib/time.ts";
import type { DATE_PRESETS } from "./schema.ts";

export interface DayRange {
  from: string; // inclusive local day
  to: string; // inclusive local day
  /** Rolling windows (24h, last_minutes): exact bounds in ms; from/to are the local days they touch. */
  ts?: { from: number; to: number };
  /** Only events before this instant (ms) count: a comparison period cut at the time of day it is now. */
  until?: number;
}

type Preset = (typeof DATE_PRESETS)[number];
export type RangeInput = Preset | { from: string; to: string } | { last_minutes: number };

function rolling(from: number, to: number, timeZone: string): DayRange {
  return { from: localParts(from, timeZone).day, to: localParts(to, timeZone).day, ts: { from, to } };
}

export function resolveRange(r: RangeInput, timeZone: string, now = Date.now(), firstDay?: string | null): DayRange {
  if (typeof r === "object") {
    if ("last_minutes" in r) return rolling(now - r.last_minutes * 60_000, now, timeZone);
    return r.from <= r.to ? { from: r.from, to: r.to } : { from: r.to, to: r.from };
  }
  if (r === "24h") return rolling(now - 86_400_000, now, timeZone);
  const today = localParts(now, timeZone).day;
  const [y, m] = today.split("-") as [string, string, string];
  switch (r) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const d = addDays(today, -1);
      return { from: d, to: d };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "28d":
      return { from: addDays(today, -27), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "mtd":
      return { from: `${y}-${m}-01`, to: today };
    case "last_month": {
      const firstThis = `${y}-${m}-01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
    case "ytd":
      return { from: `${y}-01-01`, to: today };
    case "12mo":
      return { from: addDays(today, -364), to: today };
    case "all":
      return { from: firstDay ?? "2000-01-01", to: today };
  }
}

/** Last day of the month of `day` (YYYY-MM-DD). */
function monthEnd(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** `day` moved `months` calendar months back, clamped to the end of the target month. */
function monthsBack(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/**
 * The period to compare `r` with.
 * - previous_period: whole calendar months compare with the months before (last month vs the month before it);
 *   a month to date compares with the same days of the month before; anything else with the same number of days just
 *   before it.
 * - previous_year: the same days a year earlier.
 * When `r` ends today (local day, `now` given), the comparison stops at the same time of its last day (`until`), so a
 * morning isn't compared with a whole day.
 */
export function compareRange(r: DayRange, mode: "previous_period" | "previous_year" | { from: string; to: string }, timeZone = "UTC", now?: number): DayRange {
  if (typeof mode === "object") return { from: mode.from, to: mode.to };
  if (r.ts) {
    const shift = mode === "previous_year" ? 364 * 86_400_000 : r.ts.to - r.ts.from;
    return rolling(r.ts.from - shift, r.ts.to - shift, timeZone);
  }
  let out: DayRange;
  if (mode === "previous_year") {
    const shift = (d: string) => {
      const [y, mm, dd] = d.split("-") as [string, string, string];
      const py = `${Number(y) - 1}-${mm}-${dd}`;
      // 29 Feb → 28 Feb
      return Number.isNaN(Date.parse(`${py}T00:00:00Z`)) || new Date(`${py}T00:00:00Z`).getUTCMonth() + 1 !== Number(mm)
        ? `${Number(y) - 1}-${mm}-28`
        : py;
    };
    out = { from: shift(r.from), to: shift(r.to) };
  } else if (r.from.endsWith("-01") && r.to === monthEnd(r.to)) {
    const months = (Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 + Number(r.to.slice(5, 7)) - Number(r.from.slice(5, 7)) + 1;
    const from = monthsBack(r.from, months);
    out = { from, to: monthEnd(monthsBack(r.to.slice(0, 8) + "01", months)) };
  } else if (r.from.endsWith("-01") && r.to.slice(0, 7) === r.from.slice(0, 7)) {
    out = { from: monthsBack(r.from, 1), to: monthsBack(r.to, 1) };
  } else {
    const len = daysBetween(r.from, r.to) + 1;
    out = { from: addDays(r.from, -len), to: addDays(r.from, -1) };
  }
  if (now !== undefined && r.until === undefined) {
    const today = localParts(now, timeZone).day;
    if (r.to === today) out.until = startOfLocalDay(out.to, timeZone) + (now - startOfLocalDay(today, timeZone));
  }
  return out;
}

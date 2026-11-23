// Time zone helpers. Everything uses Intl so DST transitions are handled by ICU.

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  day: string; // YYYY-MM-DD
  hour: number;
  minute: number;
}

export function localParts(ts: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `timeZone` from UTC at instant `ts`. */
export function tzOffsetMs(ts: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** UTC ms for local midnight of `day` (YYYY-MM-DD) in `timeZone`. */
export function startOfLocalDay(day: string, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  // Two passes converge across DST changes.
  let ts = guess - tzOffsetMs(guess, timeZone);
  ts = guess - tzOffsetMs(ts, timeZone);
  return ts;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** ISO week start (Monday) for a YYYY-MM-DD. */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

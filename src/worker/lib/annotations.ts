// Annotation helpers shared by REST, MCP and the report presets.
// A data-quality annotation (category "data") lists in `affects` the metrics whose definition or source changed at
// that moment: comparisons of those metrics across it aren't meaningful, so reports leave their change out.
import { METRICS, type Metric } from "../query/schema.ts";
import { addDays } from "./time.ts";

export const ANNOTATION_CATEGORIES = ["deploy", "content", "campaign", "incident", "data", "other"] as const;

export interface AnnotationRow {
  id: string;
  site_id: string | null;
  ts: number;
  title: string;
  body: string | null;
  url: string | null;
  category: string | null;
  affects?: string | null;
}

export function parseAffects(raw: string | null | undefined): Metric[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((m): m is Metric => (METRICS as readonly string[]).includes(m as string)) : [];
  } catch {
    return [];
  }
}

/** An annotation row as the API returns it: ISO time, `affects` as a list. */
export function annotationView<T extends AnnotationRow>(a: T) {
  return { ...a, ts: new Date(a.ts).toISOString(), affects: parseAffects(a.affects) };
}

/**
 * Metrics that can't be compared between [fromMs, toMs): a data-quality annotation inside that span changed them.
 * Returns metric → the annotation's title.
 */
export function notComparable(rows: AnnotationRow[], fromMs: number, toMs: number): Map<Metric, string> {
  const out = new Map<Metric, string>();
  for (const a of rows) if (a.ts > fromMs && a.ts < toMs) for (const m of parseAffects(a.affects)) out.set(m, a.title);
  return out;
}

/** UTC ms bounds that safely cover local days [from, to] in any time zone (a day of margin on each side). */
export function daySpanMs(from: string, to: string): { from: number; to: number } {
  return { from: Date.parse(`${addDays(from, -1)}T00:00:00Z`), to: Date.parse(`${addDays(to, 2)}T00:00:00Z`) };
}

/** Metrics whose definition differs between Rybbit (imported) and Pulse (live): bounce and time measurements. */
export const IMPORT_AFFECTS: Metric[] = ["bounce_rate", "avg_engaged_time", "avg_session_duration", "views_per_session"];

/** The marker (one per site, moved to the latest import's end) a finished import leaves where Pulse's own data begins. */
export function importAnnotation(db: D1Database, siteId: string, source: string, rangeTo: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR REPLACE INTO annotations (id, site_id, ts, title, body, url, category, affects, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'data', ?, 'pulse', ?)`,
    )
    .bind(
      `dq_import_${siteId}`,
      siteId,
      Date.parse(`${addDays(rangeTo, 1)}T00:00:00Z`),
      `Data before this comes from ${source}`,
      `Imported ${source} data ends here and Pulse's own tracking begins. Bounce rate and time measures are defined differently, so their change across this point isn't shown.`,
      JSON.stringify(IMPORT_AFFECTS),
      Date.now(),
    );
}

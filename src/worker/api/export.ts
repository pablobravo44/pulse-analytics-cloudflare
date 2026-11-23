const COLS = [
  "id", "ts", "local_day", "type", "session_id", "visitor_id", "hostname", "pathname", "query", "title", "referrer",
  "referrer_host", "channel", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "country", "region",
  "city", "device", "browser", "browser_version", "os", "os_version", "screen_w", "screen_h", "language", "name",
  "props_json", "engaged_ms", "scroll_pct", "url", "lcp", "inp", "cls", "fcp", "ttfb", "source",
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Neutralize spreadsheet formulas and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows as CSV: the given columns (default: every key, in first-seen order), one line per row. */
export function toCsv(rows: Record<string, unknown>[], cols?: string[]): string {
  const keys = cols ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [keys.join(","), ...rows.map((r) => keys.map((k) => csvCell(typeof r[k] === "object" && r[k] !== null ? JSON.stringify(r[k]) : r[k])).join(","))].join("\n") + "\n";
}

/**
 * One page of raw events after (ts, id). It seeks on events_site_ts (site_id, ts) between generous UTC bounds of
 * the local days (time zones are within ±14 h), with local_day as a residual filter (`+` keeps the planner off the
 * local_day index), so each page reads only its own rows instead of re-sorting the whole range.
 */
export const EXPORT_PAGE_SQL = (typed: boolean) =>
  `SELECT ${COLS.join(", ")} FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND +local_day BETWEEN ? AND ? ${typed ? "AND type = ?" : ""}
   AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT ?`;

const DAY = 86_400_000;
const PAD = 14 * 3_600_000;
function pageParams(siteId: string, q: { from: string; to: string; type?: string }, afterTs: number, afterId: string, limit: number) {
  const lo = Math.max(afterTs, Date.parse(`${q.from}T00:00:00Z`) - PAD);
  const hi = Date.parse(`${q.to}T00:00:00Z`) + DAY + PAD;
  return [siteId, lo, hi, q.from, q.to, ...(q.type ? [q.type] : []), afterTs, afterTs, afterId, limit];
}

/** Stream raw events in pages of 1000 by (ts, id). */
export function exportEvents(
  db: D1Database,
  siteId: string,
  q: { from: string; to: string; format: "ndjson" | "csv"; type?: string },
  maxRows = Number.MAX_SAFE_INTEGER,
): Response {
  const enc = new TextEncoder();
  let lastTs = -1;
  let lastId = "";
  let sent = 0;
  let headerDone = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (q.format === "csv" && !headerDone) {
        controller.enqueue(enc.encode(COLS.join(",") + "\n"));
        headerDone = true;
      }
      const lim = Math.min(1000, maxRows - sent);
      if (lim <= 0) return controller.close();
      const { results } = await db
        .prepare(EXPORT_PAGE_SQL(!!q.type))
        .bind(...pageParams(siteId, q, lastTs, lastId, lim))
        .all<Record<string, unknown>>();
      if (!results.length) return controller.close();
      let chunk = "";
      for (const r of results) {
        chunk += q.format === "csv" ? COLS.map((c) => csvCell(r[c])).join(",") + "\n" : JSON.stringify(r) + "\n";
      }
      controller.enqueue(enc.encode(chunk));
      const last = results[results.length - 1]!;
      lastTs = last.ts as number;
      lastId = last.id as string;
      sent += results.length;
      if (results.length < lim) controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": q.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
      "Content-Disposition": `attachment; filename="${siteId}-${q.from}-${q.to}.${q.format === "csv" ? "csv" : "ndjson"}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function exportRows(db: D1Database, siteId: string, q: { from: string; to: string; type?: string; limit: number; after?: { ts: number; id: string } }) {
  const { results } = await db
    .prepare(EXPORT_PAGE_SQL(!!q.type))
    .bind(...pageParams(siteId, q, q.after?.ts ?? -1, q.after?.id ?? "", q.limit))
    .all<Record<string, unknown>>();
  return results;
}

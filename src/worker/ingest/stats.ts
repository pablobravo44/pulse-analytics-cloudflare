import type { Waiter } from "../env.ts";
import { utcDay } from "../lib/time.ts";

export type StatField = "accepted" | "dropped_bot" | "dropped_dnt" | "dropped_hosting" | "dropped_invalid" | "dropped_rate" | "dropped_host" | "dropped_excluded" | "dropped_cap" | "revenue_ignored";

/** Increment one ingest_stats counter now (one D1 write). Unknown sites are counted under "_unknown". */
export function bumpStat(db: D1Database, siteId: string, field: StatField, n = 1, ts = Date.now()): Promise<unknown> {
  // field is from a closed union, never user input.
  return db
    .prepare(
      `INSERT INTO ingest_stats (day, site_id, ${field}) VALUES (?, ?, ?)
       ON CONFLICT (day, site_id) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
    )
    .bind(utcDay(ts), siteId, n)
    .run();
}

// Counters for rejected hits live in isolate memory and are written at most once a minute per isolate, so a
// flood of junk requests can't turn into a flood of D1 writes. Counts held by an isolate that is evicted before
// its next flush are lost: the drop counters are approximate by design.
export const FLUSH_MS = 60_000;

type Pending = Map<string, Partial<Record<StatField, number>>>; // key: `${day}|${site}`
let pending: Pending = new Map();
let rejectedHosts = new Map<string, { host: string; at: number }>();
let lastFlush = 0;

/** Test hook: forget everything held in memory (each test gets a fresh database). */
export function resetIngestStats(): void {
  pending = new Map();
  rejectedHosts = new Map();
  lastFlush = 0;
}

/** Count a hit in memory; flushed to ingest_stats by the next `maybeFlush` that is due. */
export function countStat(siteId: string, field: StatField, n = 1, ts = Date.now()): void {
  const key = `${utcDay(ts)}|${siteId}`;
  const row = pending.get(key) ?? {};
  row[field] = (row[field] ?? 0) + n;
  pending.set(key, row);
}

/** Remember the last rejected hostname of a site (for the installation check), written with the counters. */
export function noteRejectedHost(siteId: string, host: string, at: number): void {
  rejectedHosts.set(siteId, { host: host.slice(0, 253), at });
}

/** Schedule a flush when anything is pending and the last one was at least FLUSH_MS ago. */
export function maybeFlush(db: D1Database, ctx: Waiter, now = Date.now()): void {
  if ((!pending.size && !rejectedHosts.size) || now - lastFlush < FLUSH_MS) return;
  lastFlush = now;
  ctx.waitUntil(flushIngestStats(db, now));
}

/** Write everything held in memory in one D1 batch. On failure the counts go back in memory for the next flush. */
export async function flushIngestStats(db: D1Database, now = Date.now()): Promise<void> {
  const counts = pending;
  const hosts = rejectedHosts;
  pending = new Map();
  rejectedHosts = new Map();
  lastFlush = now;
  const stmts: D1PreparedStatement[] = [];
  for (const [key, row] of counts) {
    const [day, site] = key.split("|") as [string, string];
    const fields = Object.keys(row) as StatField[];
    if (!fields.length) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO ingest_stats (day, site_id, ${fields.join(", ")}) VALUES (?, ?, ${fields.map(() => "?").join(", ")})
           ON CONFLICT (day, site_id) DO UPDATE SET ${fields.map((f) => `${f} = ${f} + excluded.${f}`).join(", ")}`,
        )
        .bind(day, site, ...fields.map((f) => row[f]!)),
    );
  }
  for (const [site, v] of hosts) {
    stmts.push(
      db
        .prepare("INSERT INTO kv_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(`rejected_host:${site}`, JSON.stringify(v), v.at),
    );
  }
  if (!stmts.length) return;
  try {
    await db.batch(stmts);
  } catch (err) {
    for (const [key, row] of counts) for (const [f, n] of Object.entries(row)) countStat(key.split("|")[1]!, f as StatField, n, Date.parse(`${key.split("|")[0]}T12:00:00Z`));
    for (const [site, v] of hosts) if (!rejectedHosts.has(site)) rejectedHosts.set(site, v);
    console.error(JSON.stringify({ msg: "ingest_stats_flush_failed", error: String(err).slice(0, 200) }));
  }
}

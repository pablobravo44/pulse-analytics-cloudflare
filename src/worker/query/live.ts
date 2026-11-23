// Who is on the sites now. One window for everything: a visit is "on the site" when its session had a hit in the
// last 5 minutes; the feed lists the visits of the last 30 minutes, newest first, each marked active or not, so
// the count and the list always agree (they used different windows before). Visits carry no visitor or session ids.
import type { Site } from "../lib/sites.ts";
import { addDays, localParts } from "../lib/time.ts";

export const ACTIVE_MS = 5 * 60_000;
export const FEED_MS = 30 * 60_000;

export interface LiveVisit {
  site: string;
  started_at: string;
  last_at: string;
  active: boolean;
  pages: string[];
  pageviews: number;
  source: string | null;
  channel: string | null;
  country: string | null;
  device: string | null;
}

/** The visits of the last 30 minutes on `sites` (newest first) and per-site counts. One D1 batch. */
export async function liveVisits(db: D1Database, sites: Site[], now = Date.now(), limit = 40) {
  if (!sites.length) return { visits: [] as LiveVisit[], per_site: [] as { site: string; visitors: number; hits_per_minute: number[] }[], countries: [] as { country: string; visitors: number }[] };
  const ids = sites.map((s) => s.id);
  const marks = ids.map(() => "?").join(", ");
  const since = now - FEED_MS;
  // Sessions start on their local day, so a 30-minute window touches at most today and yesterday in any time zone.
  const days = [...new Set(sites.flatMap((s) => [localParts(now, s.timezone).day, addDays(localParts(now, s.timezone).day, -1)]))].sort();
  const [sess, pages, perMin, counts] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT id, site_id, started_at, last_seen_at, referrer_host, channel, country, device, pageviews FROM sessions
         WHERE site_id IN (${marks}) AND local_day >= ? AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .bind(...ids, days[0], since, limit),
    // `+type` keeps SQLite on the (site_id, ts) index.
    db.prepare(`SELECT session_id, pathname FROM events WHERE site_id IN (${marks}) AND ts >= ? AND +type = 'pageview' ORDER BY ts`).bind(...ids, since - FEED_MS),
    db.prepare(`SELECT site_id, CAST((ts - ?) / 60000 AS INTEGER) AS minute, COUNT(*) AS hits FROM events WHERE site_id IN (${marks}) AND ts >= ? GROUP BY 1, 2`).bind(since, ...ids, since),
    // Visitors on the site now (same rule as a visit's "active"), counted without the feed's cap.
    db
      .prepare(`SELECT site_id, country, COUNT(DISTINCT visitor_id) AS visitors FROM sessions WHERE site_id IN (${marks}) AND local_day >= ? AND last_seen_at >= ? GROUP BY 1, 2`)
      .bind(...ids, days[0], now - ACTIVE_MS),
  ]);
  const bySession = new Map<string, string[]>();
  for (const r of pages!.results as { session_id: string; pathname: string | null }[]) {
    const l = bySession.get(r.session_id) ?? [];
    if (r.pathname && l[l.length - 1] !== r.pathname) l.push(r.pathname);
    bySession.set(r.session_id, l);
  }
  const rows = sess!.results as { id: string; site_id: string; started_at: number; last_seen_at: number; referrer_host: string | null; channel: string | null; country: string | null; device: string | null; pageviews: number }[];
  const visits: LiveVisit[] = rows.map((r) => ({
    site: r.site_id,
    started_at: new Date(r.started_at).toISOString(),
    last_at: new Date(r.last_seen_at).toISOString(),
    active: r.last_seen_at >= now - ACTIVE_MS,
    pages: (bySession.get(r.id) ?? []).slice(-6),
    pageviews: r.pageviews,
    source: r.referrer_host,
    channel: r.channel,
    country: r.country,
    device: r.device,
  }));
  const now5 = counts!.results as { site_id: string; country: string | null; visitors: number }[];
  const visitorsOf = (site: string) => now5.filter((r) => r.site_id === site).reduce((a, r) => a + Number(r.visitors), 0);
  const mins = perMin!.results as { site_id: string; minute: number; hits: number }[];
  const countries = new Map<string, number>();
  for (const r of now5) if (r.country) countries.set(r.country, (countries.get(r.country) ?? 0) + Number(r.visitors));
  return {
    visits,
    per_site: ids.map((site) => ({ site, visitors: visitorsOf(site), hits_per_minute: Array.from({ length: 30 }, (_, i) => Number(mins.find((m) => m.site_id === site && m.minute === i)?.hits ?? 0)) })),
    countries: [...countries].map(([country, visitors]) => ({ country, visitors })).sort((a, b) => b.visitors - a.visitors),
  };
}

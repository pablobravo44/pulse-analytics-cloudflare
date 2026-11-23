// Per-site daily event cap (circuit breaker). When a site has accepted `settings.daily_event_cap` events on the
// current UTC day, its hits are dropped before they reach the queue until the next day, and the alert address gets one
// email. The check is cheap: each isolate reads today's accepted counts (one small query) at most once a
// minute and adds what it queued itself since then.
import type { Env, Waiter } from "../env.ts";
import { utcDay } from "../lib/time.ts";
import type { Site } from "../lib/sites.ts";

export const CAP_REFRESH_MS = 60_000;

interface Snapshot {
  day: string;
  at: number;
  accepted: Map<string, number>;
}

let snap: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;
let queued = new Map<string, number>();
let alerted = new Set<string>();

/** Test hook. */
export function resetCapCache(): void {
  snap = null;
  loading = null;
  queued = new Map();
  alerted = new Set();
}

async function load(db: D1Database, day: string, now: number): Promise<Snapshot> {
  const { results } = await db.prepare("SELECT site_id, accepted FROM ingest_stats WHERE day = ?").bind(day).all<{ site_id: string; accepted: number }>();
  return { day, at: now, accepted: new Map(results.map((r) => [r.site_id, Number(r.accepted) || 0])) };
}

async function snapshot(db: D1Database, now: number): Promise<Snapshot> {
  const day = utcDay(now);
  if (snap && snap.day === day && now - snap.at < CAP_REFRESH_MS) return snap;
  if (!loading) {
    loading = load(db, day, now)
      .then((s) => {
        snap = s;
        queued = new Map();
        return s;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Accepted today (as last read) plus what this isolate queued since. */
export async function acceptedToday(db: D1Database, siteId: string, now = Date.now()): Promise<number> {
  const s = await snapshot(db, now);
  return (s.accepted.get(siteId) ?? 0) + (queued.get(siteId) ?? 0);
}

/** Record a hit this isolate put on the queue. */
export function noteQueued(siteId: string): void {
  queued.set(siteId, (queued.get(siteId) ?? 0) + 1);
}

/** True when the site is over its cap for today. The first time an isolate sees that, it raises the alert. */
export async function overDailyCap(env: Env, ctx: Waiter, site: Site, now = Date.now()): Promise<boolean> {
  const cap = site.settings.daily_event_cap;
  if (!cap) return false;
  const n = await acceptedToday(env.DB, site.id, now);
  if (n < cap) return false;
  const key = `${utcDay(now)}|${site.id}`;
  if (!alerted.has(key)) {
    alerted.add(key);
    ctx.waitUntil(capAlert(env, site, cap, now).catch((e) => console.error(JSON.stringify({ msg: "cap_alert_failed", error: String(e).slice(0, 200) }))));
  }
  return true;
}

/** One email per site and day across all isolates: whoever flips kv_meta first sends it. */
export async function capAlert(env: Env, site: Site, cap: number, now = Date.now()): Promise<boolean> {
  const day = utcDay(now);
  const claim = await env.DB.prepare(
    "INSERT INTO kv_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE kv_meta.value <> excluded.value",
  )
    .bind(`ingest_cap:${site.id}`, day, now)
    .run();
  if (!claim.meta.changes) return false;
  console.warn(JSON.stringify({ msg: "ingest_cap_reached", site: site.id, cap }));
  const { audit } = await import("../lib/audit.ts");
  await audit(env.DB, "ingest", "ingest.cap_reached", site.id, { cap, day });
  const { sendMail } = await import("../ops/email.ts");
  await sendMail(
    env,
    `⚠️ Pulse paused ingest for ${site.name}`,
    [
      `${site.name} (${site.id}) accepted ${cap.toLocaleString("en")} events today (${day} UTC), its daily event cap.`,
      "New hits for this site are dropped (counted as dropped_cap) until 00:00 UTC.",
      "",
      "If this is real traffic, raise the cap (site settings → Daily event cap, or PATCH /api/v1/sites/{site} with settings.daily_event_cap; 0 turns it off). Ingest resumes within a minute.",
      "If it isn't, look at today's referrers and pages for the flood and block it (blocked referrers, countries or paths).",
      "",
      `${env.PUBLIC_ORIGIN}/sites/${site.id}/settings`,
    ].join("\n"),
    undefined,
    "notice",
  );
  return true;
}

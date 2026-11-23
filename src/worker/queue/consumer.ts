import type { Env } from "../env.ts";
import type { EnrichedHit } from "../ingest/types.ts";
import { bumpStat } from "../ingest/stats.ts";

export const SESSION_WINDOW_MS = 30 * 60_000;
export const BOUNCE_ENGAGED_MS = 10_000;

const EVENT_COLS = [
  "id", "site_id", "ts", "local_day", "local_hour", "type", "session_id", "visitor_id", "pageview_id", "hostname",
  "pathname", "query", "title", "referrer", "referrer_host", "channel", "utm_source", "utm_medium", "utm_campaign",
  "utm_term", "utm_content", "country", "region", "city", "continent", "device", "browser", "browser_version", "os",
  "os_version", "screen_w", "screen_h", "language", "name", "props_json", "engaged_ms", "scroll_pct", "url", "lcp",
  "inp", "cls", "fcp", "ttfb", "search_term", "source",
] as const;

export const INSERT_EVENT_SQL = `INSERT OR IGNORE INTO events (${EVENT_COLS.join(", ")}) VALUES (${EVENT_COLS.map(() => "?").join(", ")})`;

export function eventValues(e: Record<string, unknown>): unknown[] {
  return EVENT_COLS.map((c) => e[c] ?? null);
}

export interface SessionRow {
  id: string;
  last_seen_at: number;
  started_at: number;
  pageviews: number;
  engaged_ms: number;
}

/** Session bookkeeping decision for one hit (pure, unit-tested). */
export function sessionDecision(prev: SessionRow | null, ts: number): { reuse: boolean } {
  return { reuse: !!prev && ts - prev.last_seen_at <= SESSION_WINDOW_MS && ts >= prev.started_at - 60_000 };
}

/** Hits that can open a session. Beacons (engagement, vitals, errors) belong to the page that sent them. */
export const OPENS_SESSION = new Set(["pageview", "event", "outbound", "download"]);

export function isBounce(pageviews: number, engagedMs: number): boolean {
  return pageviews <= 1 && engagedMs < BOUNCE_ENGAGED_MS;
}

/** Process one hit: find or create the session, insert the event, update aggregates — one D1 batch. */
export async function processHit(db: D1Database, hit: EnrichedHit): Promise<void> {
  // Idempotency: a re-delivered hit whose event exists is skipped entirely.
  const exists = await db.prepare("SELECT session_id FROM events WHERE id = ?").bind(hit.id).first();
  if (exists) return;

  const prev = await db
    .prepare(
      "SELECT id, last_seen_at, started_at, pageviews, engaged_ms FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY last_seen_at DESC LIMIT 1",
    )
    .bind(hit.site_id, hit.visitor_id)
    .first<SessionRow>();

  const isPv = hit.type === "pageview" ? 1 : 0;
  const isEv = hit.type === "pageview" || hit.type === "engagement" || hit.type === "vitals" ? 0 : 1;
  const engaged = hit.type === "engagement" ? (hit.engaged_ms ?? 0) : 0;
  const stmts: D1PreparedStatement[] = [];
  let sessionId: string;

  if (prev && sessionDecision(prev, hit.ts).reuse) {
    sessionId = prev.id;
    stmts.push(
      db
        .prepare(
          `UPDATE sessions SET
             last_seen_at = MAX(last_seen_at, ?1),
             exit_path = CASE WHEN ?2 = 1 AND ?1 >= last_seen_at THEN ?3 ELSE exit_path END,
             pageviews = pageviews + ?2,
             events = events + ?4,
             engaged_ms = engaged_ms + ?5,
             duration_ms = MAX(duration_ms, ?1 - started_at),
             bounced = CASE WHEN pageviews + ?2 <= 1 AND engaged_ms + ?5 < ${BOUNCE_ENGAGED_MS} THEN 1 ELSE 0 END
           WHERE id = ?6`,
        )
        .bind(hit.ts, isPv, hit.pathname, isEv, engaged, sessionId),
    );
  } else if (!OPENS_SESSION.has(hit.type)) {
    // A beacon after the session window (a tab hidden for an hour, then closed) belongs to its page's session, the
    // visitor's latest: it adds engaged time but doesn't move the session's end. Opening a new session for it made
    // empty "Direct" sessions. With no session at all (a new day's visitor id), the event is kept without one.
    if (prev) {
      sessionId = prev.id;
      stmts.push(
        db
          .prepare(
            `UPDATE sessions SET engaged_ms = engaged_ms + ?1, events = events + ?2,
               bounced = CASE WHEN pageviews <= 1 AND engaged_ms + ?1 < ${BOUNCE_ENGAGED_MS} THEN 1 ELSE 0 END
             WHERE id = ?3`,
          )
          .bind(engaged, isEv, sessionId),
      );
    } else sessionId = `none:${hit.id}`;
  } else {
    sessionId = hit.id; // first hit's ULID doubles as the session id
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, local_day, entry_path, exit_path,
             pageviews, events, engaged_ms, duration_ms, bounced, hostname, referrer, referrer_host, channel, utm_source,
             utm_medium, utm_campaign, utm_term, utm_content, country, region, city, continent, device, browser,
             browser_version, os, os_version, screen_w, screen_h, language, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pulse')`,
        )
        .bind(
          sessionId, hit.site_id, hit.visitor_id, hit.ts, hit.ts, hit.local_day,
          hit.pathname, hit.pathname, isPv, isEv, engaged, isBounce(isPv, engaged) ? 1 : 0,
          hit.hostname, hit.referrer, hit.referrer_host, hit.channel, hit.utm_source, hit.utm_medium,
          hit.utm_campaign, hit.utm_term, hit.utm_content, hit.country, hit.region, hit.city, hit.continent,
          hit.device, hit.browser, hit.browser_version, hit.os, hit.os_version, hit.screen_w, hit.screen_h,
          hit.language,
        ),
    );
  }
  stmts.push(db.prepare(INSERT_EVENT_SQL).bind(...eventValues({ ...hit, session_id: sessionId })));
  await db.batch(stmts);
}

export async function handleQueue(batch: MessageBatch<EnrichedHit>, env: Env): Promise<void> {
  // Process in ts order so session windows are applied in sequence.
  const msgs = [...batch.messages].sort((a, b) => a.body.ts - b.body.ts);
  const counts = new Map<string, number>();
  for (const m of msgs) {
    try {
      await processHit(env.DB, m.body);
      m.ack();
      counts.set(m.body.site_id, (counts.get(m.body.site_id) ?? 0) + 1);
    } catch (err) {
      console.error(JSON.stringify({ msg: "consume_failed", error: String(err).slice(0, 200) }));
      m.retry({ delaySeconds: 5 });
    }
  }
  await Promise.all([...counts].map(([site, n]) => bumpStat(env.DB, site, "accepted", n)));
}

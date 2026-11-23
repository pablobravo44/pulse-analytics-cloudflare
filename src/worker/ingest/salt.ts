import { randomHex } from "../lib/crypto.ts";
import { localParts } from "../lib/time.ts";

// One salt per local day and time zone: a visitor id lives exactly one of the site's days (the days reports count
// in), so it neither splits at UTC midnight nor links two local days. Keys are "YYYY-MM-DD@Time/Zone" ("YYYY-MM-DD"
// alone is a UTC day, the format used before).
let caches = new WeakMap<D1Database, Map<string, string>>();
const cacheOf = (db: D1Database) => {
  let m = caches.get(db);
  if (!m) caches.set(db, (m = new Map()));
  return m;
};

export function saltKey(day: string, timeZone: string): string {
  return timeZone === "UTC" ? day : `${day}@${timeZone}`;
}

function parseKey(key: string): { day: string; timeZone: string } {
  const at = key.indexOf("@");
  return at < 0 ? { day: key, timeZone: "UTC" } : { day: key.slice(0, at), timeZone: key.slice(at + 1) };
}

/** The salt for the local day of `now` in `timeZone`, created on first use. */
export async function saltFor(db: D1Database, timeZone: string, now = Date.now()): Promise<string> {
  const key = saltKey(localParts(now, timeZone).day, timeZone);
  const cache = cacheOf(db);
  const hit = cache.get(key);
  if (hit) return hit;
  await db.prepare("INSERT OR IGNORE INTO salts (day, salt, created_at) VALUES (?, ?, ?)").bind(key, randomHex(32), now).run();
  const row = await db.prepare("SELECT salt FROM salts WHERE day = ?").bind(key).first<{ salt: string }>();
  if (!row) throw new Error("salt missing");
  if (cache.size > 16) cache.clear();
  cache.set(key, row.salt);
  return row.salt;
}

/**
 * Hourly: delete every salt whose local day has ended, so a visitor id can't be recomputed (or linked to the next
 * day's) once its day is over. A salt is created during its day, so it lives at most ~25 hours (under 48 h).
 */
export async function rotateSalts(db: D1Database, now = Date.now()): Promise<number> {
  const { results } = await db.prepare("SELECT day FROM salts").all<{ day: string }>();
  const old = results
    .map((r) => r.day)
    .filter((key) => {
      const { day, timeZone } = parseKey(key);
      try {
        return day < localParts(now, timeZone).day;
      } catch {
        return true; // an unknown time zone: nothing can use it any more
      }
    });
  for (let i = 0; i < old.length; i += 50) {
    const chunk = old.slice(i, i + 50);
    await db.prepare(`DELETE FROM salts WHERE day IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk).run();
  }
  caches = new WeakMap();
  return old.length;
}

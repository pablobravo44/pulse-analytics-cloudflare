import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { roleScopes, userSiteIds, type Principal } from "./principal.ts";

export const SESSION_COOKIE = "__Host-pulse_session";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

interface SessionJoin {
  user_id: string;
  expires_at: number;
  email: string;
  role: "owner" | "admin" | "viewer";
  site_ids_json: string | null;
  disabled_at: number | null;
}

export async function createSession(
  db: D1Database,
  userId: string,
  opts: { ttlMs?: number; ua?: string | null; label?: string | null } = {},
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const expiresAt = Date.now() + (opts.ttlMs ?? SESSION_TTL_MS);
  await db
    .prepare("INSERT INTO auth_sessions (id_hash, user_id, expires_at, created_at, ua_summary, label) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, expiresAt, Date.now(), opts.ua?.slice(0, 120) ?? null, opts.label ?? null)
    .run();
  return { token, expiresAt };
}

export function sessionCookie(token: string, expiresAt: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

// A dashboard page load sends a dozen API calls at once; they share one session lookup. Rows live
// for 10 s per isolate (keyed by the token's hash), so a session deleted elsewhere stops working
// within 10 s; deletions in this isolate take effect at once (forgetSessions).
const SESSION_CACHE_MS = 10_000;
const sessionCache = new Map<string, { at: number; row: Promise<SessionJoin | null> }>();

function loadSession(db: D1Database, hash: string): Promise<SessionJoin | null> {
  const now = Date.now();
  const hit = sessionCache.get(hash);
  if (hit && now - hit.at < SESSION_CACHE_MS) return hit.row;
  if (sessionCache.size > 500) sessionCache.clear();
  const row = db
    .prepare(
      `SELECT a.user_id, a.expires_at, u.email, u.role, u.site_ids_json, u.disabled_at
       FROM auth_sessions a JOIN users u ON u.id = a.user_id WHERE a.id_hash = ?`,
    )
    .bind(hash)
    .first<SessionJoin>();
  sessionCache.set(hash, { at: now, row });
  row.catch(() => sessionCache.delete(hash));
  return row;
}

/** Drop cached session rows (after logout, a role change or disabling a user). */
export function forgetSessions(): void {
  sessionCache.clear();
}

/** Validate the session cookie. Slides expiry when more than a day has passed. */
export async function verifySession(
  db: D1Database,
  token: string | null,
): Promise<{ principal: Principal; refreshed: { token: string; expiresAt: number } | null } | null> {
  if (!token || token.length < 40 || token.length > 80) return null;
  const hash = await sha256Hex(token);
  const row = await loadSession(db, hash);
  const now = Date.now();
  if (!row || row.expires_at < now || row.disabled_at) return null;
  let refreshed: { token: string; expiresAt: number } | null = null;
  if (row.expires_at - now < SESSION_TTL_MS - 24 * 3600_000) {
    const expiresAt = now + SESSION_TTL_MS;
    await db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE id_hash = ?").bind(expiresAt, hash).run();
    row.expires_at = expiresAt;
    refreshed = { token, expiresAt };
  }
  return {
    principal: {
      kind: "user",
      id: row.user_id,
      label: `user:${row.email}`,
      role: row.role,
      scopes: roleScopes(row.role),
      siteIds: userSiteIds(row.role, row.site_ids_json),
    },
    refreshed,
  };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  forgetSessions();
  await db.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
}

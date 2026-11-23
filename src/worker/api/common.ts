import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { verifyApiKey } from "../auth/apikeys.ts";
import { canAccessSite, hasScope, type Principal, type Scope } from "../auth/principal.ts";
import { readCookie, SESSION_COOKIE, sessionCookie, verifySession } from "../auth/session.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { verifySharePassword } from "../lib/password.ts";
import type { Env } from "../env.ts";
import { getSite, type Site } from "../lib/sites.ts";
import { QueryError } from "../query/run.ts";

export interface AppEnv {
  Bindings: Env;
  Variables: { principal: Principal; site: Site };
}

export type Ctx = Context<AppEnv>;

type ErrStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500;

export class ApiError extends Error {
  status: ErrStatus;
  code: string;
  details?: unknown;
  constructor(status: ErrStatus, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) })
  .openapi("Error");

export function errorResponse(c: Ctx, err: unknown): Response {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: { code: "invalid_request", message: "validation failed", details: err.issues } }, 400);
  }
  if (err instanceof QueryError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  console.error(JSON.stringify({ msg: "api_error", path: new URL(c.req.url).pathname, error: String(err).slice(0, 300) }));
  return c.json({ error: { code: "internal", message: "internal error" } }, 500);
}

export function newApi(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          { error: { code: "invalid_request", message: "request validation failed", details: result.error.issues } },
          400,
        );
      }
    },
  });
}

/** Read-only share links can reach one site's reports and nothing else. */
const SHARE_ALLOWED = /^\/api\/v1\/sites(\/[^/]+\/(summary|timeseries|breakdown\/[^/]+|realtime|sources\/ai|movers|retention|paths|vitals|errors|pages\/report|goals|goals\/[^/]+\/conversions|funnels|funnels\/[^/]+|annotations|query|properties|insights|views))?\/?$/;

/** Reports that ignore filters can't be shown through a share link bound to a view. */
const SHARE_UNFILTERED = /\/(realtime|retention|views)\/?$/;

// A share page makes a burst of API calls with the same password; PBKDF2 runs once per isolate and 10 minutes.
// Keyed by a hash of link, stored hash and password, so a changed or revoked password never matches.
const verifiedShares = new Map<string, number>();

async function sharePasswordOk(c: Ctx, row: { id: string; password_hash: string }, pw: string): Promise<boolean> {
  const memo = await sha256Hex(`${row.id}\u0000${row.password_hash}\u0000${pw}`);
  const until = verifiedShares.get(memo);
  if (until && until > Date.now()) return true;
  const v = await verifySharePassword(row.id, pw, row.password_hash);
  if (!v.ok) return false;
  if (v.rehash) c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE share_links SET password_hash = ? WHERE id = ? AND password_hash = ?").bind(v.rehash, row.id, row.password_hash).run());
  if (verifiedShares.size > 1000) verifiedShares.clear();
  verifiedShares.set(memo, Date.now() + 10 * 60_000);
  return true;
}

async function shareAuth(c: Ctx, token: string): Promise<Principal> {
  const row = await c.env.DB.prepare("SELECT id, site_id, password_hash, expires_at, revoked_at, view_id FROM share_links WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ id: string; site_id: string; password_hash: string | null; expires_at: number | null; revoked_at: number | null; view_id: string | null }>();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < Date.now())) throw new ApiError(401, "share_invalid", "this share link is invalid or has expired");
  // Every share link gets the same request budget as an API key.
  if (!(await c.env.API_LIMITER.limit({ key: `share:${row.id}` })).success) throw new ApiError(429, "rate_limited", "rate limit exceeded");
  if (row.password_hash) {
    const pw = c.req.header("x-pulse-share-password") ?? "";
    if (!pw) throw new ApiError(401, "password_required", "this share link needs a password");
    // Only wrong passwords count; too many lock the link for a minute (for everyone, which bounds guessing).
    const lock = await c.env.DB.prepare("SELECT value FROM kv_meta WHERE key = ?").bind(`share_lock:${row.id}`).first<{ value: string }>();
    if (lock && Number(lock.value) > Date.now()) throw new ApiError(429, "rate_limited", "too many wrong passwords; try again in a minute");
    if (!(await sharePasswordOk(c, { id: row.id, password_hash: row.password_hash }, pw))) {
      if (!(await c.env.LOGIN_LIMITER.limit({ key: `share:${row.id}` })).success)
        await c.env.DB.prepare("INSERT INTO kv_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
          .bind(`share_lock:${row.id}`, String(Date.now() + 60_000), Date.now())
          .run();
      throw new ApiError(401, "password_wrong", "wrong password");
    }
  }
  const path = new URL(c.req.url).pathname;
  const readOnly = c.req.method === "GET" || (c.req.method === "POST" && /\/(query|funnels\/analyze)$/.test(path));
  if (!readOnly || !SHARE_ALLOWED.test(path) || (path.startsWith("/api/v1/sites/") && path.split("/")[4] !== row.site_id)) throw new ApiError(403, "forbidden", "share links are read-only and limited to one site's reports");
  let filters: Principal["filters"];
  if (row.view_id) {
    const view = await c.env.DB.prepare("SELECT filters_json FROM saved_views WHERE id = ? AND site_id = ?").bind(row.view_id, row.site_id).first<{ filters_json: string }>();
    // The view was deleted: fail closed rather than showing unfiltered data.
    if (!view) throw new ApiError(401, "share_invalid", "this share link's view no longer exists");
    filters = JSON.parse(view.filters_json) as Principal["filters"];
    if (SHARE_UNFILTERED.test(path)) throw new ApiError(403, "forbidden", "this share link shows a filtered view; realtime and retention aren't available");
  }
  c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE share_links SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run());
  return { kind: "share", id: row.id, label: `share:${row.id.slice(-6)}`, scopes: ["stats:read"], siteIds: [row.site_id], ...(filters?.length ? { filters } : {}) };
}

/** Bearer API key, share link, or dashboard session cookie (with Origin + X-Pulse-Client checks). */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const share = c.req.header("x-pulse-share");
  if (share) {
    c.set("principal", await shareAuth(c as Ctx, share));
    return next();
  }
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const p = await verifyApiKey(c.env.DB, auth.slice(7).trim(), c.executionCtx);
    if (!p) throw new ApiError(401, "unauthorized", "invalid or expired API key");
    const rl = await c.env.API_LIMITER.limit({ key: `key:${p.id}` });
    if (!rl.success) {
      c.header("RateLimit-Policy", "600;w=60");
      c.header("Retry-After", "60");
      throw new ApiError(429, "rate_limited", "rate limit exceeded");
    }
    c.header("RateLimit-Policy", "600;w=60");
    c.set("principal", p);
    return next();
  }
  const props = (c.executionCtx as ExecutionContext & { props?: { principal?: Principal } }).props;
  if (props?.principal) {
    c.set("principal", props.principal);
    return next();
  }
  const token = readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE);
  const s = await verifySession(c.env.DB, token);
  if (!s) throw new ApiError(401, "unauthorized", "authentication required");
  if (c.req.header("x-pulse-client") !== "dashboard") throw new ApiError(403, "forbidden", "missing X-Pulse-Client header");
  const origin = c.req.header("origin");
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && origin !== c.env.PUBLIC_ORIGIN)
    throw new ApiError(403, "forbidden", "cross-origin request");
  if (s.refreshed) c.header("Set-Cookie", sessionCookie(s.refreshed.token, s.refreshed.expiresAt));
  c.set("principal", s.principal);
  return next();
};

export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hasScope(c.get("principal"), scope)) throw new ApiError(403, "insufficient_scope", `requires scope ${scope}`);
    return next();
  };
}

/** Resolve `:site` from the path and check the principal may read it. */
export const requireSite: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.param("site");
  if (!id) throw new ApiError(400, "invalid_request", "site required");
  const p = c.get("principal");
  if (!canAccessSite(p, id)) throw new ApiError(404, "site_not_found", "site not found");
  const site = await getSite(c.env.DB, id);
  if (!site) throw new ApiError(404, "site_not_found", "site not found");
  c.set("site", p.filters?.length ? { ...site, forcedFilters: p.filters } : site);
  return next();
};

export function metaFor(site: Site, extra: Record<string, unknown> = {}) {
  return { site: site.id, timezone: site.timezone, generated_at: new Date().toISOString(), ...extra };
}

/** Weak ETag + short private cache for reads. */
/**
 * A report through the edge cache. The key holds the site, the query string, a share link's forced filters and the
 * rollup watermark (new closed days or goal edits change it); answers whose range includes today live 60 s, others 10 min.
 */
export async function cachedReport<T>(c: Ctx, name: string, fn: () => Promise<T>, now = Date.now()): Promise<T> {
  const site = c.get("site");
  const { rollupState } = await import("../query/rollup.ts");
  const { resolveRange } = await import("../query/range.ts");
  const { edgeCached, sortedQuery } = await import("../lib/cache.ts");
  const st = await rollupState(c.env.DB, site.id, now);
  const qs = sortedQuery(c.req.url);
  const params = new URL(c.req.url).searchParams;
  const range = params.get("from") && params.get("to") ? { from: params.get("from")!, to: params.get("to")! } : (params.get("date_range") ?? "28d");
  let live = true;
  try {
    live = resolveRange(range as never, site.timezone, now, "2000-01-01").to >= localDay(now, site.timezone);
  } catch {
    live = true;
  }
  const key = [name, site.id, qs, JSON.stringify(site.forcedFilters ?? []), st ? `${st.version}.${st.built_through}.${st.goals_sig ?? ""}` : "raw"].join("|");
  const { value, hit } = await edgeCached(key, live ? 60 : 600, fn, c.executionCtx);
  c.header("X-Pulse-Cache", hit ? "hit" : "miss");
  return value;
}

function localDay(now: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

export async function jsonWithEtag(c: Ctx, body: unknown): Promise<Response> {
  const text = JSON.stringify(body);
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  const etag = `W/"${[...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag });
  return c.body(text, 200, { "Content-Type": "application/json", ETag: etag, "Cache-Control": "private, max-age=30" });
}

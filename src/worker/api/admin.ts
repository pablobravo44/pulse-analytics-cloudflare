// Admin: API keys (create, edit, rotate, revoke), people, audit log, imports. People are added by email (Settings → People) and sign in through Cloudflare Access; ACCESS_EMAILS are the first owners.
import { z, type OpenAPIHono } from "@hono/zod-openapi";
import { createApiKey, KEY_PREFIX } from "../auth/apikeys.ts";
import { hasScope, SCOPES, type Principal, type Scope } from "../auth/principal.ts";
import { forgetSessions } from "../auth/session.ts";
import { audit } from "../lib/audit.ts";
import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { onlyGiven } from "../lib/patch.ts";
import { ApiError, type AppEnv } from "./common.ts";
import { r } from "./route.ts";

const idParam = z.object({ id: z.string().min(1).max(64).openapi({ param: { name: "id", in: "path" } }) });

export interface KeyView {
  id: string;
  prefix: string;
  name: string;
  scopes: Scope[];
  site_ids: string[] | null;
  created_by: string;
  created_at: number;
  updated_at: number | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  status: "active" | "revoked" | "expired";
}

interface KeyRow {
  id: string;
  prefix: string;
  name: string;
  scopes_json: string;
  site_ids_json: string | null;
  created_by: string;
  created_at: number;
  updated_at: number | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

const KEY_COLS = "id, prefix, name, scopes_json, site_ids_json, created_by, created_at, updated_at, expires_at, last_used_at, revoked_at";

function keyView(k: KeyRow, now = Date.now()): KeyView {
  return {
    id: k.id,
    prefix: k.prefix,
    name: k.name,
    scopes: JSON.parse(k.scopes_json) as Scope[],
    site_ids: k.site_ids_json ? (JSON.parse(k.site_ids_json) as string[]) : null,
    created_by: k.created_by,
    created_at: k.created_at,
    updated_at: k.updated_at,
    expires_at: k.expires_at,
    last_used_at: k.last_used_at,
    revoked_at: k.revoked_at,
    status: k.revoked_at ? "revoked" : k.expires_at && k.expires_at < now ? "expired" : "active",
  };
}

/** Can this principal see and manage a key? Site-scoped principals only reach keys limited to their own sites. */
function keyWithin(p: Principal, k: Pick<KeyView, "site_ids">): boolean {
  return p.siteIds === null || (k.site_ids !== null && k.site_ids.every((s) => p.siteIds!.includes(s)));
}

export async function listKeys(db: D1Database, status: "active" | "revoked" | "all" = "all", p?: Principal): Promise<KeyView[]> {
  const { results } = await db.prepare(`SELECT ${KEY_COLS} FROM api_keys ORDER BY created_at DESC`).all<KeyRow>();
  return results
    .map((k) => keyView(k))
    .filter((k) => !p || keyWithin(p, k))
    .filter((k) => status === "all" || (status === "active" ? k.status !== "revoked" : k.status === "revoked"));
}

export async function getKey(db: D1Database, id: string): Promise<KeyView | null> {
  const row = await db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE id = ?`).bind(id).first<KeyRow>();
  return row ? keyView(row) : null;
}

/** A principal can only hand out scopes it has and sites it can reach. */
function checkGrant(p: Principal, scopes: Scope[] | undefined, siteIds: string[] | null | undefined) {
  if (scopes) {
    const missing = scopes.filter((s) => !hasScope(p, s));
    if (missing.length) throw new ApiError(403, "forbidden", `you can't grant scopes you don't have: ${missing.join(", ")}`);
  }
  if (siteIds !== undefined && p.siteIds !== null && (siteIds === null || siteIds.some((s) => !p.siteIds!.includes(s)))) {
    throw new ApiError(403, "forbidden", "you can't grant sites you can't access");
  }
}

async function checkSitesExist(db: D1Database, siteIds: string[] | null | undefined) {
  if (!siteIds?.length) return;
  const { results } = await db.prepare(`SELECT id FROM sites WHERE id IN (${siteIds.map(() => "?").join(",")})`).bind(...siteIds).all<{ id: string }>();
  const unknown = siteIds.filter((s) => !results.some((r) => r.id === s));
  if (unknown.length) throw new ApiError(400, "unknown_site", `unknown site(s): ${unknown.join(", ")}`);
}

export const keyPatch = z.object({
  name: z.string().min(1).max(80).optional(),
  scopes: z.array(z.enum(SCOPES)).min(1).optional(),
  site_ids: z.array(z.string().min(1).max(64)).min(1).nullable().optional().openapi({ description: "null = all sites, including ones added later" }),
  expires_at: z.string().datetime({ offset: true }).nullable().optional().openapi({ description: "ISO-8601, or null for no expiry" }),
});

export async function updateKey(db: D1Database, p: Principal, id: string, input: z.input<typeof keyPatch>): Promise<KeyView> {
  const b = onlyGiven(keyPatch.parse(input), input);
  const cur = await getKey(db, id);
  if (!cur || !keyWithin(p, cur)) throw new ApiError(404, "not_found", "key not found");
  if (cur.revoked_at) throw new ApiError(409, "key_revoked", "revoked keys can't be edited; create a new one");
  // Editing a key also means "granting" what it already has, so check both the old and new grants.
  checkGrant(p, cur.scopes, cur.site_ids);
  checkGrant(p, b.scopes, b.site_ids);
  await checkSitesExist(db, b.site_ids);
  const next = {
    name: b.name ?? cur.name,
    scopes: b.scopes ? [...new Set(b.scopes)] : cur.scopes,
    site_ids: b.site_ids === undefined ? cur.site_ids : b.site_ids ? [...new Set(b.site_ids)] : null,
    expires_at: b.expires_at === undefined ? cur.expires_at : b.expires_at === null ? null : Date.parse(b.expires_at),
  };
  await db
    .prepare("UPDATE api_keys SET name = ?, scopes_json = ?, site_ids_json = ?, expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(next.name, JSON.stringify(next.scopes), next.site_ids ? JSON.stringify(next.site_ids) : null, next.expires_at, Date.now(), id)
    .run();
  const changed = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
  await audit(db, p.label, "key.update", id, changed);
  return (await getKey(db, id))!;
}

export async function revokeKey(db: D1Database, p: Principal, id: string): Promise<void> {
  const cur = await getKey(db, id);
  if (!cur || !keyWithin(p, cur)) throw new ApiError(404, "not_found", "key not found or already revoked");
  const res = await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(Date.now(), id).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "key not found or already revoked");
  await audit(db, p.label, "key.revoke", id);
}

// ---------- People ----------

type Role = "owner" | "admin" | "viewer";
interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  site_ids_json: string | null;
  created_at: number;
  disabled_at: number | null;
}

function userView(u: UserRow) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, site_ids: u.site_ids_json ? (JSON.parse(u.site_ids_json) as string[]) : null, created_at: u.created_at, disabled_at: u.disabled_at };
}

/** People are instance-wide, so site-scoped principals can't manage them. */
export function requireAllSitesForPeople(p: Principal) {
  if (p.siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys can't manage people");
}

export async function listUsers(db: D1Database) {
  const { results } = await db.prepare("SELECT id, email, name, role, site_ids_json, created_at, disabled_at FROM users ORDER BY created_at").all<UserRow>();
  return results.map(userView);
}

async function activeOwners(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled_at IS NULL").first<{ n: number }>())?.n ?? 0;
}

export const userCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().max(120).nullable().optional(),
  role: z.enum(["owner", "admin", "viewer"]).default("viewer"),
  site_ids: z.array(z.string().min(1).max(64)).min(1).nullable().optional().openapi({ description: "Viewers only: the sites they can see; null or absent = all" }),
});

/**
 * Give someone access: they sign in with a one-time code sent to this email (Cloudflare Access), as long as the
 * Access policy lets the address request a code. Only owners add owners.
 */
export async function createUser(db: D1Database, p: Principal, input: z.input<typeof userCreate>) {
  requireAllSitesForPeople(p);
  const b = userCreate.parse(input);
  if (b.role === "owner" && p.role !== "owner") throw new ApiError(403, "forbidden", "only owners can add owners");
  if (await db.prepare("SELECT 1 AS x FROM users WHERE email = ?").bind(b.email).first()) throw new ApiError(409, "conflict", "someone with this email already has access (re-enable them if disabled)");
  await checkSitesExist(db, b.site_ids);
  const id = ulid();
  const siteIds = b.role === "viewer" && b.site_ids ? JSON.stringify(b.site_ids) : null;
  await db.prepare("INSERT INTO users (id, email, name, role, site_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, b.email, b.name ?? null, b.role, siteIds, Date.now()).run();
  await audit(db, p.label, "user.create", id, { email: b.email, role: b.role, site_ids: b.site_ids ?? null });
  return userView((await db.prepare("SELECT id, email, name, role, site_ids_json, created_at, disabled_at FROM users WHERE id = ?").bind(id).first<UserRow>())!);
}

export const userPatch = z.object({
  name: z.string().max(120).nullable().optional(),
  role: z.enum(["owner", "admin", "viewer"]).optional(),
  site_ids: z.array(z.string().min(1).max(64)).min(1).nullable().optional().openapi({ description: "Viewers only: the sites they can see; null = all" }),
});

export async function updateUser(db: D1Database, p: Principal, id: string, input: z.input<typeof userPatch>) {
  requireAllSitesForPeople(p);
  const b = onlyGiven(userPatch.parse(input), input);
  const cur = await db.prepare("SELECT id, email, name, role, site_ids_json, created_at, disabled_at FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!cur) throw new ApiError(404, "not_found", "user not found");
  if ((cur.role === "owner" || b.role === "owner") && p.role !== "owner") throw new ApiError(403, "forbidden", "only owners can change owners");
  if (cur.role === "owner" && b.role && b.role !== "owner" && !cur.disabled_at && (await activeOwners(db)) <= 1) throw new ApiError(409, "last_owner", "there must be at least one owner");
  await checkSitesExist(db, b.site_ids);
  const role = b.role ?? cur.role;
  const siteIds = b.site_ids === undefined ? cur.site_ids_json : b.site_ids ? JSON.stringify(b.site_ids) : null;
  await db.prepare("UPDATE users SET name = ?, role = ?, site_ids_json = ? WHERE id = ?").bind(b.name === undefined ? cur.name : b.name, role, siteIds, id).run();
  if (b.role || b.site_ids !== undefined) {
    await db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(id).run();
    forgetSessions();
  }
  await audit(db, p.label, "user.update", id, b);
  return userView((await db.prepare("SELECT id, email, name, role, site_ids_json, created_at, disabled_at FROM users WHERE id = ?").bind(id).first<UserRow>())!);
}

/** Disable a person and end their sessions. Only owners disable owners; the last active owner stays. */
export async function disableUser(db: D1Database, p: Principal, id: string) {
  requireAllSitesForPeople(p);
  if (id === p.id) throw new ApiError(409, "conflict", "you can't disable yourself");
  const u = await db.prepare("SELECT role, disabled_at FROM users WHERE id = ?").bind(id).first<{ role: Role; disabled_at: number | null }>();
  if (!u) throw new ApiError(404, "not_found", "user not found");
  if (u.role === "owner" && p.role !== "owner") throw new ApiError(403, "forbidden", "only owners can disable owners");
  if (u.role === "owner" && !u.disabled_at && (await activeOwners(db)) <= 1) throw new ApiError(409, "last_owner", "there must be at least one owner");
  await db.batch([db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").bind(Date.now(), id), db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(id)]);
  forgetSessions();
  await audit(db, p.label, "user.disable", id);
}

/** Re-enable a disabled person. Only owners re-enable owners. */
export async function enableUser(db: D1Database, p: Principal, id: string) {
  requireAllSitesForPeople(p);
  const u = await db.prepare("SELECT role FROM users WHERE id = ?").bind(id).first<{ role: Role }>();
  if (!u) throw new ApiError(404, "not_found", "user not found");
  if (u.role === "owner" && p.role !== "owner") throw new ApiError(403, "forbidden", "only owners can change owners");
  await db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").bind(id).run();
  await audit(db, p.label, "user.enable", id);
}

// ---------- Routes ----------

export function registerAdmin(api: OpenAPIHono<AppEnv>): void {
  const keyBody = z.object({
    name: z.string().min(1).max(80),
    scopes: z.array(z.enum(SCOPES)).min(1),
    site_ids: z.array(z.string()).nullable().default(null).openapi({ description: "null = all sites, including ones added later" }),
    expires_in_days: z.number().int().min(1).max(3650).optional(),
  });

  api.openapi(
    r({ method: "get", path: "/keys", tags: ["Admin"], description: "List API keys (never the secret)", scope: "admin", request: { query: z.object({ status: z.enum(["active", "revoked", "all"]).optional().openapi({ description: "Default all" }) }) } }),
    async (c) => c.json({ data: await listKeys(c.env.DB, (c.req.query("status") as "active" | "revoked" | "all" | undefined) ?? "all", c.get("principal")) }),
  );

  api.openapi(r({ method: "get", path: "/keys/{id}", tags: ["Admin"], description: "One API key (never the secret)", request: { params: idParam }, scope: "admin" }), async (c) => {
    const k = await getKey(c.env.DB, c.req.param("id") ?? "");
    if (!k || !keyWithin(c.get("principal"), k)) throw new ApiError(404, "not_found", "key not found");
    return c.json({ data: k });
  });

  api.openapi(r({ method: "post", path: "/keys", tags: ["Admin"], description: "Create an API key. The secret is shown once.", request: { body: { content: { "application/json": { schema: keyBody } } } }, scope: "admin" }), async (c) => {
    const b = keyBody.parse(await c.req.json());
    const p = c.get("principal");
    checkGrant(p, b.scopes as Scope[], b.site_ids);
    await checkSitesExist(c.env.DB, b.site_ids);
    const k = await createApiKey(c.env.DB, { name: b.name, scopes: b.scopes as Scope[], siteIds: b.site_ids, createdBy: p.label, expiresAt: b.expires_in_days ? Date.now() + b.expires_in_days * 86_400_000 : null });
    c.executionCtx.waitUntil(audit(c.env.DB, p.label, "key.create", k.id, { name: b.name, scopes: b.scopes, site_ids: b.site_ids }));
    return c.json({ data: { id: k.id, prefix: k.prefix, key: k.key, name: b.name, scopes: b.scopes, site_ids: b.site_ids } }, 201 as 200);
  });

  api.openapi(
    r({ method: "patch", path: "/keys/{id}", tags: ["Admin"], description: "Edit an API key's name, scopes, sites or expiry. Takes effect on the key's next request.", request: { params: idParam, body: { content: { "application/json": { schema: keyPatch } } } }, scope: "admin" }),
    async (c) => c.json({ data: await updateKey(c.env.DB, c.get("principal"), c.req.param("id") ?? "", await c.req.json()) }),
  );

  api.openapi(r({ method: "post", path: "/keys/{id}/rotate", tags: ["Admin"], description: "Replace a key's secret (same name, scopes and sites). The new secret is shown once; the old one stops working now.", request: { params: idParam }, scope: "admin" }), async (c) => {
    const id = c.req.param("id") ?? "";
    const p = c.get("principal");
    const cur = await getKey(c.env.DB, id);
    if (!cur || !keyWithin(p, cur)) throw new ApiError(404, "not_found", "key not found");
    if (cur.revoked_at) throw new ApiError(409, "key_revoked", "revoked keys can't be rotated");
    checkGrant(p, cur.scopes, cur.site_ids);
    const key = KEY_PREFIX + randomToken(32);
    const prefix = key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8);
    await c.env.DB.prepare("UPDATE api_keys SET hash = ?, prefix = ?, updated_at = ?, last_used_at = NULL WHERE id = ?").bind(await sha256Hex(key), prefix, Date.now(), id).run();
    c.executionCtx.waitUntil(audit(c.env.DB, p.label, "key.rotate", id));
    return c.json({ data: { ...(await getKey(c.env.DB, id))!, key } });
  });

  api.openapi(r({ method: "delete", path: "/keys/{id}", tags: ["Admin"], description: "Revoke an API key", request: { params: idParam }, scope: "admin" }), async (c) => {
    await revokeKey(c.env.DB, c.get("principal"), c.req.param("id") ?? "");
    return c.json({ data: { revoked: true } });
  });

  api.openapi(r({ method: "get", path: "/users", tags: ["Admin"], description: "List people with access", scope: "admin" }), async (c) => {
    requireAllSitesForPeople(c.get("principal"));
    return c.json({ data: await listUsers(c.env.DB) });
  });

  api.openapi(
    r({ method: "post", path: "/users", tags: ["Admin"], description: "Give someone access: they sign in with a one-time code sent to their email", request: { body: { content: { "application/json": { schema: userCreate } } } }, scope: "admin" }),
    async (c) => c.json({ data: await createUser(c.env.DB, c.get("principal"), await c.req.json()) }, 201),
  );

  api.openapi(
    r({ method: "patch", path: "/users/{id}", tags: ["Admin"], description: "Change a person's name, role or site access (ends their sessions when access changes)", request: { params: idParam, body: { content: { "application/json": { schema: userPatch } } } }, scope: "admin" }),
    async (c) => c.json({ data: await updateUser(c.env.DB, c.get("principal"), c.req.param("id") ?? "", await c.req.json()) }),
  );

  api.openapi(r({ method: "delete", path: "/users/{id}", tags: ["Admin"], description: "Disable a person and end their sessions", request: { params: idParam }, scope: "admin" }), async (c) => {
    await disableUser(c.env.DB, c.get("principal"), c.req.param("id") ?? "");
    return c.json({ data: { disabled: true } });
  });

  api.openapi(r({ method: "post", path: "/users/{id}/enable", tags: ["Admin"], description: "Re-enable a disabled person", request: { params: idParam }, scope: "admin" }), async (c) => {
    await enableUser(c.env.DB, c.get("principal"), c.req.param("id") ?? "");
    return c.json({ data: { enabled: true } });
  });

  api.openapi(
    r({ method: "get", path: "/audit", tags: ["Admin"], description: "Audit log, newest first (who changed what)", scope: "admin", request: { query: z.object({ action: z.string().max(40).optional().openapi({ description: "Prefix, e.g. key. or site." }), limit: z.coerce.number().int().min(1).max(500).optional() }) } }),
    async (c) => {
      const action = c.req.query("action");
      const limit = Number(c.req.query("limit") ?? 200);
      const { results } = await c.env.DB.prepare(action ? "SELECT * FROM audit_log WHERE action LIKE ? ORDER BY ts DESC LIMIT ?" : "SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?")
        .bind(...(action ? [`${action.replace(/[%_]/g, "")}%`, limit] : [limit]))
        .all();
      return c.json({ data: results });
    },
  );

  api.openapi(r({ method: "get", path: "/imports", tags: ["Admin"], description: "Import history", scope: "admin" }), async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM imports ORDER BY created_at DESC LIMIT 100").all();
    return c.json({ data: results });
  });
}

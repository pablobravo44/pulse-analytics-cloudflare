import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import type { Waiter } from "../env.ts";
import type { Principal, Scope } from "./principal.ts";

export const KEY_PREFIX = "pulse_sk_";

export interface ApiKeyRow {
  id: string;
  prefix: string;
  hash: string;
  name: string;
  scopes_json: string;
  site_ids_json: string | null;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export function isApiKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX) && token.length > KEY_PREFIX.length + 40;
}

export async function createApiKey(
  db: D1Database,
  input: { name: string; scopes: Scope[]; siteIds: string[] | null; createdBy: string; expiresAt?: number | null },
): Promise<{ id: string; key: string; prefix: string }> {
  const key = KEY_PREFIX + randomToken(32);
  const id = ulid();
  const prefix = key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8);
  await db
    .prepare(
      "INSERT INTO api_keys (id, prefix, hash, name, scopes_json, site_ids_json, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, prefix, await sha256Hex(key), input.name, JSON.stringify(input.scopes), input.siteIds ? JSON.stringify(input.siteIds) : null, input.createdBy, Date.now(), input.expiresAt ?? null)
    .run();
  return { id, key, prefix };
}

export async function verifyApiKey(db: D1Database, token: string, ctx?: Waiter): Promise<Principal | null> {
  if (!isApiKey(token)) return null;
  const row = await db.prepare("SELECT * FROM api_keys WHERE hash = ?").bind(await sha256Hex(token)).first<ApiKeyRow>();
  const now = Date.now();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < now)) return null;
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    const p = db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
    if (ctx) ctx.waitUntil(p);
    else await p;
  }
  return {
    kind: "key",
    id: row.id,
    label: `key:${row.prefix}`,
    scopes: JSON.parse(row.scopes_json) as Scope[],
    siteIds: row.site_ids_json ? (JSON.parse(row.site_ids_json) as string[]) : null,
  };
}

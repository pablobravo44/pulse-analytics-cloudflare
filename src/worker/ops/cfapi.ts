// Minimal Cloudflare REST client for ops jobs (PULSE_OPS_TOKEN: D1 Edit + Account Settings Read).
import type { Env } from "../env.ts";

let discovered: { token: string; id: string } | null = null;

/**
 * The account the ops token works on: CF_ACCOUNT_ID when set, otherwise the only account the token can see
 * (looked up once per isolate). A token that sees several accounts needs CF_ACCOUNT_ID.
 */
export async function accountId(env: Env): Promise<string> {
  if (env.CF_ACCOUNT_ID) return env.CF_ACCOUNT_ID;
  if (discovered && discovered.token === env.PULSE_OPS_TOKEN) return discovered.id;
  const res = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=5", { headers: { Authorization: `Bearer ${env.PULSE_OPS_TOKEN}` } });
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { id: string }[] };
  if (!res.ok || !j.success || !j.result?.length) throw new Error(`CF API /accounts: ${res.status}; set CF_ACCOUNT_ID or give PULSE_OPS_TOKEN Account Settings Read`);
  if (j.result.length > 1) throw new Error("PULSE_OPS_TOKEN can see several accounts: set the CF_ACCOUNT_ID variable");
  discovered = { token: env.PULSE_OPS_TOKEN!, id: j.result[0]!.id };
  return discovered.id;
}

export async function cf<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.PULSE_OPS_TOKEN) throw new Error("PULSE_OPS_TOKEN not configured");
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${await accountId(env)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.PULSE_OPS_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const j = (await res.json()) as { success: boolean; result: T; errors?: { message: string }[] };
  if (!res.ok || !j.success) throw new Error(`CF API ${path}: ${res.status} ${(j.errors ?? []).map((e) => e.message).join("; ")}`);
  return j.result;
}

export interface D1Info {
  uuid: string;
  name: string;
  file_size?: number;
  num_tables?: number;
}

export async function listD1(env: Env): Promise<D1Info[]> {
  const out: D1Info[] = [];
  for (let page = 1; page < 20; page++) {
    const r = await cf<D1Info[]>(env, `/d1/database?per_page=100&page=${page}`);
    out.push(...r);
    if (r.length < 100) break;
  }
  return out;
}

export async function d1Query<T>(env: Env, uuid: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await cf<{ results: T[] }[]>(env, `/d1/database/${uuid}/query`, { method: "POST", body: JSON.stringify({ sql, params }) });
  return r[0]?.results ?? [];
}

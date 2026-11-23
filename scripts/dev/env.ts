// Bindings for running the real Worker in Node (where workerd can't run, e.g. some Windows machines).
// D1 is node:sqlite on a file, the queue calls the consumer directly, assets come from dist/public.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Env } from "../../src/worker/env.ts";
import { processHit } from "../../src/worker/queue/consumer.ts";
import { createD1, migrate } from "../../test/unit/d1-shim.ts";

export const DEV_ORIGIN = process.env.PULSE_DEV_ORIGIN ?? "http://localhost:8787";
export const DEV_DB = process.env.PULSE_DEV_DB ?? ".data/dev.sqlite";
const PUBLIC_DIR = "dist/public";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function asset(req: Request): Response {
  const path = decodeURIComponent(new URL(req.url).pathname);
  const file = normalize(join(PUBLIC_DIR, path));
  if (file.startsWith(normalize(PUBLIC_DIR)) && existsSync(file) && statSync(file).isFile()) {
    return new Response(readFileSync(file), { headers: { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" } });
  }
  // not_found_handling: single-page-application
  const index = join(PUBLIC_DIR, "index.html");
  if (!/\.[a-z0-9]{2,5}$/i.test(path) && existsSync(index)) return new Response(readFileSync(index), { headers: { "Content-Type": TYPES[".html"]! } });
  return new Response("not found", { status: 404 });
}

class MemKV {
  m = new Map<string, { v: string; exp?: number; metadata?: unknown }>();
  async get(k: string, type?: string | { type?: string }) {
    const e = this.m.get(k);
    if (!e || (e.exp && e.exp < Date.now())) return null;
    const t = typeof type === "string" ? type : type?.type;
    return t === "json" ? JSON.parse(e.v) : e.v;
  }
  async getWithMetadata(k: string, type?: string | { type?: string }) {
    const value = await this.get(k, type);
    return { value, metadata: value === null ? null : (this.m.get(k)?.metadata ?? null) };
  }
  async put(k: string, v: string, o?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
    this.m.set(k, { v, exp: o?.expirationTtl ? Date.now() + o.expirationTtl * 1000 : o?.expiration ? o.expiration * 1000 : undefined, metadata: o?.metadata });
  }
  async delete(k: string) {
    this.m.delete(k);
  }
  async list(o: { prefix?: string } = {}) {
    const keys = [...this.m.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).sort().map((name) => ({ name, metadata: this.m.get(name)?.metadata }));
    return { keys, list_complete: true, cursor: "" };
  }
}

export function devEnv(): { env: Env; db: ReturnType<typeof createD1>; applied: string[] } {
  mkdirSync(".data", { recursive: true });
  const db = createD1(DEV_DB);
  const applied = migrate(db, true);
  const allow = { limit: async () => ({ success: true }) };
  const env = {
    ENVIRONMENT: "development",
    PUBLIC_ORIGIN: DEV_ORIGIN,
    RP_ID: new URL(DEV_ORIGIN).hostname,
    DB: db,
    EVENTS: {
      send: async (h: Parameters<typeof processHit>[1]) => processHit(db, h),
      sendBatch: async (msgs: { body: Parameters<typeof processHit>[1] }[]) => {
        for (const m of msgs) await processHit(db, m.body);
      },
    },
    OAUTH_KV: new MemKV(),
    BACKUPS: { put: async () => null, list: async () => ({ objects: [], delimitedPrefixes: [] }), delete: async () => {} },
    ASSETS: { fetch: async (r: Request) => asset(r) },
    INGEST_LIMITER: allow,
    API_LIMITER: allow,
    LOGIN_LIMITER: allow,
    PULSE_SECRET_KEY: process.env.PULSE_SECRET_KEY ?? "ZGV2LW9ubHktc2VjcmV0LWtleS0zMi1ieXRlcy0hISE=",
  } as unknown as Env;
  return { env, db, applied };
}

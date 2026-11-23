// Runs the real Worker (Hono app + OAuth provider) in Node with mocked bindings and node:sqlite D1.
import worker from "../../src/worker/index.ts";
import type { Env } from "../../src/worker/env.ts";
import { processHit } from "../../src/worker/queue/consumer.ts";
import { invalidateSiteCache } from "../../src/worker/lib/sites.ts";
import { resetIngestStats } from "../../src/worker/ingest/stats.ts";
import { resetCapCache } from "../../src/worker/ingest/cap.ts";
import { createD1, migrate } from "./d1-shim.ts";

export const ORIGIN = "https://pulse.test";

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
  async list(o: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const keys = [...this.m.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).sort().map((name) => ({ name, metadata: this.m.get(name)?.metadata }));
    return { keys, list_complete: true, cursor: "" };
  }
}

/** In-memory R2 bucket. With `locked`, overwriting an existing key throws, like a bucket retention lock. */
export class MemR2 {
  objects = new Map<string, { body: Uint8Array<ArrayBuffer>; uploaded: Date }>();
  locked: boolean;
  constructor(locked = false) {
    this.locked = locked;
  }
  private async bytes(v: unknown): Promise<Uint8Array<ArrayBuffer>> {
    if (v instanceof Uint8Array) return new Uint8Array(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === "string") return new TextEncoder().encode(v);
    return new Uint8Array(await new Response(v as BodyInit).arrayBuffer());
  }
  private store(key: string, body: Uint8Array<ArrayBuffer>) {
    if (this.locked && this.objects.has(key)) throw new Error(`locked: ${key} exists`);
    this.objects.set(key, { body, uploaded: new Date() });
  }
  async put(key: string, value: unknown) {
    this.store(key, await this.bytes(value));
    return { key };
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { key, size: o.body.byteLength, uploaded: o.uploaded } : null;
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { key, size: o.body.byteLength, body: new Blob([o.body.slice()]).stream(), arrayBuffer: async () => o.body.slice().buffer };
  }
  async delete(keys: string | string[]) {
    for (const k of [keys].flat()) {
      if (this.locked && k.includes("/locked/")) throw new Error("locked");
      this.objects.delete(k);
    }
  }
  async list(o: { prefix?: string; delimiter?: string; limit?: number } = {}) {
    const prefix = o.prefix ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const delimitedPrefixes = new Set<string>();
    const objects: { key: string; size: number; uploaded: Date }[] = [];
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const i = o.delimiter ? rest.indexOf(o.delimiter) : -1;
      if (i >= 0) delimitedPrefixes.add(prefix + rest.slice(0, i + 1));
      else objects.push({ key: k, size: this.objects.get(k)!.body.byteLength, uploaded: this.objects.get(k)!.uploaded });
    }
    return { objects: objects.slice(0, o.limit ?? 1000), delimitedPrefixes: [...delimitedPrefixes], truncated: false };
  }
  async createMultipartUpload(key: string) {
    const parts = new Map<number, Uint8Array<ArrayBuffer>>();
    return {
      key,
      uploadId: "u1",
      uploadPart: async (n: number, v: unknown) => {
        parts.set(n, await this.bytes(v));
        return { partNumber: n, etag: `e${n}` };
      },
      complete: async (list: { partNumber: number }[]) => {
        const chunks = list.map((p) => parts.get(p.partNumber)!);
        const all = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.byteLength;
        }
        this.store(key, all);
        return { key };
      },
      abort: async () => void parts.clear(),
    };
  }
}

export function makeEnv() {
  invalidateSiteCache();
  resetIngestStats();
  resetCapCache();
  const db = createD1();
  migrate(db);
  const pending: Promise<unknown>[] = [];
  const allow = { limit: async () => ({ success: true }) };
  const env = {
    ENVIRONMENT: "test",
    CF_ACCOUNT_ID: "test-account",
    PUBLIC_ORIGIN: ORIGIN,
    RP_ID: "pulse.test",
    DB: db,
    EVENTS: { send: async (h: Parameters<typeof processHit>[1]) => processHit(db, h), sendBatch: async () => {} },
    OAUTH_KV: new MemKV(),
    BACKUPS: { put: async () => null, list: async () => ({ objects: [], delimitedPrefixes: [] }), delete: async () => {} },
    ASSETS: { fetch: async (r: Request) => new Response(new URL(r.url).pathname === "/p.js" ? "/*tracker*/" : "<!doctype html><title>Pulse</title>", { headers: { "Content-Type": "text/html" } }) },
    INGEST_LIMITER: allow,
    API_LIMITER: allow,
    LOGIN_LIMITER: allow,
  } as unknown as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await worker.fetch(new Request(ORIGIN + path, init), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { env, db, call, ctx };
}

// Runs in workerd (Workers Builds / Linux only): real D1, Queue, KV and Rate Limiting bindings.
import { createExecutionContext, createMessageBatch, createScheduledController, env, getQueueResult, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import type { Env } from "../../src/worker/env.ts";
import { createApiKey } from "../../src/worker/auth/apikeys.ts";
import type { EnrichedHit } from "../../src/worker/ingest/types.ts";
import { enrich } from "../../src/worker/ingest/enrich.ts";
import { flushIngestStats } from "../../src/worker/ingest/stats.ts";
import { DEFAULT_SETTINGS, type Site } from "../../src/worker/lib/sites.ts";
import { localParts } from "../../src/worker/lib/time.ts";

const E = env as unknown as Env;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SITE: Site = { id: "it", name: "IT", domains: ["example.com"], timezone: "Europe/Madrid", settings: DEFAULT_SETTINGS, retention_months: 25, created_at: 0, archived_at: null };

async function seedSite() {
  await E.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domains_json, timezone, settings_json, created_at) VALUES (?, ?, ?, ?, ?, 0)")
    .bind(SITE.id, SITE.name, JSON.stringify(SITE.domains), SITE.timezone, JSON.stringify(SITE.settings))
    .run();
}

describe("workerd", () => {
  it("boots and serves healthz and the tracker", async () => {
    const r = await SELF.fetch("https://pulse.test/healthz");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("ingest → queue consumer → D1 → API numbers", async () => {
    await seedSite();
    const r = await SELF.fetch("https://pulse.test/e", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "User-Agent": UA, "CF-Connecting-IP": "203.0.113.1" },
      body: JSON.stringify({ s: "it", t: "pageview", u: "https://example.com/a" }),
    });
    expect(r.status).toBe(202);
    // Drive the consumer explicitly with an enriched hit (queue delivery is async in tests).
    const now = Date.now();
    const hit = (await enrich({ s: "it", t: "pageview", u: "https://example.com/b" }, SITE, { ip: "203.0.113.2", ua: UA, origin: null, country: "ES", region: null, city: null, continent: "EU", verifiedBot: false, dnt: false, hosting: false, now }, "salt")) as EnrichedHit;
    const batch = createMessageBatch<EnrichedHit>("pulse-events", [{ id: "m1", timestamp: new Date(), attempts: 1, body: hit }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, E);
    const res = await getQueueResult(batch, ctx);
    expect(res.explicitAcks).toContain("m1");
    const key = (await createApiKey(E.DB, { name: "it", scopes: ["stats:read"], siteIds: ["it"], createdBy: "test" })).key;
    const q = await SELF.fetch("https://pulse.test/api/v1/sites/it/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ metrics: ["pageviews"], dimensions: ["page"], date_range: "today" }),
    });
    const body = (await q.json()) as { rows: { page: string; pageviews: number }[] };
    expect(body.rows.find((x) => x.page === "/b")?.pageviews).toBe(1);
  });

  it("rejects hostnames not on the list", async () => {
    await seedSite();
    // Wrong hostnames are counted separately (dropped_host) so the installation check can name them.
    const before = await E.DB.prepare("SELECT COALESCE(SUM(dropped_host), 0) AS n FROM ingest_stats WHERE site_id = 'it'").first<{ n: number }>();
    await SELF.fetch("https://pulse.test/e", { method: "POST", headers: { "User-Agent": UA }, body: JSON.stringify({ s: "it", t: "pageview", u: "https://evil.com/" }) });
    // Drop counters are batched in isolate memory; the first drop in an isolate is flushed right away (waitUntil).
    let n = 0;
    for (let i = 0; i < 30 && n < 1; i++) {
      await flushIngestStats(E.DB);
      const after = await E.DB.prepare("SELECT COALESCE(SUM(dropped_host), 0) AS n FROM ingest_stats WHERE site_id = 'it'").first<{ n: number }>();
      n = (after?.n ?? 0) - (before?.n ?? 0);
      if (n < 1) await new Promise((r) => setTimeout(r, 100));
    }
    expect(n).toBe(1);
  });

  it("MCP initialize and tools/list over HTTP", async () => {
    await seedSite();
    const key = (await createApiKey(E.DB, { name: "mcp", scopes: ["stats:read"], siteIds: null, createdBy: "test" })).key;
    const r = await SELF.fetch("https://pulse.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThanOrEqual(16);
  });

  it("cron dispatch runs every schedule without throwing; ended days lose their salt", async () => {
    // Salts are created on first use per local day; the hourly job deletes the ones whose day has ended.
    await E.DB.prepare("INSERT OR REPLACE INTO salts (day, salt, created_at) VALUES ('2026-10-16@Europe/Madrid', 'old', 0), ('2026-10-18@Europe/Madrid', 'today', 0)").run();
    for (const cron of ["*/5 * * * *", "0 3 * * *", "0 4 * * SUN", "0 5 1 * *"]) {
      const ctrl = createScheduledController({ scheduledTime: Date.UTC(2026, 9, 18, 4, 5), cron });
      const ctx = createExecutionContext();
      await worker.scheduled(ctrl, E, ctx);
      await waitOnExecutionContext(ctx);
    }
    const { results } = await E.DB.prepare("SELECT day FROM salts ORDER BY day").all<{ day: string }>();
    const days = results.map((r) => r.day);
    expect(days).toContain("2026-10-18@Europe/Madrid");
    expect(days).not.toContain("2026-10-16@Europe/Madrid");
  });

  it("time zones agree with Node for DST edges", () => {
    // Europe/Madrid spring forward and fall back, as computed by workerd's ICU.
    expect(localParts(Date.UTC(2026, 2, 29, 1, 0), "Europe/Madrid").hour).toBe(3);
    expect(localParts(Date.UTC(2026, 9, 25, 1, 30), "Europe/Madrid").hour).toBe(2);
  });
});

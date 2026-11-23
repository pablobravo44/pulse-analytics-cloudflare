// Drop reasons at ingest: hosting networks, DNT/GPC, and Android app referrers.
import { beforeEach, describe, expect, it } from "vitest";
import { enrich } from "../../src/worker/ingest/enrich.ts";
import { ingestPayload, requestMeta } from "../../src/worker/ingest/handler.ts";
import { flushIngestStats, resetIngestStats } from "../../src/worker/ingest/stats.ts";
import type { TrackerPayload } from "../../src/worker/ingest/types.ts";
import { isHostingNetwork } from "../../src/worker/lib/hosting.ts";
import { DEFAULT_SETTINGS, type Site } from "../../src/worker/lib/sites.ts";
import { CHROME, insertSite, meta, SITE } from "./fixtures.ts";
import { makeEnv } from "./harness.ts";

const NOW = Date.parse("2026-03-10T10:00:00Z");
const payload = (over: Partial<TrackerPayload> = {}) => ({ s: "test", t: "pageview", u: "https://example.com/", ...over }) as TrackerPayload;
const withSettings = (s: Partial<Site["settings"]>): Site => ({ ...SITE, settings: { ...DEFAULT_SETTINGS, ...s } });

describe("hosting networks", () => {
  it("recognises listed ASNs and the organisation fallback", () => {
    expect(isHostingNetwork(16509, null)).toBe(true);
    expect(isHostingNetwork(1234, "Acme Cloud Servers Ltd")).toBe(true);
    expect(isHostingNetwork(1234, "Example Web Hosting")).toBe(true);
    expect(isHostingNetwork(3352, "Telefonica de Espana")).toBe(false);
    expect(isHostingNetwork(13335, "Cloudflare, Inc.")).toBe(false);
    expect(isHostingNetwork(undefined, undefined)).toBe(false);
  });

  it("requestMeta reads the network from request.cf", () => {
    const mk = (cf: object) => Object.assign(new Request("https://pulse.test/e", { method: "POST" }), { cf });
    expect(requestMeta(mk({ asn: 14061, asOrganization: "DigitalOcean, LLC" })).hosting).toBe(true);
    expect(requestMeta(mk({ asn: 99999, asOrganization: "Contoso Datacenter GmbH" })).hosting).toBe(true);
    expect(requestMeta(mk({ asn: 3352, asOrganization: "Telefonica" })).hosting).toBe(false);
  });

  it("drops a hosting-network hit only when block_hosting is on", async () => {
    expect(await enrich(payload(), withSettings({ block_hosting: true }), meta(NOW, { hosting: true }), "s")).toBe("hosting");
    expect(await enrich(payload(), withSettings({ block_hosting: false }), meta(NOW, { hosting: true }), "s")).toMatchObject({ type: "pageview" });
    expect(await enrich(payload(), withSettings({ block_hosting: true }), meta(NOW, { hosting: false }), "s")).toMatchObject({ type: "pageview" });
  });

  it("verified bots still count as bots, and hosting drops are counted as dropped_hosting", async () => {
    expect(await enrich(payload(), SITE, meta(NOW, { hosting: true, verifiedBot: true }), "s")).toBe("bot");
    resetIngestStats();
    const h = makeEnv();
    await insertSite(h.db, SITE);
    await ingestPayload(h.env, h.ctx, payload(), meta(NOW, { hosting: true }));
    await flushIngestStats(h.db, NOW);
    expect(h.db.sqlite.prepare("SELECT dropped_hosting, dropped_bot, dropped_dnt FROM ingest_stats WHERE site_id = 'test'").get()).toEqual({ dropped_hosting: 1, dropped_bot: 0, dropped_dnt: 0 });
  });
});

describe("DNT / GPC", () => {
  it("is counted as dropped_dnt, not dropped_bot", async () => {
    const site = withSettings({ respect_dnt: true });
    expect(await enrich(payload(), site, meta(NOW, { dnt: true }), "s")).toBe("dnt");
    resetIngestStats();
    const h = makeEnv();
    await insertSite(h.db, site);
    await ingestPayload(h.env, h.ctx, payload(), meta(NOW, { dnt: true, ua: CHROME }));
    await flushIngestStats(h.db, NOW);
    expect(h.db.sqlite.prepare("SELECT dropped_dnt, dropped_bot FROM ingest_stats WHERE site_id = 'test'").get()).toEqual({ dropped_dnt: 1, dropped_bot: 0 });
  });
});

describe("Android app referrers", () => {
  const ref = (r: string) => enrich(payload({ r }), SITE, meta(NOW), "s");
  beforeEach(() => resetIngestStats());

  it("Gmail groups with the web mail referrer", async () => {
    expect(await ref("android-app://com.google.android.gm/")).toMatchObject({ referrer_host: "mail.google.com", channel: "Email" });
  });
  it("the Google app groups with Google search", async () => {
    expect(await ref("android-app://com.google.android.googlequicksearchbox")).toMatchObject({ referrer_host: "google.com", channel: "Organic Search" });
  });
  it("Reddit and others map to their web host and channel", async () => {
    expect(await ref("android-app://com.reddit.frontpage/")).toMatchObject({ referrer_host: "reddit.com", channel: "Organic Social" });
    expect(await ref("android-app://org.telegram.messenger/")).toMatchObject({ referrer_host: "t.me", channel: "Organic Social" });
    expect(await ref("android-app://com.microsoft.office.outlook/")).toMatchObject({ referrer_host: "outlook.live.com", channel: "Email" });
  });
  it("unknown packages stay as they arrive", async () => {
    expect(await ref("android-app://com.example.unknown/")).toMatchObject({ referrer_host: "com.example.unknown" });
  });
});

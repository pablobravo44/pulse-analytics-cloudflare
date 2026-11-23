// Channels, alerts, saved views, share links, tracked links, explorers, revenue, site search, exclusions.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../../src/worker/auth/apikeys.ts";
import { invalidateSiteCache } from "../../src/worker/lib/sites.ts";
import { flushIngestStats } from "../../src/worker/ingest/stats.ts";
import { resetCapCache } from "../../src/worker/ingest/cap.ts";
import { evaluateAlerts } from "../../src/worker/ops/alerts.ts";
import { CHROME, insertSite, OTHER, SITE } from "./fixtures.ts";
import { makeEnv } from "./harness.ts";

let h: ReturnType<typeof makeEnv>;
let admin: string;
const SECRET = btoa("0123456789abcdef0123456789abcdef");

const req = (method: string, path: string, k: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  h.call(path, { method, headers: { ...(k ? { Authorization: `Bearer ${k}` } : {}), "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
const ingest = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  h.call("/e", { method: "POST", body: JSON.stringify({ s: "test", t: "pageview", ...body }), headers: { "Content-Type": "text/plain", "User-Agent": CHROME, "CF-Connecting-IP": "203.0.113.9", ...headers } });

beforeEach(async () => {
  h = makeEnv();
  await insertSite(h.db, SITE);
  await insertSite(h.db, OTHER);
  admin = (await createApiKey(h.db, { name: "admin", scopes: ["admin"], siteIds: null, createdBy: "test" })).key;
});
afterEach(() => vi.unstubAllGlobals());

describe("notification channels", () => {
  it("needs PULSE_SECRET_KEY for secret-bearing kinds, seals them and never shows the URL", async () => {
    const body = { name: "Hook", kind: "webhook", config: { url: "https://hooks.example.com/abc/xyz123" } };
    expect((await req("POST", "/api/v1/ops/channels", admin, body)).status).toBe(422);
    Object.assign(h.env, { PULSE_SECRET_KEY: SECRET });
    const r = await json<{ data: { channel: { id: string; target: string }; signing_secret: string } }>(await req("POST", "/api/v1/ops/channels", admin, body));
    expect(r.data.signing_secret.length).toBeGreaterThan(20);
    expect(r.data.channel.target).toBe("hooks.example.com/…/z123");
    const raw = h.db.sqlite.prepare("SELECT config_enc FROM notification_channels WHERE id = ?").get(r.data.channel.id) as { config_enc: string };
    expect(raw.config_enc).not.toContain("hooks.example.com");
    const list = JSON.stringify(await json(await req("GET", "/api/v1/ops/channels", admin)));
    expect(list).not.toContain("xyz123");
    expect((await req("POST", "/api/v1/ops/channels", admin, { name: "S", kind: "slack", config: { url: "https://evil.com/x" } })).status).toBe(400);

    const sent: { url: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, headers: new Headers(init.headers), body: String(init.body) });
      return new Response("ok");
    });
    const t = await json<{ data: { sent: boolean } }>(await req("POST", `/api/v1/ops/channels/${r.data.channel.id}/test`, admin));
    expect(t.data.sent).toBe(true);
    expect(sent[0]!.url).toBe("https://hooks.example.com/abc/xyz123");
    expect(sent[0]!.headers.get("x-pulse-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("routes check incidents to the check's channels", async () => {
    Object.assign(h.env, { PULSE_SECRET_KEY: SECRET, ENVIRONMENT: "production" });
    const ch = await json<{ data: { channel: { id: string } } }>(await req("POST", "/api/v1/ops/channels", admin, { name: "Slack", kind: "slack", config: { url: "https://hooks.slack.com/services/T/B/x" } }));
    h.db.sqlite.exec("DELETE FROM monitors");
    await req("POST", "/api/v1/ops/monitors", admin, { name: "Down", url: "https://down.example/", failures_to_alert: 1, channel_ids: [ch.data.channel.id] });
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://hooks.slack.com")) {
        posts.push(String(init?.body));
        return new Response("ok");
      }
      return new Response("nope", { status: 500 });
    });
    const { runMonitors } = await import("../../src/worker/ops/monitor.ts");
    await runMonitors(h.env, 1_800_000_000_000);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Down: Down");
    // Still down: no second message.
    await runMonitors(h.env, 1_800_000_000_000 + 300_000);
    expect(posts).toHaveLength(1);
  });

  it("retries a Down message nobody received while the check keeps failing", async () => {
    Object.assign(h.env, { PULSE_SECRET_KEY: SECRET, ENVIRONMENT: "production" });
    const ch = await json<{ data: { channel: { id: string } } }>(await req("POST", "/api/v1/ops/channels", admin, { name: "Slack", kind: "slack", config: { url: "https://hooks.slack.com/services/T/B/x" } }));
    h.db.sqlite.exec("DELETE FROM monitors");
    await req("POST", "/api/v1/ops/monitors", admin, { name: "Down", url: "https://down.example/", failures_to_alert: 1, channel_ids: [ch.data.channel.id] });
    let slackUp = false;
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://hooks.slack.com") && slackUp) return (posts.push(String(init?.body)), new Response("ok"));
      return new Response("nope", { status: 500 });
    });
    const { runMonitors } = await import("../../src/worker/ops/monitor.ts");
    const t = 1_800_000_000_000;
    await runMonitors(h.env, t);
    expect(posts).toHaveLength(0);
    slackUp = true;
    await runMonitors(h.env, t + 300_000);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Down: Down");
    await runMonitors(h.env, t + 600_000);
    expect(posts).toHaveLength(1);
  });

  it("marks a site's check incidents on that site's charts", async () => {
    Object.assign(h.env, { ENVIRONMENT: "production" });
    h.db.sqlite.exec("DELETE FROM monitors");
    await req("POST", "/api/v1/ops/monitors", admin, { name: "Shop", url: "https://shop.example/", failures_to_alert: 1, site_id: "test", notify: false });
    let status = 500;
    vi.stubGlobal("fetch", async () => new Response("x", { status }));
    const { runMonitors } = await import("../../src/worker/ops/monitor.ts");
    await runMonitors(h.env, 1_800_000_000_000);
    const a = h.db.sqlite.prepare("SELECT site_id, title, category, created_by FROM annotations").get();
    expect(a).toEqual({ site_id: "test", title: "Shop down", category: "incident", created_by: "status" });
    status = 200;
    await runMonitors(h.env, 1_800_000_000_000 + 10 * 60_000);
    expect((h.db.sqlite.prepare("SELECT body FROM annotations").get() as { body: string }).body).toMatch(/Back up after 10 min$/);
  });
});

describe("alerts", () => {
  it("new_error: fires for an error not seen before, and skips the 30-day lookup while there are none", async () => {
    const a = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/alerts", admin, { name: "New errors", kind: "new_error", window_min: 60 }));
    const rule = () => req("POST", `/api/v1/sites/test/alerts/${a.data.id}/test`, admin);
    const error = (id: string, message: string, ago: number) =>
      h.db.sqlite
        .prepare("INSERT INTO events (id, site_id, ts, local_day, local_hour, type, session_id, visitor_id, name) VALUES (?, 'test', ?, '2026-11-06', 0, 'error', 's', 'v', ?)")
        .run(id, Date.now() - ago, message);
    const batch = vi.spyOn(h.env.DB, "batch");
    expect((await json<{ data: { value: number; fire: boolean } }>(await rule())).data).toMatchObject({ value: 0, fire: false });
    const quiet = batch.mock.calls.length;
    await error("e1", "boom", 60_000);
    expect((await json<{ data: { value: number; fire: boolean } }>(await rule())).data).toMatchObject({ value: 1, fire: true });
    expect(batch.mock.calls.length - quiet).toBe(quiet + 1);
    await error("e2", "boom", 2 * 3_600_000); // the same message before the window: not new
    expect((await json<{ data: { value: number; fire: boolean } }>(await rule())).data).toMatchObject({ value: 0, fire: false });
    batch.mockRestore();
  });

  it("fires through channels, respects the cooldown, and can be tested without sending", async () => {
    Object.assign(h.env, { PULSE_SECRET_KEY: SECRET });
    const ch = await json<{ data: { channel: { id: string } } }>(await req("POST", "/api/v1/ops/channels", admin, { name: "Hook", kind: "webhook", config: { url: "https://hooks.example.com/a" } }));
    await ingest({ u: "https://example.com/" });
    const a = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/alerts", admin, { name: "Any traffic", kind: "above", metric: "pageviews", threshold: 0, window_min: 60, channel_ids: [ch.data.channel.id] }));
    const t = await json<{ data: { value: number; fire: boolean } }>(await req("POST", `/api/v1/sites/test/alerts/${a.data.id}/test`, admin));
    expect(t.data).toMatchObject({ value: 1, fire: true });
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => (bodies.push(String(init?.body)), new Response("ok")));
    expect((await evaluateAlerts(h.env)).fired).toBe(1);
    expect(JSON.parse(bodies[0]!).text).toContain("pageviews in the last 60 min is 1");
    expect((await evaluateAlerts(h.env)).fired).toBe(0); // cooldown
    const list = await json<{ data: { last_value: number }[]; history: unknown[] }>(await req("GET", "/api/v1/sites/test/alerts", admin));
    expect(list.history).toHaveLength(1);
    expect((await req("POST", "/api/v1/sites/test/alerts", admin, { name: "x", kind: "event" })).status).toBe(400);
  });

  it("no-data and event rules", async () => {
    const nd = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/alerts", admin, { name: "Silence", kind: "no_data", window_min: 60 }));
    expect((await json<{ data: { fire: boolean } }>(await req("POST", `/api/v1/sites/test/alerts/${nd.data.id}/test`, admin))).data.fire).toBe(true);
    await ingest({ t: "event", n: "purchase", u: "https://example.com/" });
    const ev = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/alerts", admin, { name: "Sale", kind: "event", event_name: "purchase" }));
    expect((await json<{ data: { value: number; fire: boolean } }>(await req("POST", `/api/v1/sites/test/alerts/${ev.data.id}/test`, admin))).data).toMatchObject({ value: 1, fire: true });
  });
});

describe("alert delivery and windows", () => {
  const evt = (id: string, ts: number) =>
    h.db.sqlite
      .prepare("INSERT INTO events (id, site_id, ts, local_day, local_hour, type, session_id, visitor_id, name, source) VALUES (?, 'test', ?, '2026-11-06', 0, 'event', 's', 'v', 'purchase', 'pulse')")
      .run(id, ts);

  it("an alert nobody received isn't marked fired, and the next run retries", async () => {
    Object.assign(h.env, { PULSE_SECRET_KEY: SECRET });
    const ch = await json<{ data: { channel: { id: string } } }>(await req("POST", "/api/v1/ops/channels", admin, { name: "Hook", kind: "webhook", config: { url: "https://hooks.example.com/a" } }));
    const now = Date.now();
    evt("p1", now - 60_000);
    await req("POST", "/api/v1/sites/test/alerts", admin, { name: "Sale", kind: "event", event_name: "purchase", window_min: 15, channel_ids: [ch.data.channel.id] });
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    expect((await evaluateAlerts(h.env, now)).fired).toBe(0);
    const list = await json<{ data: { last_fired_at: string | null }[]; history: unknown[] }>(await req("GET", "/api/v1/sites/test/alerts", admin));
    expect(list.data[0]!.last_fired_at).toBeNull();
    expect(list.history).toHaveLength(0);
    vi.stubGlobal("fetch", async () => new Response("ok"));
    expect((await evaluateAlerts(h.env, now + 5 * 60_000)).fired).toBe(1);
  });

  it("event rules count from the last alert, so a cooldown neither repeats nor skips occurrences", async () => {
    Object.assign(h.env, { PULSE_SECRET_KEY: SECRET });
    const ch = await json<{ data: { channel: { id: string } } }>(await req("POST", "/api/v1/ops/channels", admin, { name: "Hook", kind: "webhook", config: { url: "https://hooks.example.com/a" } }));
    const texts: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => (texts.push(JSON.parse(String(init?.body)).text), new Response("ok")));
    const t0 = Date.now() - 3 * 3_600_000;
    await req("POST", "/api/v1/sites/test/alerts", admin, { name: "Sale", kind: "event", event_name: "purchase", window_min: 15, cooldown_min: 60, channel_ids: [ch.data.channel.id] });
    evt("a", t0 - 60_000);
    expect((await evaluateAlerts(h.env, t0)).fired).toBe(1);
    // A sale 15 min later, during the cooldown, outside the 15-minute window by the time the cooldown ends.
    evt("b", t0 + 15 * 60_000);
    expect((await evaluateAlerts(h.env, t0 + 30 * 60_000)).fired).toBe(0);
    expect((await evaluateAlerts(h.env, t0 + 60 * 60_000)).fired).toBe(1);
    expect(texts[1]).toContain("happened 1 time(s)");
    // Nothing new since: no repeat once the next cooldown ends.
    expect((await evaluateAlerts(h.env, t0 + 125 * 60_000)).fired).toBe(0);
  });

  it("refuses change_pct without a threshold and an empty channel list; rates with no data never fire", async () => {
    expect((await req("POST", "/api/v1/sites/test/alerts", admin, { name: "Swing", kind: "change_pct" })).status).toBe(400);
    expect((await req("POST", "/api/v1/sites/test/alerts", admin, { name: "Nowhere", kind: "no_data", channel_ids: [] })).status).toBe(400);
    const a = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/alerts", admin, { name: "Low bounce", kind: "below", metric: "bounce_rate", threshold: 20 }));
    expect((await json<{ data: { fire: boolean } }>(await req("POST", `/api/v1/sites/test/alerts/${a.data.id}/test`, admin))).data.fire).toBe(false);
  });
});

describe("email only for errors", () => {
  it("by default emails new JavaScript errors and failures, and skips email for every other notice", async () => {
    const sent: string[] = [];
    Object.assign(h.env, { PULSE_SECRET_KEY: SECRET, ALERT_EMAIL: "owner@example.com", SEND_EMAIL: { send: async (m: { raw: string }) => void sent.push(m.raw) } });
    h.db.sqlite.prepare("INSERT OR REPLACE INTO notification_channels (id, kind, name, config_hint, enabled, created_at) VALUES ('email-owner', 'email', 'Email to the owner', 'ALERT_EMAIL', 1, 0)").run();
    const hook = await json<{ data: { channel: { id: string } } }>(await req("POST", "/api/v1/ops/channels", admin, { name: "Hook", kind: "webhook", config: { url: "https://hooks.example.com/a" } }));
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => (posts.push(String(init?.body)), new Response("ok")));
    expect((await json<{ data: { email_only_errors: boolean } }>(await req("GET", "/api/v1/ops/settings", admin))).data.email_only_errors).toBe(true);
    const { notify } = await import("../../src/worker/ops/notify.ts");
    const { sendMail } = await import("../../src/worker/ops/email.ts");
    // A traffic notice reaches the webhook, not the email channel; a JavaScript error reaches both.
    expect(await notify(h.env, { title: "Traffic", text: "up", severity: "alert" })).toBe(1);
    expect(sent).toHaveLength(0);
    expect(await notify(h.env, { title: "New error", text: "boom", severity: "alert", category: "error" })).toBe(2);
    expect(sent).toHaveLength(1);
    expect(posts).toHaveLength(2);
    expect(await sendMail(h.env, "Size", "big", undefined, "notice")).toBe(false);
    expect(await sendMail(h.env, "Backup failed", "x")).toBe(true);
    expect(sent).toHaveLength(2);
    // Turned off, every notice emails again.
    await req("PATCH", "/api/v1/ops/settings", admin, { email_only_errors: false });
    expect(await notify(h.env, { title: "Traffic", text: "up", severity: "alert" }, [hook.data.channel.id, "email-owner"])).toBe(2);
    expect(sent).toHaveLength(3);
  });
});

describe("saved views and share links", () => {
  it("saves views", async () => {
    const v = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/views", admin, { name: "Spain", filters: [["is", "country", ["ES"]]], pinned: true }));
    await req("PATCH", `/api/v1/sites/test/views/${v.data.id}`, admin, { name: "Spain only" });
    const l = await json<{ data: { name: string; filters: unknown; pinned: boolean }[] }>(await req("GET", "/api/v1/sites/test/views", admin));
    expect(l.data[0]).toMatchObject({ name: "Spain only", filters: [["is", "country", ["ES"]]], pinned: true });
    expect((await req("DELETE", `/api/v1/sites/test/views/${v.data.id}`, admin)).status).toBe(200);
  });

  it("share links read one site's reports and nothing else", async () => {
    await ingest({ u: "https://example.com/" });
    const s = await json<{ data: { id: string; url: string } }>(await req("POST", "/api/v1/sites/test/shares", admin, { name: "Client" }));
    const token = s.data.url.split("/share/")[1]!;
    const share = { "X-Pulse-Share": token };
    expect((await req("GET", "/api/v1/sites/test/summary?date_range=today", null, undefined, share)).status).toBe(200);
    expect((await req("POST", "/api/v1/sites/test/query", null, { metrics: ["pageviews"], date_range: "today" }, share)).status).toBe(200);
    const sites = await json<{ data: { id: string }[] }>(await req("GET", "/api/v1/sites", null, undefined, share));
    expect(sites.data.map((x) => x.id)).toEqual(["test"]);
    for (const [m, p] of [["GET", "/api/v1/sites/other/summary"], ["GET", "/api/v1/ops/status"], ["GET", "/api/v1/health"], ["POST", "/api/v1/sites/test/goals"], ["GET", "/api/v1/sites/test/export?from=2020-01-01&to=2030-01-01"], ["GET", "/api/v1/sites/test/install-check"], ["GET", "/api/v1/keys"]] as const)
      expect((await req(m, p, null, m === "POST" ? {} : undefined, share)).status, p).toBe(403);
    expect((await req("GET", "/api/v1/sites/test/summary", null, undefined, { "X-Pulse-Share": "x".repeat(40) })).status).toBe(401);
    await req("DELETE", `/api/v1/sites/test/shares/${s.data.id}`, admin);
    expect((await req("GET", "/api/v1/sites/test/summary", null, undefined, share)).status).toBe(401);
    expect((await h.call(`/share/${token}`)).status).toBe(200); // the SPA page itself is public
  });

  it("password-protected share links", async () => {
    const s = await json<{ data: { url: string } }>(await req("POST", "/api/v1/sites/test/shares", admin, { name: "Board", password: "correct horse" }));
    const token = s.data.url.split("/share/")[1]!;
    const r1 = await req("GET", "/api/v1/sites/test/summary", null, undefined, { "X-Pulse-Share": token });
    expect((await json<{ error: { code: string } }>(r1)).error.code).toBe("password_required");
    expect((await req("GET", "/api/v1/sites/test/summary", null, undefined, { "X-Pulse-Share": token, "X-Pulse-Share-Password": "nope" })).status).toBe(401);
    expect((await req("GET", "/api/v1/sites/test/summary", null, undefined, { "X-Pulse-Share": token, "X-Pulse-Share-Password": "correct horse" })).status).toBe(200);
    const stored = (h.db.sqlite.prepare("SELECT password_hash FROM share_links").get() as { password_hash: string }).password_hash;
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  });

  it("share links made with the old SHA-256 hash still work and are upgraded on the first right password", async () => {
    const s = await json<{ data: { id: string; url: string } }>(await req("POST", "/api/v1/sites/test/shares", admin, { name: "Old", password: "tr0ub4dor" }));
    const token = s.data.url.split("/share/")[1]!;
    const legacy = createHash("sha256").update(`${s.data.id}:tr0ub4dor`).digest("hex");
    h.db.sqlite.prepare("UPDATE share_links SET password_hash = ? WHERE id = ?").run(legacy, s.data.id);
    const get = (pw: string) => req("GET", "/api/v1/sites/test/summary", null, undefined, { "X-Pulse-Share": token, "X-Pulse-Share-Password": pw });
    expect((await get("wrong")).status).toBe(401);
    expect((h.db.sqlite.prepare("SELECT password_hash FROM share_links WHERE id = ?").get(s.data.id) as { password_hash: string }).password_hash).toBe(legacy);
    expect((await get("tr0ub4dor")).status).toBe(200);
    const upgraded = (h.db.sqlite.prepare("SELECT password_hash FROM share_links WHERE id = ?").get(s.data.id) as { password_hash: string }).password_hash;
    expect(upgraded.startsWith("pbkdf2$")).toBe(true);
    expect((await get("tr0ub4dor")).status).toBe(200);
    expect((await get("wrong")).status).toBe(401);
  });
});

describe("share links bound to a view", () => {
  it("apply the view's filters to everything, refuse unfiltered reports, and can be embedded", async () => {
    await ingest({ u: "https://example.com/a" });
    await ingest({ u: "https://example.com/b" }, { "CF-Connecting-IP": "198.51.100.8" });
    const v = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/views", admin, { name: "Only A", filters: [["is", "page", ["/a"]]] }));
    expect((await req("POST", "/api/v1/sites/test/shares", admin, { name: "Bad", embed_origins: ["http://x.example"] })).status).toBe(400);
    const otherView = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/other/views", admin, { name: "Theirs", filters: [] }));
    expect((await req("POST", "/api/v1/sites/test/shares", admin, { name: "Bad", view_id: otherView.data.id })).status).toBe(400);
    const s = await json<{ data: { url: string; embed: string } }>(await req("POST", "/api/v1/sites/test/shares", admin, { name: "Client A", view_id: v.data.id, embed_origins: ["https://blog.example.com/"] }));
    expect(s.data.embed).toContain("<iframe");
    const token = s.data.url.split("/share/")[1]!;
    const share = { "X-Pulse-Share": token };
    const pv = async (filters: unknown[]) => (await json<{ totals: { pageviews: number } }>(await req("POST", "/api/v1/sites/test/query", null, { metrics: ["pageviews"], date_range: "today", filters }, share))).totals.pageviews;
    expect(await pv([])).toBe(1);
    expect(await pv([["is", "page", ["/b"]]])).toBe(0);
    const b = await json<{ rows: { page: string }[] }>(await req("GET", "/api/v1/sites/test/breakdown/page?date_range=today", null, undefined, share));
    expect(b.rows.map((r) => r.page)).toEqual(["/a"]);
    expect((await req("GET", "/api/v1/sites/test/realtime", null, undefined, share)).status).toBe(403);
    const page = await h.call(`/share/${token}`);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors https://blog.example.com");
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    const plain = await json<{ data: { url: string } }>(await req("POST", "/api/v1/sites/test/shares", admin, { name: "Plain" }));
    expect((await h.call(`/share/${plain.data.url.split("/share/")[1]}`)).headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Nothing site-wide leaks through a view-bound link.
    expect((await json<{ meta: { source_counts?: { pulse: number } } }>(await req("POST", "/api/v1/sites/test/query", null, { metrics: ["pageviews"], date_range: "today", source_counts: true }, share))).meta.source_counts).toBeUndefined();
    expect((await req("GET", "/api/v1/sites/test/views", null, undefined, share)).status).toBe(403);
    expect((await req("GET", "/api/v1/sites/test", null, undefined, share)).status).toBe(403);
    const sites = JSON.stringify(await json(await req("GET", "/api/v1/sites", null, undefined, share)));
    expect(sites).not.toContain("exclude_paths");
    // Origins are exactly scheme + host: nothing else can reach the CSP header.
    for (const bad of ["https://a.example.com;report-uri https://x.example", "https://*", "https://a.example.com/path", "http://a.example.com"])
      expect((await req("POST", "/api/v1/sites/test/shares", admin, { name: "Bad", embed_origins: [bad] })).status, bad).toBe(400);
    await req("DELETE", `/api/v1/sites/test/views/${v.data.id}`, admin);
    expect((await req("POST", "/api/v1/sites/test/query", null, { metrics: ["pageviews"], date_range: "today" }, share)).status).toBe(401);
  });
});

describe("tracked links", () => {
  it("redirects and records a link_click event", async () => {
    const l = await json<{ data: { slug: string; url: string } }>(await req("POST", "/api/v1/sites/test/links", admin, { slug: "newsletter", target: "https://example.com/offer", campaign: "october" }));
    expect(l.data.url).toMatch(/\/l\/newsletter$/);
    const r = await h.call("/l/newsletter", { headers: { "User-Agent": CHROME, "CF-Connecting-IP": "203.0.113.5" } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://example.com/offer");
    const ev = h.db.sqlite.prepare("SELECT name, props_json FROM events WHERE type = 'event'").get() as { name: string; props_json: string };
    expect(ev.name).toBe("link_click");
    expect(JSON.parse(ev.props_json)).toEqual({ slug: "newsletter", campaign: "october" });
    const list = await json<{ data: { clicks: number }[] }>(await req("GET", "/api/v1/sites/test/links", admin));
    expect(list.data[0]!.clicks).toBe(1);
    expect((await h.call("/l/missing")).status).toBe(404);
  });
});

describe("explorers and new data", () => {
  it("property keys, sessions, insights and revenue", async () => {
    await ingest({ u: "https://example.com/shop", pv: "p1" });
    await ingest({ t: "event", n: "purchase", p: { revenue: 49.5, currency: "EUR", plan: "pro" }, u: "https://example.com/shop" });
    const props = await json<{ keys: { key: string }[] }>(await req("GET", "/api/v1/sites/test/properties?date_range=today&event=purchase", admin));
    expect(props.keys.map((k) => k.key).sort()).toEqual(["currency", "plan", "revenue"]);
    const rev = await json<{ totals: { revenue: number; revenue_per_visitor: number } }>(await req("POST", "/api/v1/sites/test/query", admin, { metrics: ["revenue", "revenue_per_visitor", "average_revenue"], date_range: "today" }));
    expect(rev.totals).toMatchObject({ revenue: 49.5, revenue_per_visitor: 49.5 });
    const ss = await json<{ sessions: { id: string; entry_path: string; visitor_id?: string }[] }>(await req("GET", "/api/v1/sites/test/sessions?date_range=today", admin));
    expect(ss.sessions).toHaveLength(1);
    expect(ss.sessions[0]!.visitor_id).toBeUndefined();
    const d = await json<{ events: { type: string }[]; session: Record<string, unknown> }>(await req("GET", `/api/v1/sites/test/sessions/${ss.sessions[0]!.id}`, admin));
    expect(d.events.map((e) => e.type)).toEqual(["pageview", "event"]);
    expect(d.session.visitor_id).toBeUndefined();
    expect((await req("GET", "/api/v1/sites/test/insights?date_range=7d", admin)).status).toBe(200);
  });

  it("site search terms, spam and country blocks", async () => {
    await req("PATCH", "/api/v1/sites/test", admin, { settings: { search_params: ["q"], block_referrers: ["spammy.example"], block_countries: ["fr"] } });
    invalidateSiteCache();
    await ingest({ u: "https://example.com/search?q=Linen+Shirt" });
    await ingest({ u: "https://example.com/", r: "https://www.spammy.example/x" });
    await ingest({ u: "https://example.com/", r: "https://semalt.com/" });
    const r = await json<{ rows: { search_term: string }[] }>(await req("POST", "/api/v1/sites/test/query", admin, { metrics: ["pageviews"], dimensions: ["search_term"], date_range: "today", filters: [["is_not", "search_term", ["(none)"]]] }));
    expect(r.rows).toEqual([{ search_term: "linen shirt", pageviews: 1 }]);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("ignored hostnames are dropped and counted; revenue in another currency is ignored and counted", async () => {
    await req("PATCH", "/api/v1/sites/test", admin, { domains: ["example.com", "*.example.com"], settings: { exclude_hosts: ["staging.*"] } });
    invalidateSiteCache();
    await ingest({ u: "https://staging.example.com/" });
    await ingest({ u: "https://shop.example.com/" });
    await ingest({ t: "event", n: "purchase", p: { revenue: 10, currency: "usd" }, u: "https://shop.example.com/" });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 2 });
    const ev = h.db.sqlite.prepare("SELECT props_json FROM events WHERE type = 'event'").get() as { props_json: string };
    expect(JSON.parse(ev.props_json)).toEqual({ currency: "usd" });
    await flushIngestStats(h.db);
    expect(h.db.sqlite.prepare("SELECT dropped_excluded, revenue_ignored FROM ingest_stats WHERE site_id = 'test'").get()).toEqual({ dropped_excluded: 1, revenue_ignored: 1 });
  });

  it("a site over its daily event cap is paused for the day, with one email across isolates", async () => {
    const sent: string[] = [];
    Object.assign(h.env, { ALERT_EMAIL: "owner@example.com", SEND_EMAIL: { send: async (m: { raw: string }) => void sent.push(m.raw) } });
    // The cap warning is a notice: it only emails once the owner turns off "email only for errors".
    expect((await req("PATCH", "/api/v1/ops/settings", admin, { email_only_errors: false })).status).toBe(200);
    expect((await req("PATCH", "/api/v1/sites/test", admin, { settings: { daily_event_cap: 3 } })).status).toBe(200);
    expect((await req("PATCH", "/api/v1/sites/test", admin, { settings: { daily_event_cap: -1 } })).status).toBe(400);
    invalidateSiteCache();
    for (let i = 0; i < 5; i++) await ingest({ u: `https://example.com/p${i}` });
    await ingest({ s: "other", u: "https://other.com/" });
    expect(h.db.sqlite.prepare("SELECT site_id, COUNT(*) AS n FROM events GROUP BY site_id ORDER BY site_id").all()).toEqual([
      { site_id: "other", n: 1 },
      { site_id: "test", n: 3 },
    ]);
    expect(sent).toHaveLength(1);
    expect(Buffer.from(sent[0]!.split("\r\n\r\n").at(-1)!.replace(/\s/g, ""), "base64").toString()).toContain("daily event cap");
    await flushIngestStats(h.db);
    expect(h.db.sqlite.prepare("SELECT dropped_cap FROM ingest_stats WHERE site_id = 'test'").get()).toEqual({ dropped_cap: 2 });
    // Another isolate (fresh memory) reads today's accepted count, drops too, and doesn't email again.
    resetCapCache();
    h.db.sqlite.prepare("UPDATE ingest_stats SET accepted = 3 WHERE site_id = 'test'").run();
    await ingest({ u: "https://example.com/again" });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = 'test'").get()).toEqual({ n: 3 });
    expect(sent).toHaveLength(1);
    const check = await json<{ data: { findings: { code: string }[]; today: { dropped_cap: number } } }>(await req("GET", "/api/v1/sites/test/install-check", admin));
    expect(check.data.findings.map((f) => f.code)).toContain("daily_cap");
    // Raising the cap (0 = off) resumes ingest.
    await req("PATCH", "/api/v1/sites/test", admin, { settings: { daily_event_cap: 0 } });
    invalidateSiteCache();
    await ingest({ u: "https://example.com/resumed" });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = 'test'").get()).toEqual({ n: 4 });
  });

  it("edits annotations and deletes only matching visits", async () => {
    const a = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/annotations", admin, { title: "Deploy", category: "deploy" }));
    const e = await json<{ data: { title: string; category: string } }>(await req("PATCH", `/api/v1/sites/test/annotations/${a.data.id}`, admin, { title: "Deploy v2", category: "content", url: "https://example.com/pr/1" }));
    expect(e.data).toMatchObject({ title: "Deploy v2", category: "content" });
    const cleared = await json<{ data: { url: string | null; title: string } }>(await req("PATCH", `/api/v1/sites/test/annotations/${a.data.id}`, admin, { url: null }));
    expect(cleared.data).toMatchObject({ url: null, title: "Deploy v2" });
    await ingest({ u: "https://example.com/", r: "https://bad.example/" });
    await ingest({ u: "https://example.com/" }, { "CF-Connecting-IP": "198.51.100.7" });
    const day = new Date().toISOString().slice(0, 10);
    const body = { from: "2020-01-01", to: "2030-12-31", filters: [["is", "referrer_host", ["bad.example"]]] };
    const dry = await json<{ data: { sessions: number; events: number; confirm_token: string } }>(await req("POST", "/api/v1/sites/test/delete-data", admin, { ...body, dry_run: true }));
    expect(dry.data).toMatchObject({ dry_run: true, sessions: 1, events: 1 });
    // A token from another selection is refused.
    expect((await req("POST", "/api/v1/sites/test/delete-data", admin, { ...body, from: "2021-01-01", confirm_token: dry.data.confirm_token })).status).toBe(409);
    expect((await req("POST", "/api/v1/sites/test/delete-data", admin, body)).status).toBe(400);
    expect((await req("POST", "/api/v1/sites/test/delete-data", admin, { ...body, confirm_token: dry.data.confirm_token })).status).toBe(200);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
    expect(day).toBeTruthy();
  });

  it("lists connected apps (none yet)", async () => {
    const r = await req("GET", "/api/v1/connected-apps", admin);
    expect(r.status).toBe(200);
    expect((await json<{ data: unknown[] }>(r)).data).toEqual([]);
  });
});

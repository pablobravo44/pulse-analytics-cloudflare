import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "../../src/worker/auth/apikeys.ts";
import { createSession, SESSION_COOKIE } from "../../src/worker/auth/session.ts";
import { flushIngestStats } from "../../src/worker/ingest/stats.ts";
import { CHROME, insertSite, OTHER, SITE } from "./fixtures.ts";
import { makeEnv, ORIGIN } from "./harness.ts";

let h: ReturnType<typeof makeEnv>;
let key: string;
let otherKey: string;

const ingest = (body: unknown, headers: Record<string, string> = {}) =>
  h.call("/e", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "text/plain", "User-Agent": CHROME, "CF-Connecting-IP": "203.0.113.9", ...headers } });
const get = (path: string, k = key) => h.call(path, { headers: { Authorization: `Bearer ${k}` } });
const mcp = (body: unknown, auth = `Bearer ${key}`) =>
  h.call("/mcp", { method: "POST", body: JSON.stringify(body), headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });

beforeEach(async () => {
  h = makeEnv();
  await insertSite(h.db, SITE);
  await insertSite(h.db, OTHER);
  key = (await createApiKey(h.db, { name: "t", scopes: ["stats:read", "annotations:write"], siteIds: null, createdBy: "test" })).key;
  otherKey = (await createApiKey(h.db, { name: "o", scopes: ["stats:read"], siteIds: ["other"], createdBy: "test" })).key;
});

describe("ingest", () => {
  it("accepts a pageview and stores it without the IP", async () => {
    const r = await ingest({ s: "test", t: "pageview", u: "https://example.com/hello?utm_source=hn&email=a@b.c", r: "https://news.ycombinator.com/" });
    expect(r.status).toBe(202);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const row = h.db.sqlite.prepare("SELECT * FROM events").get() as Record<string, unknown>;
    expect(row).toMatchObject({ pathname: "/hello", query: "?utm_source=hn", channel: "Referral", referrer_host: "news.ycombinator.com" });
    expect(JSON.stringify(row)).not.toContain("203.0.113.9");
    const allTables = h.db.sqlite.prepare("SELECT group_concat(sql) AS s FROM sqlite_master").get() as { s: string };
    expect(allTables.s).not.toMatch(/\bip\b/i);
  });

  it("drops wrong hostnames, bots and oversize bodies but still answers 202", async () => {
    expect((await ingest({ s: "test", t: "pageview", u: "https://evil.com/" })).status).toBe(202);
    expect((await ingest({ s: "test", t: "pageview", u: "https://example.com/" }, { "User-Agent": "Googlebot/2.1" })).status).toBe(202);
    expect((await ingest({ s: "test", t: "pageview", u: "https://example.com/", pad: "x".repeat(9000) })).status).toBe(202);
    expect((await ingest({ s: "test", t: "pageview", u: "https://example.com/" }, { Origin: "https://evil.com" })).status).toBe(202);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    await flushIngestStats(h.db);
    const stats = h.db.sqlite.prepare("SELECT SUM(dropped_bot) AS b, SUM(dropped_invalid) AS i, SUM(dropped_host) AS host FROM ingest_stats").get() as { b: number; i: number; host: number };
    expect(stats.b).toBe(1);
    expect(stats.i).toBe(1);
    expect(stats.host).toBe(2);
    const rejected = h.db.sqlite.prepare("SELECT value FROM kv_meta WHERE key = 'rejected_host:test'").get() as { value: string };
    expect(JSON.parse(rejected.value).host).toBe("evil.com");
  });

  it("counts rejected hits in memory and writes them at most once a minute", async () => {
    const writes: string[] = [];
    const prepare = h.db.prepare.bind(h.db);
    h.db.prepare = ((sql: string) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql);
      return prepare(sql);
    }) as typeof h.db.prepare;
    for (let i = 0; i < 50; i++) await ingest({ s: "test", t: "pageview", u: "https://evil.com/" });
    for (let i = 0; i < 50; i++) await ingest({ s: "nope", t: "pageview", u: "https://example.com/" });
    await ingest("not json");
    // The first rejected hit in an isolate flushes right away; the rest wait for the next minute.
    expect(writes.filter((w) => /ingest_stats|kv_meta/.test(w)).length).toBeLessThanOrEqual(2);
    await flushIngestStats(h.db);
    const rows = h.db.sqlite.prepare("SELECT site_id, dropped_host, dropped_invalid FROM ingest_stats ORDER BY site_id").all();
    expect(rows).toEqual([
      { site_id: "_unknown", dropped_host: 0, dropped_invalid: 51 },
      { site_id: "test", dropped_host: 50, dropped_invalid: 0 },
    ]);
    expect(JSON.parse((h.db.sqlite.prepare("SELECT value FROM kv_meta WHERE key = 'rejected_host:test'").get() as { value: string }).value).host).toBe("evil.com");
  });

  it("rate limits IPv6 clients per /64", async () => {
    const keys: string[] = [];
    h.env.INGEST_LIMITER = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    await ingest({ s: "test", t: "pageview", u: "https://example.com/" }, { "CF-Connecting-IP": "2001:db8:1:2::1" });
    await ingest({ s: "test", t: "pageview", u: "https://example.com/" }, { "CF-Connecting-IP": "2001:db8:1:2:ffff::9" });
    await ingest({ s: "test", t: "pageview", u: "https://example.com/" }, { "CF-Connecting-IP": "2001:db8:1:3::1" });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys.join()).not.toContain("2001");
    // Visitors are still told apart by their full address.
    expect(h.db.sqlite.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM events").get()).toEqual({ n: 3 });
  });

  it("no longer serves the Rybbit shim or resolves legacy: site ids", async () => {
    await ingest({ s: "legacy:abc123", t: "pageview", u: "https://example.com/x" });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    const r = await h.call("/api/track", { method: "POST", body: JSON.stringify({ site_id: "abc123", type: "pageview", hostname: "example.com", pathname: "/old" }) });
    expect(r.status).toBe(404);
  });
});

describe("REST API", () => {
  beforeEach(async () => {
    await ingest({ s: "test", t: "pageview", u: "https://example.com/" });
    await ingest({ s: "test", t: "event", n: "start_free", p: { place: "hero" }, u: "https://example.com/" });
    await ingest({ s: "other", t: "pageview", u: "https://other.com/" });
  });

  it("requires auth", async () => {
    expect((await h.call("/api/v1/sites")).status).toBe(401);
    expect((await get("/api/v1/sites", "pulse_sk_" + "a".repeat(52))).status).toBe(401);
  });

  it("lists only accessible sites", async () => {
    const all = (await (await get("/api/v1/sites")).json()) as { data: { id: string }[] };
    expect(all.data.map((s) => s.id).sort()).toEqual(["other", "test"]);
    const scoped = (await (await get("/api/v1/sites", otherKey)).json()) as { data: { id: string }[] };
    expect(scoped.data.map((s) => s.id)).toEqual(["other"]);
  });

  it("one site's key cannot read another site", async () => {
    expect((await get("/api/v1/sites/test/summary", otherKey)).status).toBe(404);
    expect((await get("/api/v1/sites/other/summary", otherKey)).status).toBe(200);
  });

  it("summary, timeseries and breakdown agree", async () => {
    const s = (await (await get("/api/v1/sites/test/summary?date_range=today")).json()) as { kpis: Record<string, { value: number }>; summary: string };
    expect(s.kpis.pageviews!.value).toBe(1);
    expect(s.summary).toContain("visitors");
    const t = (await (await get("/api/v1/sites/test/timeseries?date_range=7d&metrics=pageviews")).json()) as { series: { pageviews: number }[] };
    expect(t.series.reduce((a, x) => a + x.pageviews, 0)).toBe(1);
    expect(t.series).toHaveLength(7);
    const b = (await (await get("/api/v1/sites/test/breakdown/event_prop:place?date_range=today&metrics=events")).json()) as { rows: unknown[] };
    expect(b.rows).toEqual([{ "event_prop:place": "hero", events: 1 }]);
  });

  it("query endpoint validates input", async () => {
    const bad = await h.call("/api/v1/sites/test/query", { method: "POST", body: JSON.stringify({ metrics: ["nope"] }), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    const ok = await h.call("/api/v1/sites/test/query", { method: "POST", body: JSON.stringify({ metrics: ["pageviews"], dimensions: ["page"], date_range: "today" }), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBeTruthy();
  });

  it("scopes are enforced", async () => {
    const r = await h.call("/api/v1/keys", { headers: { Authorization: `Bearer ${key}` } });
    expect(r.status).toBe(403);
  });

  it("annotations round trip", async () => {
    const r = await h.call("/api/v1/sites/test/annotations", { method: "POST", body: JSON.stringify({ title: "Deploy abc" }), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
    expect(r.status).toBe(201);
    const l = (await (await get("/api/v1/sites/test/annotations")).json()) as { data: { title: string }[] };
    expect(l.data[0]!.title).toBe("Deploy abc");
  });

  it("serves OpenAPI 3.1", async () => {
    const doc = (await (await h.call("/api/v1/openapi.json")).json()) as { openapi: string; info: { license?: { name?: string } }; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.license?.name).toBe("MIT");
    expect(Object.keys(doc.paths)).toContain("/sites/{site}/query");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(25);
    const ids = Object.values(doc.paths).flatMap((ops) => Object.values(ops as Record<string, { operationId: string }>).map((op) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    const apiDocs = await h.call("/docs/api");
    expect(apiDocs.status).toBe(200);
    const apiHtml = await apiDocs.text();
    expect(apiHtml).toContain("API Reference");
    expect(apiHtml).toContain("scope: stats:read");
    expect(apiHtml).toContain("m-post");
    expect(apiHtml).toContain("/docs/app.js");

    const docsJs = await h.call("/docs/app.js");
    expect(docsJs.status).toBe(200);
    expect(docsJs.headers.get("content-type")).toContain("application/javascript");

    const agentHtml = await (await h.call("/docs/agents")).text();
    expect(agentHtml).toContain("<h1>Agent Guide</h1>");
    expect(agentHtml).toContain('id="metrics"');
    expect(agentHtml).toContain('href="#metrics"');
  });

  it("derives PUBLIC_ORIGIN and RP_ID from the request URL when unset (1-click deploy)", async () => {
    const worker = (await import("../../src/worker/index.ts")).default;
    const bareEnv = { ...h.env, PUBLIC_ORIGIN: "", RP_ID: "" };
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("https://pulse.example-account.workers.dev/docs"), bareEnv, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("https://pulse.example-account.workers.dev/p.js");
    expect(html).toContain("https://pulse.example-account.workers.dev/mcp");
  });

  it("returns 404 (not cached 200) when /p.js asset is missing", async () => {
    h.env.ASSETS = { fetch: async () => new Response("missing", { status: 404 }) } as never;
    const r = await h.call("/p.js");
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("dashboard session cookie needs X-Pulse-Client and same origin for writes", async () => {
    h.db.sqlite.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u1', 'o@x.com', 'owner', 0)").run();
    const s = await createSession(h.db, "u1");
    const cookie = `${SESSION_COOKIE}=${s.token}`;
    expect((await h.call("/api/v1/me", { headers: { cookie } })).status).toBe(403);
    const me = await h.call("/api/v1/me", { headers: { cookie, "X-Pulse-Client": "dashboard" } });
    expect(me.status).toBe(200);
    const cross = await h.call("/api/v1/sites/test/annotations", { method: "POST", body: JSON.stringify({ title: "x" }), headers: { cookie, "X-Pulse-Client": "dashboard", Origin: "https://evil.com", "Content-Type": "application/json" } });
    expect(cross.status).toBe(403);
    const same = await h.call("/api/v1/sites/test/annotations", { method: "POST", body: JSON.stringify({ title: "x" }), headers: { cookie, "X-Pulse-Client": "dashboard", Origin: ORIGIN, "Content-Type": "application/json" } });
    expect(same.status).toBe(201);
    // SPA redirect without session
    const spa = await h.call("/sites/test");
    expect(spa.status).toBe(302);
    expect((await h.call("/sites/test", { headers: { cookie } })).status).toBe(200);
  });

  it("serves the report preview to a signed-in user, framable only by the dashboard", async () => {
    expect((await h.call("/reports/weekly-digest/preview")).status).toBe(401);
    h.db.sqlite.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u1', 'o@x.com', 'owner', 0)").run();
    const s = await createSession(h.db, "u1");
    const r = await h.call("/reports/weekly-digest/preview", { headers: { cookie: `${SESSION_COOKIE}=${s.token}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await r.text()).toContain("Weekly digest");
    expect((await h.call("/reports/nope/preview", { headers: { cookie: `${SESSION_COOKIE}=${s.token}` } })).status).toBe(404);
  });
});

describe("MCP", () => {
  beforeEach(async () => {
    await ingest({ s: "test", t: "pageview", u: "https://example.com/" });
  });

  it("initialize, tools/list and site_overview with an API key", async () => {
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.status).toBe(200);
    const list = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json()) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    for (const t of ["whoami", "help", "list_sites", "site_overview", "query", "timeseries", "breakdown", "realtime", "traffic_sources", "top_movers", "funnel", "goals", "page_report", "web_vitals", "errors", "list_annotations", "add_annotation"])
      expect(names).toContain(t);
    // Tools the key's scopes don't allow are not listed.
    for (const t of ["export_events", "save_site", "save_check", "update_key"]) expect(names).not.toContain(t);
    const call = (await (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "site_overview", arguments: { site: "test", date_range: "today" } } })).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(call.result.isError).toBeFalsy();
    expect(JSON.parse(call.result.content[0]!.text).kpis.pageviews.value).toBe(1);
  });

  it("every read tool runs", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["list_sites", {}],
      ["query", { site: "test", metrics: ["visitors"], dimensions: ["page"] }],
      ["timeseries", { site: "test" }],
      ["breakdown", { site: "test", dimension: "country" }],
      ["realtime", { site: "test" }],
      ["traffic_sources", { site: "test" }],
      ["top_movers", { site: "test" }],
      ["funnel", { site: "test", steps: [{ match: { kind: "pageview", path: "/" } }, { match: { kind: "event", event: "x" } }] }],
      ["goals", { site: "test" }],
      ["page_report", { site: "test", path: "/" }],
      ["web_vitals", { site: "test" }],
      ["errors", { site: "test" }],
      ["list_annotations", { site: "test" }],
      ["add_annotation", { site: "test", title: "hello" }],
    ];
    for (const [name, args] of calls) {
      const r = (await (await mcp({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } })).json()) as { result: { isError?: boolean; content: { text: string }[] } };
      expect(r.result.isError, `${name}: ${r.result.content[0]?.text}`).toBeFalsy();
    }
    const exp = (await (await mcp({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "export_events", arguments: { site: "test", from: "2020-01-01", to: "2030-01-01" } } })).json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(exp.result.isError).toBe(true);
    expect(exp.result.content[0]!.text).toContain("not found");
  });

  it("site-scoped key can't reach other sites via MCP", async () => {
    const r = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "site_overview", arguments: { site: "test" } } }, `Bearer ${otherKey}`)).json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("site_not_found");
  });

  it("rejects missing auth with an OAuth challenge", async () => {
    const r = await h.call("/mcp", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata");
  });
});

describe("rate limits", () => {
  const deny = (prefix: string, keys: string[] = []) => ({ limit: async ({ key }: { key: string }) => (keys.push(key), { success: !key.startsWith(prefix) }) });

  it("OAuth client registration: per client", async () => {
    const keys: string[] = [];
    h.env.LOGIN_LIMITER = deny("oauth-register:", keys);
    const r = await h.call("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "x", redirect_uris: ["https://c.example/cb"], token_endpoint_auth_method: "none" }), headers: { "Content-Type": "application/json", "CF-Connecting-IP": "2001:db8::1" } });
    expect(r.status).toBe(429);
    expect(keys.join()).not.toContain("2001");
  });

  it("/mcp with an API key: per key", async () => {
    h.env.API_LIMITER = deny("key:");
    const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(r.status).toBe(429);
  });

  it("heartbeats: per client", async () => {
    h.env.API_LIMITER = deny("hb:");
    expect((await h.call("/hb/abcdefghijklmnopqrstuvwxyz", { headers: { "CF-Connecting-IP": "203.0.113.5" } })).status).toBe(429);
  });

  it("sign-in steps: per client, and no passkey routes", async () => {
    h.env.LOGIN_LIMITER = deny("auth:");
    const r = await h.call("/auth/logout", { method: "POST", headers: { Origin: ORIGIN, "X-Pulse-Client": "dashboard", "CF-Connecting-IP": "203.0.113.5" } });
    expect(r.status).toBe(429);
    h.env.LOGIN_LIMITER = { limit: async () => ({ success: true }) } as never;
    for (const path of ["/auth/login/options", "/auth/register/options"]) {
      const x = await h.call(path, { method: "POST", headers: { Origin: ORIGIN, "X-Pulse-Client": "dashboard" } });
      expect(x.status).toBe(404);
    }
  });
});

describe("OAuth for MCP connectors", () => {
  it("register → authorize with a session → token → /mcp", async () => {
    await ingest({ s: "test", t: "pageview", u: "https://example.com/" });
    const asMeta = await h.call("/.well-known/oauth-authorization-server");
    expect(asMeta.status).toBe(200);
    const reg = await h.call("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "Test", redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" }), headers: { "Content-Type": "application/json" } });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    const verifier = "v".repeat(64);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://client.example/cb", code_challenge: challenge, code_challenge_method: "S256", scope: "stats:read sites:write", state: "st", resource: `${ORIGIN}/mcp` });

    // Not signed in → login redirect
    const anon = await h.call(`/oauth/authorize?${q}`);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/login");

    h.db.sqlite.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u1', 'o@x.com', 'owner', 0)").run();
    const s = await createSession(h.db, "u1");
    const cookie = `${SESSION_COOKIE}=${s.token}`;
    const page = await h.call(`/oauth/authorize?${q}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
    const binding = page.headers.get("set-cookie") ?? "";
    const bindCookie = binding.split(/,(?=[^ ;]+=)/).map((c) => c.split(";")[0]).join("; ");
    const form = new URLSearchParams({ handle, decision: "approve" });
    form.append("scope", "stats:read");
    form.append("scope", "sites:write");
    form.append("site", "test");
    const post = await h.call("/oauth/authorize", { method: "POST", body: form, headers: { cookie: `${cookie}; ${bindCookie}`, "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN } });
    expect(post.status).toBe(302);
    const loc = new URL(post.headers.get("location")!);
    expect(loc.origin).toBe("https://client.example");
    const code = loc.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const tok = await h.call("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://client.example/cb", client_id: client.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(tok.status).toBe(200);
    const { access_token } = (await tok.json()) as { access_token: string };
    const r = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "site_overview", arguments: { date_range: "today" } } }, `Bearer ${access_token}`)).json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(r.result.isError, r.result.content[0]?.text).toBeFalsy();
    expect(JSON.parse(r.result.content[0]!.text).meta.site).toBe("test");

    // The grant is re-checked against the user on every request: a demotion or lost site applies at once.
    const tools = async () => ((await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, `Bearer ${access_token}`)).json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(await tools()).toContain("save_site");
    h.db.sqlite.prepare("UPDATE users SET role = 'viewer' WHERE id = 'u1'").run();
    expect(await tools()).not.toContain("save_site");
    expect(await tools()).toContain("site_overview");
    h.db.sqlite.prepare("UPDATE users SET site_ids_json = '[\"other\"]' WHERE id = 'u1'").run();
    expect((await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, `Bearer ${access_token}`)).status).toBe(401);
    // Each grant has its own request budget.
    h.db.sqlite.prepare("UPDATE users SET role = 'owner', site_ids_json = NULL WHERE id = 'u1'").run();
    h.env.API_LIMITER = { limit: async ({ key }: { key: string }) => ({ success: !key.startsWith("grant:u1:") }) };
    expect((await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, `Bearer ${access_token}`)).status).toBe(429);
  });
});

describe("referrer favicons", () => {
  it("only signed-in sessions; the Worker fetches the icon from the host itself; bad hosts are refused", async () => {
    const { vi } = await import("vitest");
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (u: string | Request) => {
      const url = typeof u === "string" ? u : u.url;
      asked.push(url);
      if (url === "https://news.example.org/favicon.ico") return new Response("nope", { status: 404 });
      if (url === "https://news.example.org/") return new Response('<html><head><link rel="shortcut icon" href="/static/i.png"></head>', { headers: { "Content-Type": "text/html" } });
      if (url === "https://news.example.org/static/i.png") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
      return new Response("", { status: 404 });
    });
    try {
      expect((await h.call("/icons/favicon/news.example.org")).status).toBe(401);
      h.db.sqlite.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u9', 'v@x.com', 'viewer', 0)").run();
      const cookie = `${SESSION_COOKIE}=${(await createSession(h.db, "u9")).token}`;
      const r = await h.call("/icons/favicon/www.news.example.org", { headers: { cookie } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(asked).toEqual(["https://news.example.org/favicon.ico", "https://news.example.org/", "https://news.example.org/static/i.png"]);
      for (const bad of ["127.0.0.1", "localhost", "intranet.local", "a..b"]) expect((await h.call(`/icons/favicon/${bad}`, { headers: { cookie } })).status, bad).toBe(400);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("GET /sites/summary", () => {
  it("is the all-sites summary, not a site called summary, and only lists the caller's sites", async () => {
    const { createApiKey } = await import("../../src/worker/auth/apikeys.ts");
    const scoped = (await createApiKey(h.db, { name: "one", scopes: ["stats:read"], siteIds: ["test"], createdBy: "test" })).key;
    const r = await h.call("/api/v1/sites/summary?date_range=today", { headers: { Authorization: `Bearer ${scoped}` } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { sites: { id: string; color: string }[]; meta: { date_range: string } };
    expect(j.meta.date_range).toBe("today");
    expect(j.sites.map((s) => s.id)).toEqual(["test"]);
    expect(j.sites[0]!.color).toMatch(/^s([1-9]|1[0-2])$/);
  });
});

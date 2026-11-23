// Owner-editable configuration: sites, API keys, people, status checks, ops settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../../src/worker/auth/apikeys.ts";
import { cspAllows, findSnippets, installCheck } from "../../src/worker/api/sites.ts";
import { normalizeDomain, siteSlug } from "../../src/worker/lib/sites.ts";
import { atPath, isDue, isReadOnlySql, runCheck, type Monitor } from "../../src/worker/ops/monitor.ts";
import { reportPeriod, runDueReports } from "../../src/worker/ops/reports.ts";
import { CHROME, insertSite, OTHER, SITE } from "./fixtures.ts";
import { makeEnv } from "./harness.ts";

let h: ReturnType<typeof makeEnv>;
let admin: string;
let reader: string;
let ops: string;

const req = (method: string, path: string, k: string, body?: unknown) =>
  h.call(path, { method, headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
const ingest = (body: unknown) => h.call("/e", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "text/plain", "User-Agent": CHROME, "CF-Connecting-IP": "203.0.113.9" } });

beforeEach(async () => {
  h = makeEnv();
  await insertSite(h.db, SITE);
  await insertSite(h.db, OTHER);
  admin = (await createApiKey(h.db, { name: "admin", scopes: ["admin"], siteIds: null, createdBy: "test" })).key;
  reader = (await createApiKey(h.db, { name: "reader", scopes: ["stats:read"], siteIds: null, createdBy: "test" })).key;
  ops = (await createApiKey(h.db, { name: "ops", scopes: ["stats:read", "ops:write"], siteIds: null, createdBy: "test" })).key;
});
afterEach(() => vi.unstubAllGlobals());

describe("site helpers", () => {
  it("normalizes what people type as a domain", () => {
    expect(normalizeDomain("https://www.Example.com/path?q=1")).toBe("www.example.com");
    expect(normalizeDomain(" example.com:8080 ")).toBe("example.com");
    expect(normalizeDomain("*.example.com")).toBe("*.example.com");
    expect(normalizeDomain("münchen.de")).toBe("xn--mnchen-3ya.de");
    for (const bad of ["localhost", "127.0.0.1", "nodot", "", "exa mple.com"]) expect(normalizeDomain(bad)).toBeNull();
  });
  it("derives site ids", () => {
    expect(siteSlug("Example.com")).toBe("example");
    expect(siteSlug("Acme Shop Madrid")).toBe("acme-shop-madrid");
    expect(siteSlug("www.Ñandú-shop.es")).toBe("nandu-shop");
  });
});

describe("sites", () => {
  it("creates a site from just a URL, with snippet and next steps", async () => {
    const r = await req("POST", "/api/v1/sites", admin, { domains: ["https://www.NewSite.io/"] });
    expect(r.status).toBe(201);
    const b = await json<{ data: { id: string; name: string; domains: string[] }; snippet: string; next_steps: string[] }>(r);
    expect(b.data).toMatchObject({ id: "newsite", name: "www.newsite.io", domains: ["www.newsite.io"] });
    expect(b.snippet).toContain('data-site="newsite"');
    const again = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites", admin, { domains: ["newsite.io"] }));
    expect(again.data.id).toBe("newsite-2");
    expect((await req("POST", "/api/v1/sites", admin, { id: "newsite", domains: ["x.io"] })).status).toBe(409);
    const bad = await req("POST", "/api/v1/sites", admin, { domains: ["localhost"] });
    expect(bad.status).toBe(400);
    expect((await json<{ error: { code: string } }>(bad)).error.code).toBe("invalid_domain");
  });

  it("PATCH only changes the fields that were sent (zod defaults don't leak in)", async () => {
    await req("PATCH", "/api/v1/sites/test", admin, { timezone: "America/Mexico_City", retention_months: 13 });
    const s = await json<{ data: { timezone: string; retention_months: number; name: string } }>(await req("PATCH", "/api/v1/sites/test", admin, { name: "Renamed" }));
    expect(s.data).toMatchObject({ name: "Renamed", timezone: "America/Mexico_City", retention_months: 13 });
    const hb = await json<{ data: { id: string } }>(await req("POST", "/api/v1/ops/monitors", ops, { name: "Job", kind: "heartbeat", config: { period_min: 60 } }));
    const m = await json<{ data: { kind: string; interval_min: number } }>(await req("PATCH", `/api/v1/ops/monitors/${hb.data.id}`, ops, { name: "Nightly job" }));
    expect(m.data.kind).toBe("heartbeat");
    const f = await json<{ data: { id: string } }>(await req("POST", "/api/v1/sites/test/funnels", admin, { name: "F", window_minutes: 90, steps: [{ match: { kind: "pageview", path: "/" } }, { match: { kind: "event", event: "x" } }] }));
    const f2 = await json<{ data: { window_minutes: number } }>(await req("PATCH", `/api/v1/sites/test/funnels/${f.data.id}`, admin, { name: "G" }));
    expect(f2.data.window_minutes).toBe(90);
  });

  it("merges settings on update and drops excluded paths at ingest", async () => {
    const r = await req("PATCH", "/api/v1/sites/test", admin, { settings: { exclude_paths: ["/admin/*"], hidden: true } });
    const s = await json<{ data: { settings: { exclude_paths: string[]; hidden: boolean; features: { vitals: boolean } } } }>(r);
    expect(s.data.settings).toMatchObject({ exclude_paths: ["/admin/*"], hidden: true, features: { vitals: true } });
    await ingest({ s: "test", t: "pageview", u: "https://example.com/admin/users" });
    await ingest({ s: "test", t: "pageview", u: "https://example.com/blog" });
    expect(h.db.sqlite.prepare("SELECT pathname FROM events").all()).toEqual([{ pathname: "/blog" }]);
  });

  it("archives (no more data), restores, and purges only with admin + confirm", async () => {
    const editor = (await createApiKey(h.db, { name: "e", scopes: ["sites:write", "stats:read"], siteIds: null, createdBy: "test" })).key;
    expect((await req("DELETE", "/api/v1/sites/test", editor)).status).toBe(200);
    const list = await json<{ data: { id: string }[] }>(await req("GET", "/api/v1/sites", editor));
    expect(list.data.map((s) => s.id)).toEqual(["other"]);
    await ingest({ s: "test", t: "pageview", u: "https://example.com/" });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    const withArchived = await json<{ data: { id: string }[] }>(await req("GET", "/api/v1/sites?include_archived=true", admin));
    expect(withArchived.data.map((s) => s.id).sort()).toEqual(["other", "test"]);
    expect((await req("POST", "/api/v1/sites/test/restore", editor)).status).toBe(200);
    await ingest({ s: "test", t: "pageview", u: "https://example.com/" });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
    expect((await req("DELETE", "/api/v1/sites/test?purge=true&confirm=test", editor)).status).toBe(403);
    expect((await req("DELETE", "/api/v1/sites/test?purge=true", admin)).status).toBe(400);
    expect((await req("DELETE", "/api/v1/sites/test?purge=true&confirm=test", admin)).status).toBe(200);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM sites WHERE id = 'test'").get()).toEqual({ n: 0 });
    // Nothing tied to the old site survives for a re-added site with the same id.
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM share_links WHERE site_id = 'test'").get()).toEqual({ n: 0 });
  });

  it("matches owner globs in linear time", async () => {
    const { pathMatches } = await import("../../src/worker/lib/sites.ts");
    expect(pathMatches("/admin/*", "/admin/users")).toBe(true);
    expect(pathMatches("/*/pricing", "/en/pricing")).toBe(true);
    expect(pathMatches("staging.*", "staging.example.com")).toBe(true);
    expect(pathMatches("staging.*", "www.example.com")).toBe(false);
    expect(pathMatches("/a.b", "/axb")).toBe(false);
    const t0 = Date.now();
    expect(pathMatches("/*a*a*a*a*a*a*b", "/" + "a".repeat(500))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("site-scoped keys can't touch other sites", async () => {
    const scoped = (await createApiKey(h.db, { name: "s", scopes: ["sites:write", "stats:read"], siteIds: ["other"], createdBy: "test" })).key;
    expect((await req("PATCH", "/api/v1/sites/test", scoped, { name: "x" })).status).toBe(404);
    expect((await req("DELETE", "/api/v1/sites/test", scoped)).status).toBe(404);
    expect((await req("GET", "/api/v1/sites/test/install-check", scoped)).status).toBe(404);
    expect((await req("POST", "/api/v1/sites", scoped, { domains: ["z.com"] })).status).toBe(403);
  });

  it("finds the snippet, a wrong site id and a blocking CSP", async () => {
    expect(findSnippets(`<script defer src="https://p.test/p.js" data-site="a"></script><script src="/x.js"></script>`)).toEqual([{ src: "https://p.test/p.js", site: "a" }]);
    expect(cspAllows("'self' https://pulse.test", "https://pulse.test")).toBe(true);
    expect(cspAllows("'self' https://pulse.test/p.js", "https://pulse.test", "/p.js")).toBe(true);
    expect(cspAllows("'self'", "https://pulse.test")).toBe(false);
    expect(cspAllows(undefined, "https://pulse.test")).toBe(true);
    const fetcher = (async () =>
      new Response(`<html><head><script defer src="https://pulse.test/p.js" data-site="wrong"></script></head></html>`, { headers: { "content-security-policy": "default-src 'self'" } })) as unknown as typeof fetch;
    const r = await installCheck(h.env, { ...SITE }, fetcher);
    expect(r.status).toBe("waiting");
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["no_data", "snippet_wrong_site", "csp_script", "csp_connect"]));
  });
});

describe("API keys", () => {
  it("edits name, scopes and sites; changes apply on the next request", async () => {
    const k = await createApiKey(h.db, { name: "agent", scopes: ["stats:read"], siteIds: null, createdBy: "test" });
    expect((await req("GET", "/api/v1/sites/test/summary", k.key)).status).toBe(200);
    const r = await req("PATCH", `/api/v1/keys/${k.id}`, admin, { name: "claude-code", scopes: ["stats:read", "sites:write"], site_ids: ["other"] });
    expect(r.status).toBe(200);
    expect((await json<{ data: { name: string; scopes: string[]; site_ids: string[] } }>(r)).data).toMatchObject({ name: "claude-code", scopes: ["stats:read", "sites:write"], site_ids: ["other"] });
    expect((await req("GET", "/api/v1/sites/test/summary", k.key)).status).toBe(404);
    expect((await req("PATCH", "/api/v1/sites/other", k.key, { name: "Other" })).status).toBe(200);
    await req("PATCH", `/api/v1/keys/${k.id}`, admin, { scopes: ["events:export"] });
    expect((await req("GET", "/api/v1/sites/other/summary", k.key)).status).toBe(403);
    expect((await req("PATCH", `/api/v1/keys/${k.id}`, admin, { site_ids: ["nope"] })).status).toBe(400);
    const audit = h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'key.update'").get();
    expect(audit).toEqual({ n: 2 });
  });

  it("rotates a secret and refuses to edit revoked keys", async () => {
    const k = await createApiKey(h.db, { name: "agent", scopes: ["stats:read"], siteIds: null, createdBy: "test" });
    const r = await json<{ data: { key: string; prefix: string } }>(await req("POST", `/api/v1/keys/${k.id}/rotate`, admin));
    expect(r.data.key).toMatch(/^pulse_sk_/);
    expect((await req("GET", "/api/v1/sites", k.key)).status).toBe(401);
    expect((await req("GET", "/api/v1/sites", r.data.key)).status).toBe(200);
    await req("DELETE", `/api/v1/keys/${k.id}`, admin);
    expect((await req("PATCH", `/api/v1/keys/${k.id}`, admin, { name: "x" })).status).toBe(409);
    const active = await json<{ data: { id: string }[] }>(await req("GET", "/api/v1/keys?status=active", admin));
    expect(active.data.some((x) => x.id === k.id)).toBe(false);
  });

  it("a site-scoped admin can't widen a key beyond its own sites", async () => {
    const scopedAdmin = (await createApiKey(h.db, { name: "sa", scopes: ["admin"], siteIds: ["test"], createdBy: "test" })).key;
    const k = await createApiKey(h.db, { name: "k", scopes: ["stats:read"], siteIds: ["test"], createdBy: "test" });
    expect((await req("PATCH", `/api/v1/keys/${k.id}`, scopedAdmin, { site_ids: null })).status).toBe(403);
    expect((await req("PATCH", `/api/v1/keys/${k.id}`, scopedAdmin, { site_ids: ["other"] })).status).toBe(403);
    expect((await req("PATCH", `/api/v1/keys/${k.id}`, scopedAdmin, { name: "renamed" })).status).toBe(200);
    // Keys reaching other sites are invisible to it, and people are off limits.
    const listed = await json<{ data: { id: string }[] }>(await req("GET", "/api/v1/keys", scopedAdmin));
    expect(listed.data.map((x) => x.id)).toContain(k.id);
    expect(listed.data).toHaveLength(2); // its own key and k; the all-sites keys are hidden
    const allSites = await createApiKey(h.db, { name: "all", scopes: ["stats:read"], siteIds: null, createdBy: "test" });
    expect((await req("DELETE", `/api/v1/keys/${allSites.id}`, scopedAdmin)).status).toBe(404);
    expect((await req("POST", `/api/v1/keys/${allSites.id}/rotate`, scopedAdmin)).status).toBe(404);
    expect((await req("GET", "/api/v1/users", scopedAdmin)).status).toBe(403);
  });
});

describe("people", () => {
  it("MCP can't disable owners unless an owner asks, and keeps the last owner", async () => {
    const { disableUser } = await import("../../src/worker/api/admin.ts");
    h.db.sqlite.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('own', 'o@x.com', 'owner', 0), ('own2', 'p@x.com', 'owner', 0)").run();
    const key = { kind: "key" as const, id: "k", label: "key:k", scopes: ["admin" as const], siteIds: null };
    await expect(disableUser(h.env.DB, key, "own")).rejects.toThrow(/only owners/);
    const owner = { kind: "user" as const, id: "own", label: "user:o", scopes: ["admin" as const], siteIds: null, role: "owner" as const };
    await disableUser(h.env.DB, owner, "own2");
    const other = { ...owner, id: "x" };
    await expect(disableUser(h.env.DB, other, "own")).rejects.toThrow(/at least one owner/);
  });

  it("edits roles and site access but keeps one owner", async () => {
    h.db.sqlite.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('o1', 'o@x.com', 'owner', 0), ('v1', 'v@x.com', 'viewer', 0)").run();
    const r = await req("PATCH", "/api/v1/users/v1", admin, { site_ids: ["test"] });
    expect(r.status).toBe(200);
    expect((await json<{ data: { site_ids: string[] } }>(r)).data.site_ids).toEqual(["test"]);
    // API keys have no role, so they can't change owners.
    expect((await req("PATCH", "/api/v1/users/o1", admin, { role: "viewer" })).status).toBe(403);
  });

  it("adds people by email; only owners add owners, and an email is added once", async () => {
    const r = await req("POST", "/api/v1/users", admin, { email: " New@Example.com ", role: "viewer", site_ids: ["test"] });
    expect(r.status).toBe(201);
    expect((await json<{ data: { email: string; role: string; site_ids: string[] } }>(r)).data).toMatchObject({ email: "new@example.com", role: "viewer", site_ids: ["test"] });
    expect((await req("POST", "/api/v1/users", admin, { email: "new@example.com" })).status).toBe(409);
    expect((await req("POST", "/api/v1/users", admin, { email: "boss@example.com", role: "owner" })).status).toBe(403);
    expect((await req("POST", "/api/v1/users", admin, { email: "x@example.com", site_ids: ["nope"] })).status).toBe(400);
    expect((await req("POST", "/api/v1/users", admin, { email: "not-an-email" })).status).toBe(400);
    expect((await req("POST", "/api/v1/users", reader, { email: "y@example.com" })).status).toBe(403);
    // Admins get every site: site_ids only applies to viewers.
    const a = await json<{ data: { site_ids: string[] | null } }>(await req("POST", "/api/v1/users", admin, { email: "adm@example.com", role: "admin", site_ids: ["test"] }));
    expect(a.data.site_ids).toBeNull();
  });
});

describe("status checks", () => {
  it("adds, edits, pauses and deletes a check; read-only keys can't", async () => {
    expect((await req("POST", "/api/v1/ops/monitors", reader, { name: "Home", url: "https://example.com/" })).status).toBe(403);
    const c = await req("POST", "/api/v1/ops/monitors", ops, { name: "Home page", url: "https://example.com/", site_id: "test", config: { keyword: "Welcome" } });
    expect(c.status).toBe(201);
    const m = (await json<{ data: { id: string; config: { keyword: string } } }>(c)).data;
    expect(m).toMatchObject({ id: "home-page", config: { keyword: "Welcome" } });
    expect((await req("POST", "/api/v1/ops/monitors", ops, { name: "Home page", url: "https://example.com/" })).status).toBe(409);
    const p = await json<{ data: { interval_min: number; config: Record<string, unknown> } }>(await req("PATCH", "/api/v1/ops/monitors/home-page", ops, { interval_min: 15, config: { expect_status: "200-299" } }));
    expect(p.data).toMatchObject({ interval_min: 15, config: { keyword: "Welcome", expect_status: "200-299" } });
    expect((await req("PATCH", "/api/v1/ops/monitors/home-page", ops, { interval_min: 7 })).status).toBe(400);
    const paused = await json<{ data: { paused_until: string | null } }>(await req("POST", "/api/v1/ops/monitors/home-page/pause", ops, { minutes: 60 }));
    expect(paused.data.paused_until).toBeTruthy();
    const board = await json<{ monitors: { id: string; status: string; days: unknown[] }[] }>(await req("GET", "/api/v1/ops/status", reader));
    const row = board.monitors.find((x) => x.id === "home-page")!;
    expect(row.status).toBe("paused");
    expect(row.days).toHaveLength(90);
    expect((await req("DELETE", "/api/v1/ops/monitors/home-page", ops)).status).toBe(200);
    expect((await req("GET", "/api/v1/ops/monitors/home-page", reader)).status).toBe(404);
  });

  it("database query checks need admin (they can read every D1 database)", async () => {
    const body = { name: "Leak", kind: "d1_query", config: { database: "other", sql: "SELECT 0 AS ok, 'x' AS detail" } };
    expect((await req("POST", "/api/v1/ops/monitors", ops, body)).status).toBe(403);
    expect((await req("POST", "/api/v1/ops/monitors/test", ops, body)).status).toBe(403);
    expect((await req("POST", "/api/v1/ops/monitors", admin, body)).status).toBe(201);
    expect((await req("PATCH", "/api/v1/ops/monitors/leak", ops, { name: "x" })).status).toBe(403);
    expect((await req("POST", "/api/v1/ops/monitors/leak/check", ops)).status).toBe(403);
  });

  it("rejects write SQL in database checks", () => {
    expect(isReadOnlySql("SELECT COUNT(*) > 0 AS ok FROM runs WHERE day = :today")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x;")).toBe(true);
    expect(isReadOnlySql("DELETE FROM runs")).toBe(false);
    expect(isReadOnlySql("SELECT 1; DROP TABLE runs")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM runs WHERE note = 'drop table'")).toBe(true);
    // A quote inside another kind of quote must not hide a write.
    expect(isReadOnlySql(`WITH a AS (SELECT "'") DELETE FROM t WHERE 1 OR ''`)).toBe(false);
    expect(isReadOnlySql("WITH a AS (SELECT `'`) UPDATE t SET x = 1 WHERE ''")).toBe(false);
    expect(isReadOnlySql("WITH a AS (SELECT [']) INSERT INTO t VALUES ('')")).toBe(false);
    expect(isReadOnlySql("SELECT 1 /* ' */ ; DROP TABLE t")).toBe(false);
    expect(isReadOnlySql("SELECT 'it''s' AS ok, [update] FROM runs -- no writes here")).toBe(true);
    expect(isReadOnlySql("SELECT 'unterminated")).toBe(false);
  });

  it("a fresh install has only Pulse's own checks, and the digest in UTC", () => {
    const fresh = makeEnv();
    const ids = (fresh.db.sqlite.prepare("SELECT id FROM monitors ORDER BY id").all() as { id: string }[]).map((m) => m.id);
    expect(ids).toEqual(["pulse-healthz", "pulse-ingest"]);
    expect(fresh.db.sqlite.prepare("SELECT timezone FROM reports WHERE id = 'weekly-digest'").get()).toEqual({ timezone: "UTC" });
  });

  it("a site-scoped key's ingest check must watch one of its own sites", async () => {
    const scoped = (await createApiKey(h.db, { name: "scoped", scopes: ["stats:read", "ops:write"], siteIds: ["test"], createdBy: "test" })).key;
    const body = (config: Record<string, unknown>) => ({ name: `Ingest ${JSON.stringify(config)}`, kind: "pulse_ingest", site_id: "test", config });
    expect((await req("POST", "/api/v1/ops/monitors", scoped, body({}))).status).toBe(403);
    expect((await req("POST", "/api/v1/ops/monitors", scoped, body({ site_id: "other" }))).status).toBe(403);
    expect((await req("POST", "/api/v1/ops/monitors/test", scoped, body({ site_id: "other" }))).status).toBe(403);
    expect((await req("POST", "/api/v1/ops/monitors", scoped, body({ site_id: "test" }))).status).toBe(201);
    expect((await req("POST", "/api/v1/ops/monitors", ops, body({}))).status).toBe(201);
  });

  it("heartbeat checks get a ping URL once and go down when pings stop", async () => {
    const c = await json<{ data: { id: string; heartbeat_url: string; config: Record<string, unknown> } }>(await req("POST", "/api/v1/ops/monitors", ops, { name: "Nightly job", kind: "heartbeat", config: { period_min: 60, grace_min: 5 } }));
    expect(c.data.heartbeat_url).toMatch(/\/hb\/[A-Za-z0-9_-]+$/);
    expect(c.data.config.token_hash).toBeUndefined();
    const path = new URL(c.data.heartbeat_url).pathname;
    expect((await h.call(path)).status).toBe(200);
    expect((await h.call("/hb/" + "x".repeat(32))).status).toBe(404);
    const row = h.db.sqlite.prepare("SELECT * FROM monitors WHERE id = ?").get(c.data.id) as unknown as Monitor;
    expect((await runCheck(h.env, row, Date.now())).ok).toBe(true);
    expect((await runCheck(h.env, row, Date.now() + 70 * 60_000)).error).toMatch(/no ping for/);
  });

  it("http and json rules", async () => {
    const base = { id: "x", name: "x", expect_status: 200, enabled: 1, temporary: 0, created_at: 0, site_id: null, interval_min: 5, timeout_ms: 5000, failures_to_alert: 2, degraded_ms: null, paused_until: null, notify: 1, sort: 0, last_ping_at: null, updated_at: null } as const;
    const fetcher = (async () => new Response(JSON.stringify({ data: { items: [1], updated: new Date().toISOString() } }), { status: 201 })) as unknown as typeof fetch;
    const http = (cfg: object) => runCheck(h.env, { ...base, kind: "http", url: "https://a.test/", config_json: JSON.stringify(cfg) }, Date.now(), fetcher);
    expect((await http({})).error).toBe("HTTP 201");
    expect((await http({ expect_status: "200-299" })).ok).toBe(true);
    expect((await http({ expect_status: "200-299", keyword: "items" })).ok).toBe(true);
    expect((await http({ expect_status: "201", keyword_absent: "items" })).ok).toBe(false);
    const json = (cfg: object) => runCheck(h.env, { ...base, kind: "json", url: "https://a.test/", config_json: JSON.stringify({ expect_status: "201", ...cfg }) }, Date.now(), fetcher);
    expect((await json({ path: "data.items" })).ok).toBe(true);
    expect((await json({ path: "data.nope", expect: "exists" })).ok).toBe(false);
    expect((await json({ path: "data.updated", expect: "max_age_minutes", max_age_minutes: 5 })).ok).toBe(true);
    expect(atPath({ a: [{ b: 2 }] }, "a[0].b")).toBe(2);
    expect((await runCheck(h.env, { ...base, kind: "http", url: "https://a.test/", config_json: JSON.stringify({ expect_status: "abc" }) }, Date.now(), fetcher)).error).toMatch(/invalid config/);
  });

  it("schedules by interval and skips paused checks", () => {
    const t = 1_800_000_000_000 - (1_800_000_000_000 % 3_600_000);
    expect(isDue({ interval_min: 5, paused_until: null }, t + 300_000)).toBe(true);
    expect([0, 1, 2, 3].map((i) => isDue({ interval_min: 15, paused_until: null }, t + i * 300_000)).filter(Boolean)).toHaveLength(2);
    expect(isDue({ interval_min: 5, paused_until: t + 1 }, t)).toBe(false);
  });

  it("dry-runs an unsaved check", async () => {
    vi.stubGlobal("fetch", async () => new Response("hello", { status: 200 }));
    const r = await json<{ data: { ok: boolean; target: string } }>(await req("POST", "/api/v1/ops/monitors/test", ops, { name: "Try", url: "https://example.com/", config: { keyword: "hello" } }));
    expect(r.data).toMatchObject({ ok: true, target: "https://example.com/" });
  });
});

describe("ops settings", () => {
  it("a new install backs up only its own database, and the settings can be changed", async () => {
    const d = await json<{ data: { backup_databases: string[]; d1_warn_gb: number } }>(await req("GET", "/api/v1/ops/settings", reader));
    expect(d.data.backup_databases).toEqual(["pulse"]);
    expect(d.data).not.toHaveProperty("digest");
    expect((await req("PATCH", "/api/v1/ops/settings", reader, { d1_warn_gb: 5 })).status).toBe(403);
    const u = await json<{ data: { d1_warn_gb: number } }>(await req("PATCH", "/api/v1/ops/settings", ops, { d1_warn_gb: 5 }));
    expect(u.data.d1_warn_gb).toBe(5);
    expect((await req("PATCH", "/api/v1/ops/settings", ops, { d1_warn_gb: 0 })).status).toBe(400);
  });

  it("only admin can change which databases are backed up or drilled", async () => {
    const cur = (await json<{ data: { backup_databases: string[]; drill_databases: string[] } }>(await req("GET", "/api/v1/ops/settings", reader))).data;
    expect((await req("PATCH", "/api/v1/ops/settings", ops, { backup_databases: [] })).status).toBe(403);
    expect((await req("PATCH", "/api/v1/ops/settings", ops, { drill_databases: ["app-db"] })).status).toBe(403);
    // Sending the current lists back (a whole form) is fine.
    expect((await req("PATCH", "/api/v1/ops/settings", ops, { ...cur, d1_warn_gb: 4 })).status).toBe(200);
    expect((await req("PATCH", "/api/v1/ops/settings", admin, { backup_databases: ["app-db"] })).status).toBe(200);
    const after = (await json<{ data: { backup_databases: string[] } }>(await req("GET", "/api/v1/ops/settings", reader))).data;
    expect(after.backup_databases).toEqual(["app-db"]);
  });
});

describe("scheduled reports", () => {
  it("the old digest is a report, sent once at its local weekday and hour", async () => {
    const sent: unknown[] = [];
    Object.assign(h.env, { ALERT_EMAIL: "o@x.com", SEND_EMAIL: { send: async (m: unknown) => void sent.push(m) } });
    const list = await json<{ data: { id: string; timezone: string; weekday: number; hour: number; channel_ids: string[]; include_ops: boolean }[] }>(await req("GET", "/api/v1/ops/reports", reader));
    expect(list.data[0]).toMatchObject({ id: "weekly-digest", timezone: "UTC", weekday: 1, hour: 8, channel_ids: ["email-owner"], include_ops: true });
    // Its local time follows the report's time zone.
    expect((await req("PATCH", "/api/v1/ops/reports/weekly-digest", ops, { timezone: "Europe/Madrid" })).status).toBe(200);
    expect(await runDueReports(h.env, Date.UTC(2026, 9, 19, 5))).toBe(0); // Monday 07:00 Madrid
    expect(await runDueReports(h.env, Date.UTC(2026, 9, 19, 6))).toBe(1); // Monday 08:00 Madrid
    expect(await runDueReports(h.env, Date.UTC(2026, 9, 19, 6, 5))).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("a missed hour catches up until the next day, for the period of the scheduled day", async () => {
    const { reportDueAt, reportPeriod } = await import("../../src/worker/ops/reports.ts");
    const r = { id: "r", name: "Sun", enabled: true, frequency: "weekly", weekday: 0, day_of_month: 1, hour: 2, timezone: "Europe/Madrid", site_ids: null, sections: ["kpis"], include_ops: false, channel_ids: null } as unknown as Parameters<typeof reportDueAt>[0];
    // 2026-03-29 is the spring-forward Sunday in Madrid: 02:00 local never happens.
    const sun = Date.UTC(2026, 2, 29, 1); // 03:00 Madrid (CEST)
    expect(reportDueAt(r, null, Date.UTC(2026, 2, 29, 0, 30))).toBeNull(); // 01:30, before the hour
    expect(reportDueAt(r, null, sun)).toBe(sun);
    const monday = Date.UTC(2026, 2, 29, 23, 30); // Monday 01:30 local, before the hour: still Sunday's run
    const ref = reportDueAt(r, null, monday)!;
    expect(reportPeriod(r, ref)).toEqual(reportPeriod(r, sun));
    expect(reportDueAt(r, reportPeriod(r, sun).from, monday)).toBeNull();
    expect(reportDueAt(r, null, Date.UTC(2026, 2, 30, 1))).toBeNull(); // Monday 03:00: the window has passed
  });

  it("creates, previews, edits and deletes a monthly report; site-scoped keys only see their own", async () => {
    const created = await req("POST", "/api/v1/ops/reports", ops, { name: "Monthly test", site_ids: ["test"], frequency: "monthly", day_of_month: 2, timezone: "UTC", sections: ["kpis", "pages"] });
    expect(created.status).toBe(201);
    const r = (await json<{ data: { id: string; frequency: string; site_ids: string[]; enabled: boolean } }>(created)).data;
    expect(r).toMatchObject({ frequency: "monthly", site_ids: ["test"], enabled: true });
    expect((await req("POST", "/api/v1/ops/reports", ops, { name: "Bad", site_ids: ["nope"] })).status).toBe(400);
    expect((await req("POST", "/api/v1/ops/reports", reader, { name: "No scope" })).status).toBe(403);
    const pv = await json<{ data: { subject: string; text: string; html: string; range: { from: string; to: string } } }>(await req("GET", `/api/v1/ops/reports/${r.id}/preview`, reader));
    expect(pv.data.text).toContain("Visitors");
    expect(pv.data.html).toContain("<table");
    expect(pv.data.text).not.toContain("Ops");
    const patched = await json<{ data: { enabled: boolean; name: string } }>(await req("PATCH", `/api/v1/ops/reports/${r.id}`, ops, { enabled: false }));
    expect(patched.data).toMatchObject({ enabled: false, name: "Monthly test" });
    const scoped = (await createApiKey(h.db, { name: "scoped", scopes: ["stats:read", "ops:write"], siteIds: ["test"], createdBy: "test" })).key;
    const seen = await json<{ data: { id: string }[] }>(await req("GET", "/api/v1/ops/reports", scoped));
    expect(seen.data.map((x) => x.id)).toEqual([r.id]);
    expect((await req("GET", "/api/v1/ops/reports/weekly-digest/preview", scoped)).status).toBe(404);
    expect((await req("PATCH", `/api/v1/ops/reports/${r.id}`, scoped, { enabled: true })).status).toBe(403);
    expect((await req("DELETE", `/api/v1/ops/reports/${r.id}`, ops)).status).toBe(200);
  });

  it("a manual send doesn't skip the scheduled one; site-scoped previews leave out ops", async () => {
    Object.assign(h.env, { ALERT_EMAIL: "o@x.com", SEND_EMAIL: { send: async () => undefined } });
    // Sent by hand on Saturday, the digest still goes out on Monday.
    expect((await req("POST", "/api/v1/ops/reports/weekly-digest/send", ops)).status).toBe(200);
    expect(await runDueReports(h.env, Date.UTC(2026, 9, 19, 8))).toBe(1);
    expect(await runDueReports(h.env, Date.UTC(2026, 9, 19, 8, 30))).toBe(0);
    // When nothing is delivered the period isn't used up: the next run in the hour retries.
    const sent = await json<{ data: { id: string } }>(await req("POST", "/api/v1/ops/reports", ops, { name: "Monthly", site_ids: ["test"], frequency: "monthly", day_of_month: 1, hour: 9, timezone: "UTC", include_ops: true, channel_ids: ["nope"] }));
    expect(await runDueReports(h.env, Date.UTC(2026, 10, 1, 9))).toBe(0);
    expect((h.db.sqlite.prepare("SELECT last_period FROM reports WHERE id = ?").get(sent.data.id) as { last_period: string | null }).last_period).toBeNull();
    const scoped = (await createApiKey(h.db, { name: "scoped", scopes: ["stats:read"], siteIds: ["test"], createdBy: "test" })).key;
    const pv = await json<{ data: { text: string } }>(await req("GET", `/api/v1/ops/reports/${sent.data.id}/preview`, scoped));
    expect(pv.data.text).not.toContain("Ops");
    const full = await json<{ data: { text: string } }>(await req("GET", `/api/v1/ops/reports/${sent.data.id}/preview`, ops));
    expect(full.data.text).toContain("Ops");
  });

  it("covers the last full week or month in the report's time zone", () => {
    const mon = Date.UTC(2026, 9, 19, 6);
    expect(reportPeriod({ frequency: "weekly", timezone: "Europe/Madrid" }, mon)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(reportPeriod({ frequency: "monthly", timezone: "UTC" }, mon)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(reportPeriod({ frequency: "monthly", timezone: "UTC" }, Date.UTC(2026, 0, 2))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

describe("OTHER fixture", () => {
  it("is still a normal site", () => expect(OTHER.id).toBe("other"));
});

describe("site colour and primary goal", () => {
  it("sites get a colour slot by creation order unless one is chosen; all 12 colours map cleanly", async () => {
    const { siteColorSlot, SITE_COLORS, DEFAULT_SETTINGS } = await import("../../src/worker/lib/sites.ts");
    const mk = (id: string, created_at: number, color: string | null = null) => ({ id, created_at, settings: { ...DEFAULT_SETTINGS, color: color as never } });
    const all = [mk("b", 2), mk("a", 1), mk("c", 3)];
    expect(SITE_COLORS).toHaveLength(12);
    expect(all.map((s) => siteColorSlot(s, all))).toEqual(["s2", "s1", "s3"]);
    expect(siteColorSlot(mk("b", 2, "olive"), all)).toBe("s6");
    expect(siteColorSlot(mk("b", 2, "coral"), all)).toBe("s7");
    expect(siteColorSlot(mk("b", 2, "slate"), all)).toBe("s12");
    // A colour follows its site: removing another site from the list must not repaint the survivors' chosen colours.
    expect(siteColorSlot(mk("c", 3, "teal"), all.slice(1))).toBe("s2");
  });
});

describe("site colour over REST", () => {
  it("PATCH sets any of the 12 colours and a primary goal of the site; another site's goal is refused", async () => {
    h.db.sqlite.prepare("INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES ('mine', 'test', 'Mine', 'event', '{\"event\":\"x\"}', 0), ('theirs', 'other', 'Theirs', 'event', '{\"event\":\"x\"}', 0)").run();
    expect((await req("PATCH", "/api/v1/sites/test", admin, { settings: { color: "amber", primary_goal: "mine" } })).status).toBe(200);
    const s = await json<{ data: { color: string; settings: { color: string; primary_goal: string } } }>(await req("GET", "/api/v1/sites/test", reader));
    expect(s.data).toMatchObject({ color: "s3", settings: { color: "amber", primary_goal: "mine" } });
    expect((await req("PATCH", "/api/v1/sites/test", admin, { settings: { color: "emerald" } })).status).toBe(200);
    const s2 = await json<{ data: { color: string; settings: { color: string } } }>(await req("GET", "/api/v1/sites/test", reader));
    expect(s2.data).toMatchObject({ color: "s9", settings: { color: "emerald" } });
    expect((await req("PATCH", "/api/v1/sites/test", admin, { settings: { primary_goal: "theirs" } })).status).toBe(400);
    expect((await req("PATCH", "/api/v1/sites/test", admin, { settings: { color: "red" } })).status).toBe(400);
  });
});

describe("site colours stay with their site", () => {
  it("a new site stores the least-used colour; adding another never repaints it", async () => {
    const a = await json<{ data: { id: string; color: string; settings: { color: string } } }>(await req("POST", "/api/v1/sites", admin, { domains: ["one.example.net"] }));
    const b = await json<{ data: { id: string; color: string; settings: { color: string } } }>(await req("POST", "/api/v1/sites", admin, { domains: ["two.example.net"] }));
    expect(a.data.settings.color).toBeTruthy();
    expect(b.data.settings.color).not.toBe(a.data.settings.color);
    const again = await json<{ data: { settings: { color: string } } }>(await req("GET", `/api/v1/sites/${a.data.id}`, admin));
    expect(again.data.settings.color).toBe(a.data.settings.color);
  });
});

describe("ingest drops per day", () => {
  it("lists accepted and dropped hits by reason with totals", async () => {
    const day = new Date().toISOString().slice(0, 10);
    h.db.sqlite.prepare("INSERT INTO ingest_stats (day, site_id, accepted, dropped_bot, dropped_hosting, dropped_dnt) VALUES (?, 'test', 90, 4, 5, 1)").run(day);
    const r = await json<{ days: { day: string; bot: number; hosting: number }[]; totals: Record<string, number>; dropped_pct: number }>(await req("GET", "/api/v1/sites/test/ingest?days=7", reader));
    expect(r.days).toEqual([expect.objectContaining({ day, accepted: 90, bot: 4, hosting: 5, dnt: 1 })]);
    expect(r.dropped_pct).toBe(10);
  });
});

describe("deploy hook", () => {
  it("adds one deploy marker per site and commit; a retried build adds nothing; other sites stay out of reach", async () => {
    const ci = (await createApiKey(h.db, { name: "ci", scopes: ["annotations:write"], siteIds: ["test"], createdBy: "test" })).key;
    const body = { sites: ["test"], repo: "shop", sha: "ABCDEF1234567890", message: "fix cart", environment: "production" };
    const first = await json<{ data: { created: number; title: string } }>(await req("POST", "/api/v1/hooks/deploy", ci, body));
    expect(first.data).toEqual({ created: 1, skipped: 0, title: "Deploy shop abcdef1 (production)" });
    expect((await json<{ data: { created: number } }>(await req("POST", "/api/v1/hooks/deploy", ci, body))).data.created).toBe(0);
    const rows = h.db.sqlite.prepare("SELECT site_id, category, body FROM annotations WHERE category = 'deploy'").all();
    expect(rows).toEqual([{ site_id: "test", category: "deploy", body: "fix cart" }]);
    expect((await req("POST", "/api/v1/hooks/deploy", ci, { ...body, sites: ["other"] })).status).toBe(404);
    expect((await req("POST", "/api/v1/hooks/deploy", ci, { ...body, sites: "*" })).status).toBe(403);
    expect((await req("POST", "/api/v1/hooks/deploy", reader, body)).status).toBe(403);
  });
});

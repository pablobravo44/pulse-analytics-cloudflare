import { Hono } from "hono";
import { errorResponse, type AppEnv, type Ctx } from "./api/common.ts";
import { VERSION } from "./api/health.ts";
import { api } from "./api/v1.ts";
import { verifyApiKey } from "./auth/apikeys.ts";
import { auth } from "./auth/routes.ts";
import { readCookie, SESSION_COOKIE, verifySession } from "./auth/session.ts";
import { sha256Hex } from "./lib/crypto.ts";
import { CORS_HEADERS, handleIngest } from "./ingest/handler.ts";
import { handleMcp } from "./mcp/server.ts";
import { consent } from "./oauth/consent.ts";
import { agentGuide, apiReference, DOCS_SCRIPT, guide } from "./web/docs.ts";
import { fullGuide, llmsTxt } from "./guide.ts";

// strict: false so /api/v1 and /api/v1/ (the agent index) both match.
export const app = new Hono<AppEnv>({ strict: false });

const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const DOCS_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";

function security(h: Headers, csp: string) {
  h.set("Content-Security-Policy", csp);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  h.set("X-Frame-Options", "DENY");
}

app.onError((err, c) => errorResponse(c as Ctx, err));

// --- Tracker + ingest (public, CORS *) ---
app.options("/e", () => new Response(null, { status: 204, headers: CORS_HEADERS }));
app.post("/e", (c) => handleIngest(c.req.raw, c.env, c.executionCtx));
for (const [path, cache] of [
  ["/p.js", "public, max-age=3600"],
  ["/p.v1.js", "public, max-age=31536000, immutable"],
] as const) {
  app.get(path, async (c) => {
    const res = await c.env.ASSETS.fetch(new Request(new URL(path, c.req.url)));
    if (!res.ok) return c.text("not found", 404, { "Cache-Control": "no-store" });
    return new Response(res.body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": cache, ...CORS_HEADERS, "X-Content-Type-Options": "nosniff" } });
  });
}

// Heartbeat checks: a job calls its secret URL; the token is stored hashed (src/worker/ops/monitor.ts).
app.on(["GET", "POST", "HEAD"], "/hb/:token", async (c) => {
  // A ping is a D1 write: bound it per client (heartbeat jobs ping a few times an hour).
  const { clientKey } = await import("./lib/ip.ts");
  if (!(await c.env.API_LIMITER.limit({ key: `hb:${await clientKey(c.req.raw)}` })).success) return c.text("rate limited", 429, { "Cache-Control": "no-store", "Retry-After": "60" });
  const { recordPing } = await import("./ops/monitor.ts");
  const ok = await recordPing(c.env, c.req.param("token"));
  return c.text(ok ? "ok" : "unknown heartbeat", ok ? 200 : 404, { "Cache-Control": "no-store" });
});

// Tracked short links: record a link_click event for the site (through the normal ingest path, so the IP is only
// used for the visitor hash), then redirect.
app.get("/l/:slug", async (c) => {
  const link = await c.env.DB.prepare("SELECT slug, site_id, target, campaign FROM links WHERE slug = ?").bind(c.req.param("slug")).first<{ slug: string; site_id: string; target: string; campaign: string | null }>();
  if (!link) return c.text("link not found", 404);
  const { getSite } = await import("./lib/sites.ts");
  const { ingestPayload, requestMeta } = await import("./ingest/handler.ts");
  const { maybeFlush } = await import("./ingest/stats.ts");
  const site = await getSite(c.env.DB, link.site_id);
  const domain = site?.domains.find((d) => !d.startsWith("*."));
  if (site && domain) {
    const payload = { s: site.id, t: "event" as const, n: "link_click", p: { slug: link.slug, ...(link.campaign ? { campaign: link.campaign } : {}) }, u: `https://${domain}/l/${link.slug}`, r: c.req.header("referer") ?? undefined };
    c.executionCtx.waitUntil(ingestPayload(c.env, c.executionCtx, payload, { ...requestMeta(c.req.raw), origin: null }).then(() => maybeFlush(c.env.DB, c.executionCtx)).catch(() => {}));
  }
  return c.redirect(link.target, 302);
});

app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }, 200, { "Cache-Control": "no-store" }));

// --- REST API ---
app.get("/api/v1/openapi.json", (c) =>
  c.json(
    api.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "Pulse API", version: VERSION, description: "Cookieless web analytics API. Every read endpoint is a preset over POST /sites/{site}/query.", license: { name: "MIT", url: `${c.env.PUBLIC_ORIGIN}/docs` } },
      servers: [{ url: `${c.env.PUBLIC_ORIGIN}/api/v1` }],
    }),
  ),
);
api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", description: "pulse_sk_… API key" });
api.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", { type: "apiKey", in: "cookie", name: SESSION_COOKIE, description: "Dashboard session (requires X-Pulse-Client: dashboard)" });
app.route("/api/v1", api);

// --- MCP with API keys (OAuth tokens reach handleMcp through the provider's apiHandler) ---
app.all("/mcp", async (c) => {
  const authz = c.req.header("authorization") ?? "";
  const p = authz.startsWith("Bearer ") ? await verifyApiKey(c.env.DB, authz.slice(7).trim(), c.executionCtx) : null;
  if (!p) {
    return c.json({ error: "invalid_token", error_description: "Use a pulse_sk_ API key or OAuth" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${c.env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    });
  }
  // Same budget as the REST API, shared with it: 600 requests a minute per key.
  if (!(await c.env.API_LIMITER.limit({ key: `key:${p.id}` })).success) return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "rate limit exceeded" }, id: null }, 429, { "Retry-After": "60" });
  return handleMcp(c.req.raw, c.env, p);
});

// --- Auth, OAuth consent, docs ---
app.route("/auth", auth);
app.route("/oauth", consent);
app.get("/docs/app.js", () => {
  return new Response(DOCS_SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
app.get("/docs", (c) => {
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
  security(h, DOCS_CSP);
  return new Response(guide(c.env.PUBLIC_ORIGIN), { headers: h });
});
app.get("/docs/agents", (c) => {
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
  security(h, DOCS_CSP);
  return new Response(agentGuide(c.env.PUBLIC_ORIGIN), { headers: h });
});
app.get("/docs/agents.md", (c) => c.body(fullGuide(c.env.PUBLIC_ORIGIN), 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" }));
app.get("/llms.txt", (c) => c.body(llmsTxt(c.env.PUBLIC_ORIGIN), 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" }));
app.get("/docs/api", (c) => {
  const doc = api.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "Pulse API", version: VERSION } });
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
  security(h, DOCS_CSP);
  return new Response(apiReference(doc as never, c.env.PUBLIC_ORIGIN), { headers: h });
});

// --- Local-only fixture page (`wrangler dev`) for the tracker e2e test ---
app.get("/__e2e/fixture", (c) => {
  if (c.env.ENVIRONMENT !== "development") return c.json({ error: { code: "not_found", message: "not found" } }, 404);
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  security(h, "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pulse e2e fixture</title><script defer src="/p.js" data-site="pulse-smoke"></script></head><body><h1>Fixture</h1><a id="out" href="https://example.org/x">out</a></body></html>`,
    { headers: h },
  );
});

// --- Report preview for the dashboard (an iframe needs inline styles, which the SPA's CSP forbids) ---
app.get("/reports/:id/preview", async (c) => {
  const s = await verifySession(c.env.DB, readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE));
  if (!s) return c.json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
  const { hasScope } = await import("./auth/principal.ts");
  if (!hasScope(s.principal, "stats:read")) return c.json({ error: { code: "insufficient_scope", message: "requires scope stats:read" } }, 403);
  const rep = await import("./ops/reports.ts");
  const row = await c.env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(c.req.param("id")).first<import("./ops/reports.ts").ReportRow>();
  const r = row ? rep.reportFor(rep.reportView(row), s.principal.siteIds) : null;
  if (!r) return c.json({ error: { code: "not_found", message: "report not found" } }, 404);
  const built = await rep.buildReport(c.env, r);
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  security(h, "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
  h.set("X-Frame-Options", "SAMEORIGIN");
  return new Response(built.html, { headers: h });
});

// --- Referrer favicons for the dashboard (fetched and cached by the Worker; signed-in sessions only) ---
app.get("/icons/favicon/:host", async (c) => {
  const s = await verifySession(c.env.DB, readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE));
  if (!s) return c.body(null, 401);
  const { favicon } = await import("./web/favicon.ts");
  return favicon(c.req.param("host"), c.executionCtx);
});

// --- Dashboard SPA ---
const PUBLIC_SPA = new Set(["/login"]);
const isPublicSpa = (path: string) => PUBLIC_SPA.has(path) || path.startsWith("/share/");
app.get("*", async (c) => {
  const url = new URL(c.req.url);
  const isAsset = /\.[a-z0-9]{2,5}$/i.test(url.pathname);
  if (!isAsset && !isPublicSpa(url.pathname)) {
    const s = await verifySession(c.env.DB, readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE));
    if (!s) return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  security(out.headers, DASHBOARD_CSP);
  // A share link may be embedded by the origins its owner listed; everything else stays frame-ancestors 'none'.
  if (url.pathname.startsWith("/share/") && !isAsset) {
    const token = url.pathname.slice(7).split("/")[0] ?? "";
    const row = token
      ? await c.env.DB.prepare("SELECT embed_origins FROM share_links WHERE token_hash = ? AND revoked_at IS NULL").bind(await sha256Hex(token)).first<{ embed_origins: string | null }>()
      : null;
    if (row?.embed_origins) {
      out.headers.set("Content-Security-Policy", DASHBOARD_CSP.replace("frame-ancestors 'none'", `frame-ancestors ${row.embed_origins}`));
      out.headers.delete("X-Frame-Options");
    }
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  if (!isAsset) out.headers.set("Cache-Control", "no-store");
  else if (url.pathname.startsWith("/assets/")) out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return out;
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "not found" } }, 404));

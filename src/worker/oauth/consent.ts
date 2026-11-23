// /oauth/authorize: consent page for MCP connectors (claude.ai, Claude Desktop).
// Requires a dashboard session (Cloudflare Access sign-in); the user picks scopes and sites.
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../api/common.ts";
import { canAccessSite, type Principal, type Scope } from "../auth/principal.ts";
import { readCookie, SESSION_COOKIE, verifySession } from "../auth/session.ts";
import { audit } from "../lib/audit.ts";
import { listSitesCached } from "../lib/sites.ts";

export const OAUTH_SCOPES = ["stats:read", "annotations:write", "events:export", "sites:write", "ops:write"] as const;
const LABELS: Record<string, string> = {
  "stats:read": "Read analytics and status",
  "annotations:write": "Add annotations",
  "events:export": "Export raw events",
  "sites:write": "Add and edit sites, goals and funnels",
  "ops:write": "Add and edit status checks",
};

export const consent = new Hono<AppEnv>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize · Pulse</title><style>
:root{color-scheme:light dark;--bg:#f1f4f2;--fg:#18213a;--mut:#4b5568;--card:#fff;--bd:#d5ddd8;--acc:#18213a;--on-acc:#f1f4f2}
@media (prefers-color-scheme:dark){:root{--bg:#111715;--fg:#e4eae6;--mut:#a6b2ac;--card:#172019;--bd:#2a3530;--acc:#e4eae6;--on-acc:#111715}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:24px;max-width:440px;width:100%}
h1{font-size:20px;margin:0 0 8px}p{color:var(--mut);margin:0 0 16px}fieldset{border:1px solid var(--bd);border-radius:8px;margin:0 0 16px;padding:12px}
label{display:flex;gap:8px;align-items:center;padding:4px 0}.row{display:flex;gap:8px;justify-content:flex-end}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--bd);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:var(--on-acc)}code{font-size:14px}
</style></head><body><main>${body}</main></body></html>`;
}

async function sessionPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const s = await verifySession(c.env.DB, readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE));
  return s?.principal ?? null;
}

function renderError(message: string, status = 400) {
  return new Response(page(`<h1>Can't authorize</h1><p>${esc(message)}</p>`), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

consent.get("/authorize", async (c) => {
  const me = await sessionPrincipal(c);
  if (!me) return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`);
  const oauth = c.env.OAUTH_PROVIDER!;
  try {
    const req = await oauth.parseAuthRequest(c.req.raw);
    const d = await oauth.describeConsent(req);
    const tx = await oauth.beginConsent(req);
    const sites = (await listSitesCached(c.env.DB)).filter((s) => canAccessSite(me, s.id) && !s.settings.hidden);
    const requested = new Set(req.scope.length ? req.scope : ["stats:read"]);
    const scopes = OAUTH_SCOPES.filter((s) => me.scopes.includes(s as Scope) || me.scopes.includes("admin"));
    const html = page(`<h1>Connect ${esc(d.clientName || d.clientId)}</h1>
<p>${esc(d.clientName || "This app")} wants to access your Pulse analytics. It will redirect to <code>${esc(d.redirectHost)}</code>.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="handle" value="${esc(tx.handle)}">
<fieldset><legend>Permissions</legend>${scopes
      .map((s) => `<label><input type="checkbox" name="scope" value="${s}" ${requested.has(s) || s === "stats:read" ? "checked" : ""} ${s === "stats:read" ? "disabled" : ""}> ${LABELS[s]}</label>`)
      .join("")}<input type="hidden" name="scope" value="stats:read"></fieldset>
<fieldset><legend>Sites</legend>${sites.map((s) => `<label><input type="checkbox" name="site" value="${esc(s.id)}" checked> ${esc(s.name)}</label>`).join("")}</fieldset>
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Allow</button></div>
</form>`);
    const headers = new Headers(tx.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'");
    return new Response(html, { headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
    if (err instanceof AuthorizationError) return renderError(err.description ?? "invalid request");
    if (err instanceof CimdFetchError) return renderError("This app could not be verified.");
    throw err;
  }
});

consent.post("/authorize", async (c) => {
  const me = await sessionPrincipal(c);
  if (!me) return renderError("Your session expired. Sign in and start again.", 401);
  const oauth = c.env.OAUTH_PROVIDER!;
  const form = await c.req.formData();
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const scope = [...new Set(form.getAll("scope").map(String))].filter((s) => (OAUTH_SCOPES as readonly string[]).includes(s));
    const allowedScopes = scope.filter((s) => me.scopes.includes(s as Scope) || me.scopes.includes("admin")) as Scope[];
    const sites = form.getAll("site").map(String).filter((s) => canAccessSite(me, s));
    if (!sites.length) return renderError("Pick at least one site.");
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope: allowedScopes });
    const principal: Principal = { kind: "oauth", id: me.id, label: `oauth:${approved.request.clientId.slice(0, 40)}`, scopes: allowedScopes, siteIds: sites };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: me.id,
      metadata: { label: me.label },
      scope: allowedScopes,
      props: { principal },
    });
    c.executionCtx.waitUntil(audit(c.env.DB, me.label, "oauth.grant", approved.request.clientId.slice(0, 80), { scopes: allowedScopes, sites }));
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    if (err instanceof AuthorizationError) return renderError(err.description ?? "This page expired. Start again from the app.");
    throw err;
  }
});

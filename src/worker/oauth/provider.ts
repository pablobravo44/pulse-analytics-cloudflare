// The OAuth 2.1 provider for MCP connectors (claude.ai, Claude Desktop), shared by the Worker entry (routing)
// and the API (connected apps: list and revoke grants).
import { getOAuthApi, OAuthProvider, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { narrowToUser, type Principal } from "../auth/principal.ts";
import type { Env } from "../env.ts";
import { handleMcp } from "../mcp/server.ts";
import { OAUTH_SCOPES } from "./consent.ts";

const providers = new Map<string, OAuthProvider<Env>>();

function options(origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(req, env, ctx) {
        const props = (ctx as ExecutionContext & { props?: { principal?: Principal } }).props;
        if (!props?.principal) return new Response("unauthorized", { status: 401 });
        // 600 requests a minute per grant (user + client), like an API key.
        if (!(await env.API_LIMITER.limit({ key: `grant:${props.principal.id}:${props.principal.label}` })).success)
          return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "rate limit exceeded" }, id: null }, { status: 429, headers: { "Retry-After": "60" } });
        const u = await env.DB.prepare("SELECT role, site_ids_json, disabled_at FROM users WHERE id = ?")
          .bind(props.principal.id)
          .first<{ role: "owner" | "admin" | "viewer"; site_ids_json: string | null; disabled_at: number | null }>();
        if (!u || u.disabled_at) return new Response("unauthorized", { status: 401 });
        // Scopes and sites were frozen at consent: intersect them with the user's role and sites as they are now.
        const principal = narrowToUser(props.principal, u);
        if (!principal.scopes.includes("stats:read") || (principal.siteIds !== null && !principal.siteIds.length))
          return new Response("unauthorized: this connection no longer has access; connect it again", { status: 401 });
        return handleMcp(req, env, principal);
      },
    },
    defaultHandler: {
      async fetch(req, env, ctx) {
        const { app } = await import("../app.ts");
        return app.fetch(req, env, ctx);
      },
    },
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...OAUTH_SCOPES],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    requiredScopes: ["stats:read"],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    // A grant (its refresh token) lives 30 days from consent however often it is used; then the connector
    // asks the user to approve it again. Scopes and sites are re-checked against the user on every request.
    refreshTokenTTL: 30 * 86_400,
  };
}

export function provider(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>(options(origin));
    providers.set(origin, p);
  }
  return p;
}

/** OAuth helpers outside the provider's own requests (grant listing and revocation). */
export function oauthHelpers(env: Env): OAuthHelpers {
  return getOAuthApi(options(env.PUBLIC_ORIGIN), env);
}

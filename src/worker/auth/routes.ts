// Sign-in: Cloudflare Access only (a one-time code by email), for the addresses in ACCESS_EMAILS and the people
// added in Settings → People. Access guards /auth/access; the JWT it adds is verified here (access.ts) before a
// dashboard session is created.
import { Hono, type Context } from "hono";
import type { AppEnv } from "../api/common.ts";
import { audit } from "../lib/audit.ts";
import { ulid } from "../lib/ids.ts";
import { clientKey } from "../lib/ip.ts";
import { sameOriginPath } from "../lib/url.ts";
import { accessConfig, verifyAccessJwt } from "./access.ts";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  verifySession,
} from "./session.ts";

export const auth = new Hono<AppEnv>();

function fail(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 429, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** Same-origin + custom header for every mutation (logout). */
auth.use("*", async (c, next) => {
  if (c.req.method === "POST") {
    if (c.req.header("origin") !== c.env.PUBLIC_ORIGIN || c.req.header("x-pulse-client") !== "dashboard")
      return fail(c, 403, "forbidden", "cross-origin request");
    if (!(await c.env.LOGIN_LIMITER.limit({ key: `auth:${await clientKey(c.req.raw)}` })).success)
      return fail(c, 429, "rate_limited", "too many attempts");
  }
  c.header("Cache-Control", "no-store");
  await next();
});

/** Which sign-in methods the login page offers. */
auth.get("/methods", (c) => c.json({ access: accessConfig(c.env) !== null }));

// An ACCESS_EMAILS address gets an owner row on first sign-in; anyone else must have been added in Settings →
// People (an enabled row in users) first.
auth.get("/access", async (c) => {
  const cfg = accessConfig(c.env);
  if (!cfg) return fail(c, 404, "not_found", "Cloudflare Access sign-in is not configured");
  const email = await verifyAccessJwt(c.req.header("cf-access-jwt-assertion"), cfg, {
    allowEmail: async (e) => !!(await c.env.DB.prepare("SELECT 1 AS ok FROM users WHERE email = ? AND disabled_at IS NULL").bind(e).first()),
  });
  if (!email) return fail(c, 403, "forbidden", "Cloudflare Access sign-in not accepted");
  let user = await c.env.DB.prepare("SELECT id, disabled_at FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; disabled_at: number | null }>();
  if (user?.disabled_at) return fail(c, 403, "forbidden", "user disabled");
  if (!user) {
    user = { id: ulid(), disabled_at: null };
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, name, role, site_ids_json, created_at) VALUES (?, ?, NULL, 'owner', NULL, ?)",
    )
      .bind(user.id, email, Date.now())
      .run();
    c.executionCtx.waitUntil(audit(c.env.DB, `user:${email}`, "user.create", user.id, { via: "access" }));
  }
  const s = await createSession(c.env.DB, user.id, {
    ua: c.req.header("user-agent"),
    label: "Cloudflare Access",
  });
  c.header("Set-Cookie", sessionCookie(s.token, s.expiresAt));
  c.executionCtx.waitUntil(audit(c.env.DB, `user:${email}`, "login", user.id, { via: "access" }));
  return c.redirect(sameOriginPath(c.req.query("next"), c.env.PUBLIC_ORIGIN));
});

auth.post("/logout", async (c) => {
  const token = readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE);
  if (token) await deleteSession(c.env.DB, token);
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const s = await verifySession(c.env.DB, readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE));
  if (!s) return fail(c, 401, "unauthorized", "not signed in");
  return c.json({
    data: { id: s.principal.id, email: s.principal.label.replace(/^user:/, ""), role: s.principal.role },
  });
});

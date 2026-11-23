// Notification channels, scheduled reports, alerts, saved views, share links, tracked links, connected apps, and the read-only
// explorers (event properties, sessions, insights). Every route here is in src/worker/catalog.ts.
import { z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Principal } from "../auth/principal.ts";
import { audit } from "../lib/audit.ts";
import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { onlyGiven } from "../lib/patch.ts";
import { hashPassword } from "../lib/password.ts";
import { getSite } from "../lib/sites.ts";
import { alertHistory, alertInput, ALERT_INFO, deleteAlert, evaluateRule, listAlerts, saveAlert, type AlertRow } from "../ops/alerts.ts";
import { channelInput, CHANNEL_INFO, createChannel, deleteChannel, listChannels, testChannel, updateChannel } from "../ops/notify.ts";
import { buildReport, createReport, deleteReport, getReport, listReports, REPORT_SECTIONS, reportFor, reportInput, reportView, sendReport, updateReport } from "../ops/reports.ts";
import { insights, listSessions, propertyKeys, sessionDetail } from "../query/analyses.ts";
import { runQuery } from "../query/run.ts";
import { filterSchema, querySchema } from "../query/schema.ts";
import { ApiError, cachedReport, jsonWithEtag, requireSite, type AppEnv, type Ctx } from "./common.ts";
import { commonQuery, siteParam, toCommon } from "./params.ts";
import { r } from "./route.ts";

const idParam = siteParam.extend({ id: z.string().min(1).max(64).openapi({ param: { name: "id", in: "path" } }) });
const plainId = z.object({ id: z.string().min(1).max(64).openapi({ param: { name: "id", in: "path" } }) });

// ---------- Saved views ----------

export const viewInput = z.object({
  name: z.string().min(1).max(80),
  filters: z.array(filterSchema).max(20).default([]),
  date_range: z.string().max(40).nullable().optional().openapi({ description: 'A preset ("28d") or "YYYY-MM-DD,YYYY-MM-DD"; null keeps the current range' }),
  compare: z
    .union([z.enum(["previous_period", "previous_year", "none"]), z.string().regex(/^\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}$/)])
    .nullable()
    .optional()
    .openapi({ description: 'previous_period, previous_year, none, or custom days "YYYY-MM-DD,YYYY-MM-DD"' }),
  pinned: z.boolean().optional(),
});

interface ViewRow {
  id: string;
  site_id: string;
  name: string;
  filters_json: string;
  date_range: string | null;
  compare: string | null;
  pinned: number;
  created_by: string;
  created_at: number;
}
const viewOut = (v: ViewRow) => ({ id: v.id, site_id: v.site_id, name: v.name, filters: JSON.parse(v.filters_json), date_range: v.date_range, compare: v.compare, pinned: !!v.pinned, created_by: v.created_by, created_at: new Date(v.created_at).toISOString() });

export async function listViews(db: D1Database, siteId: string) {
  const { results } = await db.prepare("SELECT * FROM saved_views WHERE site_id = ? ORDER BY pinned DESC, name").bind(siteId).all<ViewRow>();
  return results.map(viewOut);
}

export async function saveView(db: D1Database, siteId: string, actor: string, input: z.input<typeof viewInput> & { id?: string }) {
  if (input.id) {
    const cur = await db.prepare("SELECT * FROM saved_views WHERE id = ? AND site_id = ?").bind(input.id, siteId).first<ViewRow>();
    if (!cur) throw new ApiError(404, "not_found", "view not found");
    const b = onlyGiven(viewInput.partial().parse(input), input);
    await db
      .prepare("UPDATE saved_views SET name = ?, filters_json = ?, date_range = ?, compare = ?, pinned = ? WHERE id = ?")
      .bind(b.name ?? cur.name, b.filters ? JSON.stringify(b.filters) : cur.filters_json, b.date_range === undefined ? cur.date_range : b.date_range, b.compare === undefined ? cur.compare : b.compare, b.pinned === undefined ? cur.pinned : b.pinned ? 1 : 0, input.id)
      .run();
    await audit(db, actor, "view.update", `${siteId}/${input.id}`);
    return viewOut((await db.prepare("SELECT * FROM saved_views WHERE id = ?").bind(input.id).first<ViewRow>())!);
  }
  const b = viewInput.parse(input);
  const id = ulid();
  await db
    .prepare("INSERT INTO saved_views (id, site_id, name, filters_json, date_range, compare, pinned, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, siteId, b.name, JSON.stringify(b.filters), b.date_range ?? null, b.compare ?? null, b.pinned ? 1 : 0, actor, Date.now())
    .run();
  await audit(db, actor, "view.create", `${siteId}/${id}`);
  return viewOut((await db.prepare("SELECT * FROM saved_views WHERE id = ?").bind(id).first<ViewRow>())!);
}

export async function deleteView(db: D1Database, siteId: string, actor: string, id: string) {
  const res = await db.prepare("DELETE FROM saved_views WHERE id = ? AND site_id = ?").bind(id, siteId).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "view not found");
  await audit(db, actor, "view.delete", `${siteId}/${id}`);
}

// ---------- Share links ----------

interface ShareRow {
  id: string;
  site_id: string;
  name: string;
  view_id: string | null;
  embed_origins: string | null;
  password_hash: string | null;
  expires_at: number | null;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
const shareOut = (s: ShareRow) => ({ id: s.id, site_id: s.site_id, name: s.name, view_id: s.view_id, embed_origins: s.embed_origins ? s.embed_origins.split(" ") : [], has_password: !!s.password_hash, expires_at: s.expires_at ? new Date(s.expires_at).toISOString() : null, created_by: s.created_by, created_at: new Date(s.created_at).toISOString(), last_used_at: s.last_used_at ? new Date(s.last_used_at).toISOString() : null, revoked: !!s.revoked_at });

export async function listShares(db: D1Database, siteId: string) {
  const { results } = await db.prepare("SELECT * FROM share_links WHERE site_id = ? ORDER BY created_at DESC").bind(siteId).all<ShareRow>();
  return results.map(shareOut);
}

export async function revokeShare(db: D1Database, siteId: string, actor: string, id: string) {
  const res = await db.prepare("UPDATE share_links SET revoked_at = ? WHERE id = ? AND site_id = ? AND revoked_at IS NULL").bind(Date.now(), id, siteId).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "share link not found");
  await audit(db, actor, "share.revoke", `${siteId}/${id}`);
}

const shareOrigin = z
  .string()
  .max(200)
  .refine((u) => {
    try {
      const x = new URL(u);
      return x.protocol === "https:" && /^[a-z0-9.-]+$/.test(x.hostname) && x.hostname.includes(".") && u.replace(/\/$/, "") === x.origin;
    } catch {
      return false;
    }
  }, "an https origin like https://example.com")
  .transform((u) => new URL(u).origin);

export const shareBody = z.object({
  name: z.string().min(1).max(80),
  password: z.string().min(6).max(200).optional(),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
  view_id: z.string().max(64).optional().openapi({ description: "Bind the link to a saved view: its filters apply to everything the link shows" }),
  embed_origins: z.array(shareOrigin).max(10).optional().openapi({ description: "Sites allowed to embed the link in an iframe; none = no embedding" }),
});

/** A read-only public link to a site's reports. The URL (it carries the token) is returned only here. */
export async function createShare(env: { DB: D1Database; PUBLIC_ORIGIN: string }, siteId: string, actor: string, input: z.input<typeof shareBody>) {
  const b = shareBody.parse(input);
  if (b.view_id && !(await env.DB.prepare("SELECT 1 FROM saved_views WHERE id = ? AND site_id = ?").bind(b.view_id, siteId).first())) throw new ApiError(400, "invalid_request", "view not found on this site");
  const token = randomToken(24);
  const id = ulid();
  await env.DB.prepare("INSERT INTO share_links (id, site_id, token_hash, name, view_id, embed_origins, password_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, siteId, await sha256Hex(token), b.name, b.view_id ?? null, b.embed_origins?.length ? b.embed_origins.join(" ") : null, b.password ? await hashPassword(b.password) : null, b.expires_in_days ? Date.now() + b.expires_in_days * 86_400_000 : null, actor, Date.now())
    .run();
  await audit(env.DB, actor, "share.create", `${siteId}/${id}`);
  const url = `${env.PUBLIC_ORIGIN}/share/${token}`;
  return { id, name: b.name, url, has_password: !!b.password, ...(b.embed_origins?.length ? { embed: `<iframe src="${url}" style="width:100%;height:1600px;border:0" loading="lazy" title="${b.name.replace(/"/g, "")}"></iframe>` } : {}) };
}

// ---------- Tracked links ----------

interface LinkRow {
  slug: string;
  site_id: string;
  target: string;
  campaign: string | null;
  created_by: string;
  created_at: number;
}

export const linkInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).optional().openapi({ description: "Optional; random when omitted" }),
  target: z.string().url().max(1000).refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL"),
  campaign: z.string().max(80).nullable().optional(),
});

export async function listLinks(db: D1Database, site: NonNullable<Awaited<ReturnType<typeof getSite>>>, origin: string) {
  const { results } = await db.prepare("SELECT * FROM links WHERE site_id = ? ORDER BY created_at DESC").bind(site.id).all<LinkRow>();
  const clicks = await runQuery(db, site, querySchema.parse({ metrics: ["events"], dimensions: ["event_prop:slug"], filters: [["is", "event_name", ["link_click"]]], date_range: "all", limit: 1000 }));
  const by = new Map(clicks.rows.map((x) => [String(x["event_prop:slug"]), Number(x.events ?? 0)]));
  return results.map((l) => ({ ...l, url: `${origin}/l/${l.slug}`, clicks: by.get(l.slug) ?? 0, created_at: new Date(l.created_at).toISOString() }));
}

export async function saveLink(db: D1Database, siteId: string, actor: string, input: z.input<typeof linkInput>, origin: string) {
  const b = linkInput.parse(input);
  const slug = b.slug ?? randomToken(4).slice(0, 7);
  const res = await db.prepare("INSERT OR IGNORE INTO links (slug, site_id, target, campaign, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(slug, siteId, b.target, b.campaign ?? null, actor, Date.now()).run();
  if (!res.meta.changes) throw new ApiError(409, "link_exists", `the short link ${slug} is taken`);
  await audit(db, actor, "link.create", `${siteId}/${slug}`);
  return { slug, site_id: siteId, target: b.target, campaign: b.campaign ?? null, url: `${origin}/l/${slug}` };
}

export async function deleteLink(db: D1Database, siteId: string, actor: string, slug: string) {
  const res = await db.prepare("DELETE FROM links WHERE slug = ? AND site_id = ?").bind(slug, siteId).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "link not found");
  await audit(db, actor, "link.delete", `${siteId}/${slug}`);
}

// ---------- Connected apps (OAuth grants) ----------

export async function listConnectedApps(env: Ctx["env"], p: Principal) {
  if (p.siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys can't manage connected apps");
  const { oauthHelpers } = await import("../oauth/provider.ts");
  const h = oauthHelpers(env);
  const { results: users } = await env.DB.prepare("SELECT id, email FROM users WHERE disabled_at IS NULL").all<{ id: string; email: string }>();
  const out = [];
  for (const u of users) {
    const grants = await h.listUserGrants(u.id);
    for (const g of grants.items) {
      const client = await h.lookupClient(g.clientId).catch(() => null);
      out.push({ id: g.id, user_id: u.id, user: u.email, client_id: g.clientId, client_name: client?.clientName ?? null, scopes: g.scope, created_at: new Date(g.createdAt * (g.createdAt < 1e12 ? 1000 : 1)).toISOString() });
    }
  }
  return out;
}

export async function revokeConnectedApp(env: Ctx["env"], p: Principal, id: string, userId: string) {
  if (p.siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys can't manage connected apps");
  const { oauthHelpers } = await import("../oauth/provider.ts");
  await oauthHelpers(env).revokeGrant(id, userId);
  await audit(env.DB, p.label, "oauth.revoke", id, { user: userId });
}

// ---------- Routes ----------

export function registerFeatures(api: OpenAPIHono<AppEnv>): void {
  // Notification channels
  api.openapi(r({ method: "get", path: "/ops/channels", tags: ["Status"], description: "Notification channels (where alerts go); targets are shown as hints, never secrets", scope: "stats:read" }), async (c) =>
    c.json({ data: await listChannels(c.env.DB), kinds: CHANNEL_INFO, secret_key_configured: !!c.env.PULSE_SECRET_KEY }),
  );
  api.openapi(
    r({ method: "post", path: "/ops/channels", tags: ["Status"], description: "Add a notification channel (email, webhook, slack, discord, telegram, ntfy). Webhooks return their signing secret once.", request: { body: { content: { "application/json": { schema: channelInput } } } }, scope: "ops:write" }),
    async (c) => {
      if (c.get("principal").siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys can't change channels");
      const out = await createChannel(c.env, await c.req.json());
      c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "channel.create", out.channel.id, { kind: out.channel.kind }));
      return c.json({ data: out }, 201 as 200);
    },
  );
  const channelPatch = z.object({ name: z.string().min(1).max(80).optional(), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() });
  api.openapi(r({ method: "patch", path: "/ops/channels/{id}", tags: ["Status"], description: "Rename, enable/disable or reconfigure a channel", request: { params: plainId, body: { content: { "application/json": { schema: channelPatch } } } }, scope: "ops:write" }), async (c) => {
    if (c.get("principal").siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys can't change channels");
    const out = await updateChannel(c.env, c.req.param("id") ?? "", channelPatch.parse(await c.req.json()));
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "channel.update", out.id));
    return c.json({ data: out });
  });
  api.openapi(r({ method: "delete", path: "/ops/channels/{id}", tags: ["Status"], description: "Delete a channel", request: { params: plainId }, scope: "ops:write" }), async (c) => {
    if (c.get("principal").siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys can't change channels");
    await deleteChannel(c.env, c.req.param("id") ?? "");
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "channel.delete", c.req.param("id") ?? null));
    return c.json({ data: { deleted: true } });
  });
  api.openapi(r({ method: "post", path: "/ops/channels/{id}/test", tags: ["Status"], description: "Send a test message to a channel", request: { params: plainId }, scope: "ops:write" }), async (c) => {
    if (c.get("principal").siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys can't use channels");
    return c.json({ data: await testChannel(c.env, c.req.param("id") ?? "") });
  });

  // Scheduled reports
  const unscoped = (p: Principal, what: string) => {
    if (p.siteIds !== null) throw new ApiError(403, "forbidden", `site-scoped keys can't ${what}`);
  };
  api.openapi(r({ method: "get", path: "/ops/reports", tags: ["Reports"], description: "Scheduled reports: weekly or monthly summaries of chosen sites sent to notification channels (the weekly digest is one)", scope: "stats:read" }), async (c) =>
    c.json({ data: await listReports(c.env.DB, c.get("principal").siteIds), sections: REPORT_SECTIONS }),
  );
  api.openapi(r({ method: "post", path: "/ops/reports", tags: ["Reports"], description: "Create a scheduled report", request: { body: { content: { "application/json": { schema: reportInput } } } }, scope: "ops:write" }), async (c) => {
    unscoped(c.get("principal"), "change reports");
    const out = await createReport(c.env.DB, c.get("principal").label, await c.req.json());
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "report.create", out.id));
    return c.json({ data: out }, 201 as 200);
  });
  api.openapi(r({ method: "patch", path: "/ops/reports/{id}", tags: ["Reports"], description: "Edit a scheduled report (sites, schedule, sections, channels, on/off)", request: { params: plainId, body: { content: { "application/json": { schema: reportInput.partial() } } } }, scope: "ops:write" }), async (c) => {
    unscoped(c.get("principal"), "change reports");
    const out = await updateReport(c.env.DB, c.req.param("id") ?? "", await c.req.json());
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "report.update", out.id));
    return c.json({ data: out });
  });
  api.openapi(r({ method: "delete", path: "/ops/reports/{id}", tags: ["Reports"], description: "Delete a scheduled report", request: { params: plainId }, scope: "ops:write" }), async (c) => {
    unscoped(c.get("principal"), "change reports");
    await deleteReport(c.env.DB, c.req.param("id") ?? "");
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "report.delete", c.req.param("id") ?? null));
    return c.json({ data: { deleted: true } });
  });
  const visibleReport = async (c: Ctx, id: string) => {
    const rep = reportFor(reportView(await getReport(c.env.DB, id)), c.get("principal").siteIds);
    if (!rep) throw new ApiError(404, "not_found", "report not found");
    return rep;
  };
  api.openapi(r({ method: "get", path: "/ops/reports/{id}/preview", tags: ["Reports"], description: "Build a report for its last complete period without sending it: subject, plain text, HTML and the numbers", request: { params: plainId }, scope: "stats:read" }), async (c) =>
    c.json({ data: await buildReport(c.env, await visibleReport(c, c.req.param("id") ?? "")) }),
  );
  api.openapi(r({ method: "post", path: "/ops/reports/{id}/send", tags: ["Reports"], description: "Send a report now through its channels", request: { params: plainId }, scope: "ops:write" }), async (c) => {
    unscoped(c.get("principal"), "send reports");
    const out = await sendReport(c.env, reportView(await getReport(c.env.DB, c.req.param("id") ?? "")));
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "report.send", c.req.param("id") ?? null));
    return c.json({ data: { delivered: out.delivered, subject: out.subject, range: out.range } });
  });

  // Alerts
  api.openapi(r({ method: "get", path: "/sites/{site}/alerts", tags: ["Alerts"], description: "Traffic alert rules for a site, with their last value and recent firings", request: { params: siteParam }, scope: "stats:read", middleware: [requireSite] }), async (c) =>
    c.json({ data: await listAlerts(c.env.DB, c.get("site").id), history: await alertHistory(c.env.DB, c.get("site").id, 50), kinds: ALERT_INFO }),
  );
  api.openapi(r({ method: "post", path: "/sites/{site}/alerts", tags: ["Alerts"], description: "Create an alert rule (above/below a threshold, % change vs last week, no data, every event, new JS errors)", request: { params: siteParam, body: { content: { "application/json": { schema: alertInput } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
    const { id: _id, ...b } = (await c.req.json()) as Record<string, unknown>;
    return c.json({ data: await saveAlert(c.env.DB, c.get("site").id, c.get("principal").label, b as never) }, 201 as 200);
  });
  api.openapi(r({ method: "patch", path: "/sites/{site}/alerts/{id}", tags: ["Alerts"], description: "Edit an alert rule", request: { params: idParam, body: { content: { "application/json": { schema: alertInput.partial() } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) =>
    c.json({ data: await saveAlert(c.env.DB, c.get("site").id, c.get("principal").label, { ...((await c.req.json()) as object), id: c.req.param("id") } as never) }),
  );
  api.openapi(r({ method: "delete", path: "/sites/{site}/alerts/{id}", tags: ["Alerts"], description: "Delete an alert rule", request: { params: idParam }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
    await deleteAlert(c.env.DB, c.get("site").id, c.get("principal").label, c.req.param("id") ?? "");
    return c.json({ data: { deleted: true } });
  });
  api.openapi(r({ method: "post", path: "/sites/{site}/alerts/{id}/test", tags: ["Alerts"], description: "Evaluate an alert rule now without sending anything: the value and whether it would fire", request: { params: idParam }, scope: "stats:read", middleware: [requireSite] }), async (c) => {
    const row = await c.env.DB.prepare("SELECT * FROM alert_rules WHERE id = ? AND site_id = ?").bind(c.req.param("id"), c.get("site").id).first<AlertRow>();
    if (!row) throw new ApiError(404, "not_found", "alert not found");
    return c.json({ data: await evaluateRule(c.env.DB, c.get("site"), row) });
  });

  // Saved views
  api.openapi(r({ method: "get", path: "/sites/{site}/views", tags: ["Views"], description: "Saved views (named filter sets) for a site", request: { params: siteParam }, scope: "stats:read", middleware: [requireSite] }), async (c) => c.json({ data: await listViews(c.env.DB, c.get("site").id) }));
  api.openapi(r({ method: "post", path: "/sites/{site}/views", tags: ["Views"], description: "Save a view (filters, optional range and comparison)", request: { params: siteParam, body: { content: { "application/json": { schema: viewInput } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
    const { id: _id, ...b } = (await c.req.json()) as Record<string, unknown>;
    return c.json({ data: await saveView(c.env.DB, c.get("site").id, c.get("principal").label, b as never) }, 201 as 200);
  });
  api.openapi(r({ method: "patch", path: "/sites/{site}/views/{id}", tags: ["Views"], description: "Edit a saved view", request: { params: idParam, body: { content: { "application/json": { schema: viewInput.partial() } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) =>
    c.json({ data: await saveView(c.env.DB, c.get("site").id, c.get("principal").label, { ...((await c.req.json()) as object), id: c.req.param("id") } as never) }),
  );
  api.openapi(r({ method: "delete", path: "/sites/{site}/views/{id}", tags: ["Views"], description: "Delete a saved view", request: { params: idParam }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
    await deleteView(c.env.DB, c.get("site").id, c.get("principal").label, c.req.param("id") ?? "");
    return c.json({ data: { deleted: true } });
  });

  // Share links
  api.openapi(r({ method: "get", path: "/sites/{site}/shares", tags: ["Views"], description: "Read-only share links for a site (never the token)", request: { params: siteParam }, scope: "sites:write", middleware: [requireSite] }), async (c) => c.json({ data: await listShares(c.env.DB, c.get("site").id) }));
  api.openapi(r({ method: "post", path: "/sites/{site}/shares", tags: ["Views"], description: "Create a read-only public link to this site's reports (optionally with a password and expiry). The URL is shown once.", request: { params: siteParam, body: { content: { "application/json": { schema: shareBody } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) =>
    c.json({ data: await createShare(c.env, c.get("site").id, c.get("principal").label, await c.req.json()) }, 201 as 200),
  );
  api.openapi(r({ method: "delete", path: "/sites/{site}/shares/{id}", tags: ["Views"], description: "Revoke a share link", request: { params: idParam }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
    await revokeShare(c.env.DB, c.get("site").id, c.get("principal").label, c.req.param("id") ?? "");
    return c.json({ data: { revoked: true } });
  });

  // Tracked links
  api.openapi(r({ method: "get", path: "/sites/{site}/links", tags: ["Links"], description: "Tracked short links (/l/<slug>) with their click counts", request: { params: siteParam }, scope: "stats:read", middleware: [requireSite] }), async (c) => c.json({ data: await listLinks(c.env.DB, c.get("site"), c.env.PUBLIC_ORIGIN) }));
  api.openapi(r({ method: "post", path: "/sites/{site}/links", tags: ["Links"], description: "Create a short link that records a link_click event and redirects", request: { params: siteParam, body: { content: { "application/json": { schema: linkInput } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) =>
    c.json({ data: await saveLink(c.env.DB, c.get("site").id, c.get("principal").label, await c.req.json(), c.env.PUBLIC_ORIGIN) }, 201 as 200),
  );
  api.openapi(r({ method: "delete", path: "/sites/{site}/links/{id}", tags: ["Links"], description: "Delete a short link", request: { params: idParam }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
    await deleteLink(c.env.DB, c.get("site").id, c.get("principal").label, c.req.param("id") ?? "");
    return c.json({ data: { deleted: true } });
  });

  // Connected apps
  api.openapi(r({ method: "get", path: "/connected-apps", tags: ["Admin"], description: "Apps connected through OAuth (claude.ai, Claude Desktop): who connected them, their scopes", scope: "admin" }), async (c) => c.json({ data: await listConnectedApps(c.env, c.get("principal")) }));
  api.openapi(
    r({ method: "delete", path: "/connected-apps/{id}", tags: ["Admin"], description: "Disconnect an app (revokes its grant and tokens)", request: { params: plainId, query: z.object({ user_id: z.string().min(1).max(64) }) }, scope: "admin" }),
    async (c) => {
      await revokeConnectedApp(c.env, c.get("principal"), c.req.param("id") ?? "", c.req.query("user_id") ?? "");
      return c.json({ data: { revoked: true } });
    },
  );

  // Explorers
  api.openapi(
    r({ method: "get", path: "/sites/{site}/properties", tags: ["Stats"], description: "Custom event property keys seen in the range (optionally for one event), with counts; use event_prop:<key> as a dimension", request: { params: siteParam, query: commonQuery.extend({ event: z.string().max(80).optional() }) }, scope: "stats:read", middleware: [requireSite] }),
    async (c) => {
      const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery> & { event?: string };
      return jsonWithEtag(c, await propertyKeys(c.env.DB, c.get("site"), { ...toCommon(qy), event: qy.event })) as never;
    },
  );
  api.openapi(
    r({ method: "get", path: "/sites/{site}/sessions", tags: ["Stats"], description: "Recent anonymous sessions matching the filters (entry, exit, pages, duration, source, device, country), newest first", request: { params: siteParam, query: commonQuery.extend({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.coerce.number().int().optional().openapi({ description: "next_before from the previous page" }) }) }, scope: "stats:read", middleware: [requireSite] }),
    async (c) => {
      const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery> & { limit?: number; before?: number };
      return c.json(await listSessions(c.env.DB, c.get("site"), { ...toCommon(qy), limit: qy.limit, before: qy.before }));
    },
  );
  api.openapi(r({ method: "get", path: "/sites/{site}/sessions/{id}", tags: ["Stats"], description: "One session's hits in order (pages, events, engagement)", request: { params: idParam }, scope: "stats:read", middleware: [requireSite] }), async (c) => {
    const d = await sessionDetail(c.env.DB, c.get("site"), c.req.param("id") ?? "");
    if (!d) throw new ApiError(404, "not_found", "session not found");
    return c.json(d);
  });
  api.openapi(r({ method: "get", path: "/sites/{site}/insights", tags: ["Stats"], description: "Findings for the range: traffic swings, rising and falling pages, new referrers, slower pages, goal changes", request: { params: siteParam, query: commonQuery }, scope: "stats:read", middleware: [requireSite] }), async (c) =>
    jsonWithEtag(c, await cachedReport(c, "insights", () => insights(c.env.DB, c.get("site"), toCommon(c.req.valid("query" as never))))) as never,
  );
}


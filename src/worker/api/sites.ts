// Sites: list, read, create, update, archive/restore/purge, installation check.
import { z, type OpenAPIHono } from "@hono/zod-openapi";
import { canAccessSite, hasScope } from "../auth/principal.ts";
import type { Env } from "../env.ts";
import { audit } from "../lib/audit.ts";
import { DEFAULT_SETTINGS, invalidateSiteCache, listSitesCached, mergeSettings, normalizeDomain, pickSiteColor, rowToSite, siteColorSlot, siteSettingsInput, siteSlug, type Site, type SiteRow } from "../lib/sites.ts";
import { onlyGiven } from "../lib/patch.ts";
import { isValidTimeZone, utcDay } from "../lib/time.ts";
import { ApiError, requireSite, type AppEnv } from "./common.ts";
import { siteParam } from "./params.ts";
import { r } from "./route.ts";

export const siteBody = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .refine((v) => v !== "summary", { message: "summary is reserved" })
    .optional()
    .openapi({ example: "example-site", description: "Optional; derived from the name or first domain" }),
  name: z.string().min(1).max(120).optional().openapi({ description: "Optional; defaults to the first domain" }),
  domains: z.array(z.string().min(3).max(253)).min(1).max(20).openapi({ example: ["example.com", "www.example.com"], description: "Hostnames that may send data. Full URLs are accepted and normalized; *.example.com allows subdomains." }),
  timezone: z.string().default("UTC").openapi({ example: "Europe/Madrid" }),
  settings: siteSettingsInput.optional(),
  retention_months: z.number().int().min(1).max(120).default(25),
});

export function snippetFor(origin: string, siteId: string): string {
  return `<script defer src="${origin}/p.js" data-site="${siteId}"></script>`;
}

/** Normalize domains or throw a 400 naming the ones that aren't valid. */
export function cleanDomains(raw: string[]): string[] {
  const bad: string[] = [];
  const out: string[] = [];
  for (const d of raw) {
    const n = normalizeDomain(d);
    if (!n) bad.push(d);
    else if (!out.includes(n)) out.push(n);
  }
  if (bad.length) throw new ApiError(400, "invalid_domain", `not a valid site domain: ${bad.join(", ")}`, { invalid: bad });
  return out;
}

export async function createSite(db: D1Database, input: z.input<typeof siteBody>, actor: string): Promise<Site> {
  const b = siteBody.parse(input);
  if (!isValidTimeZone(b.timezone)) throw new ApiError(400, "invalid_timezone", "unknown time zone");
  const domains = cleanDomains(b.domains);
  const name = b.name?.trim() || domains[0]!.replace(/^\*\./, "");
  let id = b.id ?? siteSlug(b.name?.trim() || domains[0]!);
  if (!b.id) {
    for (let i = 2; await db.prepare("SELECT 1 FROM sites WHERE id = ?").bind(id).first(); i++) id = `${siteSlug(b.name?.trim() || domains[0]!)}-${i}`;
  }
  const settings = mergeSettings(DEFAULT_SETTINGS, b.settings);
  // The colour is stored at creation, so adding or removing other sites never repaints this one.
  if (!settings.color) {
    const all = await listSitesCached(db);
    settings.color = pickSiteColor(all.map((x) => siteColorSlot(x, all)));
  }
  const res = await db
    .prepare("INSERT OR IGNORE INTO sites (id, name, domains_json, timezone, settings_json, retention_months, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, name, JSON.stringify(domains), b.timezone, JSON.stringify(settings), b.retention_months, Date.now())
    .run();
  if (!res.meta.changes) throw new ApiError(409, "site_exists", `a site with id ${id} already exists`);
  invalidateSiteCache();
  await audit(db, actor, "site.create", id, { domains });
  const row = await db.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<SiteRow>();
  return rowToSite(row!);
}

export async function updateSite(db: D1Database, site: Site, input: Partial<z.input<typeof siteBody>>, actor: string): Promise<Site> {
  const b = onlyGiven(siteBody.partial().omit({ id: true }).parse(input), input);
  if (b.timezone && !isValidTimeZone(b.timezone)) throw new ApiError(400, "invalid_timezone", "unknown time zone");
  const domains = b.domains ? cleanDomains(b.domains) : site.domains;
  const settings = mergeSettings(site.settings, b.settings);
  if (settings.primary_goal && settings.primary_goal !== site.settings.primary_goal) {
    const goal = await db.prepare("SELECT 1 AS ok FROM goals WHERE id = ? AND site_id = ?").bind(settings.primary_goal, site.id).first();
    if (!goal) throw new ApiError(400, "invalid_primary_goal", "primary_goal must be one of this site's goal ids");
  }
  await db
    .prepare("UPDATE sites SET name = ?, domains_json = ?, timezone = ?, settings_json = ?, retention_months = ? WHERE id = ?")
    .bind(b.name?.trim() || site.name, JSON.stringify(domains), b.timezone ?? site.timezone, JSON.stringify(settings), b.retention_months ?? site.retention_months, site.id)
    .run();
  invalidateSiteCache();
  await audit(db, actor, "site.update", site.id, Object.keys(input));
  const row = await db.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first<SiteRow>();
  return rowToSite(row!);
}

export async function archiveSite(db: D1Database, siteId: string, actor: string): Promise<void> {
  await db.prepare("UPDATE sites SET archived_at = ? WHERE id = ? AND archived_at IS NULL").bind(Date.now(), siteId).run();
  invalidateSiteCache();
  await audit(db, actor, "site.archive", siteId);
}

/** Delete a site and everything recorded for it. Checks linked to it are kept and unlinked. */
export async function purgeSite(db: D1Database, siteId: string, actor: string): Promise<Record<string, number>> {
  const tables = ["events", "sessions", "rollups_daily", "stat_days", "stat_state", "goals", "funnels", "annotations", "ingest_stats", "imports", "share_links", "saved_views", "alert_rules", "alert_events", "links"];
  const res = await db.batch([
    ...tables.map((t) => db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(siteId)),
    db.prepare("UPDATE monitors SET site_id = NULL WHERE site_id = ?").bind(siteId),
    db.prepare("DELETE FROM kv_meta WHERE key IN (?, ?, ?)").bind(`rejected_host:${siteId}`, `data_range:${siteId}`, `data_counts:${siteId}`),
    db.prepare("DELETE FROM sites WHERE id = ?").bind(siteId),
  ]);
  invalidateSiteCache();
  const counts = Object.fromEntries(tables.map((t, i) => [t, res[i]!.meta.changes ?? 0]));
  await audit(db, actor, "site.purge", siteId, counts);
  return counts;
}

export interface DataRange {
  first_event: string | null;
  last_event: string | null;
  imported_events: number;
  live_events: number;
}

/**
 * First and last event, read fresh through the (site_id, ts) index (two index lookups, no scan), plus imported vs live
 * counts, which do scan the site's events: those are counted hourly by the cron (dataCounts) and only read here, so a
 * GET never writes.
 */
export async function dataRange(db: D1Database, siteId: string): Promise<DataRange> {
  const [edges, counts] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT (SELECT ts FROM events WHERE site_id = ?1 ORDER BY ts LIMIT 1) AS first, (SELECT ts FROM events WHERE site_id = ?1 ORDER BY ts DESC LIMIT 1) AS last")
      .bind(siteId),
    db.prepare("SELECT value FROM kv_meta WHERE key = ?").bind(`data_counts:${siteId}`),
  ]);
  const e = edges!.results[0] as { first: number | null; last: number | null } | undefined;
  let c = { imported: 0, live: 0 };
  try {
    const raw = (counts!.results[0] as { value?: string } | undefined)?.value;
    if (raw) c = JSON.parse(raw) as typeof c;
  } catch {
    /* recomputed within the hour */
  }
  return {
    first_event: e?.first ? new Date(e.first).toISOString() : null,
    last_event: e?.last ? new Date(e.last).toISOString() : null,
    imported_events: c.imported,
    live_events: c.live,
  };
}

/** Hourly cron: imported vs live event counts per site, for dataRange. */
export async function dataCounts(db: D1Database, siteIds: string[], now = Date.now()): Promise<void> {
  for (const id of siteIds) {
    const r = await db.prepare("SELECT SUM(source = 'rybbit') AS imported, SUM(source = 'pulse') AS live FROM events WHERE site_id = ?").bind(id).first<{ imported: number | null; live: number | null }>();
    await db
      .prepare("INSERT INTO kv_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(`data_counts:${id}`, JSON.stringify({ imported: r?.imported ?? 0, live: r?.live ?? 0 }), now)
      .run();
  }
}

/** Per UTC day: hits accepted and dropped, by reason (bots, hosting networks, DNT, wrong host, excluded, rate, cap, invalid). */
export async function ingestDays(db: D1Database, siteId: string, days: number, now = Date.now()) {
  const from = new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT day, accepted, dropped_bot AS bot, dropped_hosting AS hosting, dropped_dnt AS dnt, dropped_host AS wrong_host, dropped_excluded AS excluded,
         dropped_rate AS rate_limited, dropped_cap AS over_cap, dropped_invalid AS invalid
       FROM ingest_stats WHERE site_id = ? AND day >= ? ORDER BY day`,
    )
    .bind(siteId, from)
    .all<Record<string, number | string>>();
  const reasons = ["bot", "hosting", "dnt", "wrong_host", "excluded", "rate_limited", "over_cap", "invalid"] as const;
  const totals = Object.fromEntries(["accepted", ...reasons].map((k) => [k, results.reduce((a, r) => a + Number(r[k] ?? 0), 0)]));
  const dropped = reasons.reduce((a, k) => a + Number(totals[k] ?? 0), 0);
  return { days: results, totals, dropped_pct: Number(totals.accepted) + dropped ? Math.round((1000 * dropped) / (Number(totals.accepted) + dropped)) / 10 : 0 };
}

// ---------- Installation check ----------

export interface Finding {
  level: "ok" | "info" | "warn" | "error";
  code: string;
  message: string;
  fix?: string;
}

/** Does a CSP directive value allow loading from `origin` (optionally a specific path like `/p.js`)? */
export function cspAllows(value: string | undefined, origin: string, path?: string): boolean {
  if (value === undefined) return true;
  const lowOrigin = origin.toLowerCase().replace(/\/$/, "");
  const host = new URL(origin).host.toLowerCase();
  const tokens = value.split(/\s+/).filter(Boolean);
  return tokens.some((t) => {
    const s = t.toLowerCase();
    const noSlash = s.replace(/\/$/, "");
    if (noSlash === "*" || noSlash === "https:" || noSlash === lowOrigin) return true;
    if (noSlash === host || noSlash === `https://${host}`) return true;
    if (path && (s === `${lowOrigin}${path}` || s === `${host}${path}`)) return true;
    const wild = noSlash.replace(/^https:\/\//, "");
    return wild.startsWith("*.") && host.endsWith(wild.slice(1));
  });
}

export function parseCsp(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] = rest.join(" ");
  }
  return out;
}

export function findSnippets(html: string): { src: string; site: string | null }[] {
  const out: { src: string; site: string | null }[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!src || !/\/p(\.v1)?\.js(\?|$)/.test(src)) continue;
    out.push({ src, site: /\sdata-site\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? null });
  }
  return out;
}

export async function installCheck(env: Env, site: Site, fetcher: typeof fetch = fetch, now = Date.now()) {
  const findings: Finding[] = [];
  const [last, today, rejected] = await Promise.all([
    env.DB.prepare("SELECT MAX(ts) AS ts FROM events WHERE site_id = ? AND source = 'pulse' AND type = 'pageview'").bind(site.id).first<{ ts: number | null }>(),
    env.DB.prepare("SELECT accepted, dropped_bot, dropped_hosting, dropped_dnt, dropped_invalid, dropped_rate, dropped_host, dropped_excluded, dropped_cap, revenue_ignored FROM ingest_stats WHERE day = ? AND site_id = ?").bind(utcDay(now), site.id).first<Record<string, number>>(),
    env.DB.prepare("SELECT value FROM kv_meta WHERE key = ?").bind(`rejected_host:${site.id}`).first<{ value: string }>(),
  ]);
  const lastPageview = last?.ts ?? null;
  if (lastPageview) {
    const ageMin = Math.round((now - lastPageview) / 60_000);
    findings.push({ level: "ok", code: "receiving", message: ageMin < 60 * 24 ? `Receiving data. Last pageview ${ageMin < 1 ? "just now" : `${ageMin} min ago`}.` : `Data has arrived before, but the last pageview was ${Math.round(ageMin / 1440)} days ago.` });
  } else {
    const visitDomain = site.domains.find((d) => !d.startsWith("*.")) ?? site.domains[0]?.replace(/^\*\./, "") ?? "the site";
    findings.push({ level: "info", code: "no_data", message: "No pageviews yet.", fix: `Add the snippet to your pages, then open ${visitDomain} in a browser.` });
  }
  if (today?.dropped_host) {
    const host = rejected ? (JSON.parse(rejected.value) as { host: string }).host : null;
    findings.push({ level: "warn", code: "wrong_host", message: `${today.dropped_host} hit(s) today came from ${host ?? "a hostname"} that isn't in this site's domains.`, fix: host ? `Add ${host} to the site's domains if it's yours.` : "Check the site's domains." });
  }
  if (today?.dropped_cap)
    findings.push({ level: "error", code: "daily_cap", message: `Ingest is paused until 00:00 UTC: the site reached its daily cap of ${site.settings.daily_event_cap.toLocaleString("en")} events and ${today.dropped_cap} hit(s) were dropped since.`, fix: "Raise settings.daily_event_cap (0 turns the cap off) if the traffic is real; otherwise block the source." });
  if (today?.dropped_bot) findings.push({ level: "info", code: "bots", message: `${today.dropped_bot} hit(s) today were dropped as bots or automated browsers.` });
  if (today?.dropped_hosting) findings.push({ level: "info", code: "hosting", message: `${today.dropped_hosting} hit(s) today came from hosting or cloud networks and were dropped (settings.block_hosting).` });
  if (today?.dropped_dnt) findings.push({ level: "info", code: "dnt", message: `${today.dropped_dnt} hit(s) today were dropped because the browser sent Do Not Track or Global Privacy Control (settings.respect_dnt).` });

  const pages = [];
  for (const domain of site.domains.filter((d) => !d.startsWith("*.")).slice(0, 3)) {
    const url = `https://${domain}/`;
    try {
      const res = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(5000), headers: { "User-Agent": `PulseInstallCheck/1.0 (+${env.PUBLIC_ORIGIN}/docs)` } });
      const reader = res.body?.getReader();
      let html = "";
      if (reader) {
        const dec = new TextDecoder();
        for (let n = 0; n < 512 * 1024; ) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          n += value.byteLength;
          html += dec.decode(value, { stream: true });
        }
        await reader.cancel().catch(() => {});
      }
      const snippets = findSnippets(html);
      const csp = parseCsp(res.headers.get("content-security-policy"));
      const scriptOk = cspAllows(csp["script-src-elem"] ?? csp["script-src"] ?? csp["default-src"], env.PUBLIC_ORIGIN, "/p.js");
      const connectOk = cspAllows(csp["connect-src"] ?? csp["default-src"], env.PUBLIC_ORIGIN, "/e");
      const mine = snippets.find((s) => s.site === site.id);
      pages.push({ url, http_status: res.status, snippet: mine ? "found" : snippets.length ? "other_site" : "missing", snippet_sites: snippets.map((s) => s.site), csp_blocks_script: !scriptOk, csp_blocks_beacon: !connectOk });
      if (mine) findings.push({ level: "ok", code: "snippet_found", message: `The snippet is on ${url}.` });
      else if (snippets.length) findings.push({ level: "error", code: "snippet_wrong_site", message: `${url} has the Pulse script with data-site="${snippets[0]!.site ?? ""}", not "${site.id}".`, fix: `Set data-site="${site.id}".` });
      else if (!lastPageview) findings.push({ level: "warn", code: "snippet_missing", message: `The snippet wasn't found in the HTML of ${url}.`, fix: "Add it to the <head> of every page. If your site adds it with JavaScript, ignore this once pageviews arrive." });
      if (!scriptOk) findings.push({ level: "error", code: "csp_script", message: `${domain}'s Content-Security-Policy blocks loading ${env.PUBLIC_ORIGIN}/p.js.`, fix: `Add ${env.PUBLIC_ORIGIN} to script-src.` });
      if (!connectOk) findings.push({ level: "error", code: "csp_connect", message: `${domain}'s Content-Security-Policy blocks sending data to ${env.PUBLIC_ORIGIN}.`, fix: `Add ${env.PUBLIC_ORIGIN} to connect-src.` });
    } catch (err) {
      pages.push({ url, http_status: null, snippet: "unknown", snippet_sites: [], csp_blocks_script: false, csp_blocks_beacon: false });
      findings.push({ level: "warn", code: "fetch_failed", message: `Couldn't load ${url}: ${String((err as Error).message ?? err).slice(0, 120)}.` });
    }
  }
  const status = lastPageview && now - lastPageview < 7 * 86_400_000 ? "receiving" : findings.some((f) => f.code === "snippet_found") ? "installed" : "waiting";
  return {
    site: site.id,
    status,
    last_pageview_at: lastPageview ? new Date(lastPageview).toISOString() : null,
    today: today ?? { accepted: 0, dropped_bot: 0, dropped_hosting: 0, dropped_dnt: 0, dropped_invalid: 0, dropped_rate: 0, dropped_host: 0, dropped_excluded: 0, dropped_cap: 0, revenue_ignored: 0 },
    snippet: snippetFor(env.PUBLIC_ORIGIN, site.id),
    pages,
    findings,
  };
}

// ---------- Routes ----------

export function registerSites(api: OpenAPIHono<AppEnv>): void {
  api.openapi(
    r({ method: "get", path: "/sites", tags: ["Sites"], description: "Sites the caller can access, with their data range. Hidden (internal) sites have settings.hidden = true.", scope: "stats:read", request: { query: z.object({ include_archived: z.enum(["true", "false"]).optional().openapi({ description: "Admins only: also list archived sites" }) }) } }),
    async (c) => {
      const p = c.get("principal");
      const all = await listSitesCached(c.env.DB);
      const color = (s: Site) => siteColorSlot(s, all);
      let sites = all.filter((s) => canAccessSite(p, s.id));
      if (c.req.query("include_archived") === "true" && hasScope(p, "admin")) {
        const { results } = await c.env.DB.prepare("SELECT * FROM sites WHERE archived_at IS NOT NULL ORDER BY archived_at DESC").all<SiteRow>();
        sites = [...sites, ...results.map(rowToSite)];
      }
      // A share link sees only what its page needs: no settings, no site-wide counts.
      if (p.kind === "share")
        return c.json({ data: sites.map((s) => ({ id: s.id, name: s.name, domains: s.domains, timezone: s.timezone, color: color(s), settings: { hidden: s.settings.hidden, revenue_currency: s.settings.revenue_currency }, data_range: { first_event: null, last_event: null } })) });
      const ranges = await Promise.all(sites.map((s) => dataRange(c.env.DB, s.id)));
      return c.json({ data: sites.map((s, i) => ({ ...s, color: color(s), data_range: ranges[i] })) });
    },
  );

  api.openapi(r({ method: "get", path: "/sites/{site}", tags: ["Sites"], description: "One site with its settings and tracking snippet", request: { params: siteParam }, scope: "stats:read", middleware: [requireSite] }), async (c) =>
    c.json({ data: { ...c.get("site"), color: siteColorSlot(c.get("site"), await listSitesCached(c.env.DB)), snippet: snippetFor(c.env.PUBLIC_ORIGIN, c.get("site").id) } }),
  );

  api.openapi(
    r({ method: "post", path: "/sites", tags: ["Sites"], description: "Create a site. Only domains are required; returns the tracking snippet and next steps.", request: { body: { content: { "application/json": { schema: siteBody } } } }, scope: "sites:write" }),
    async (c) => {
      if (c.get("principal").siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys cannot create sites");
      const site = await createSite(c.env.DB, await c.req.json(), c.get("principal").label);
      return c.json(
        {
          data: site,
          snippet: snippetFor(c.env.PUBLIC_ORIGIN, site.id),
          next_steps: [
            `Add the snippet to the <head> of every page on ${site.domains.join(", ")}.`,
            `Open the site in a browser, then check GET /api/v1/sites/${site.id}/install-check.`,
            "Optional: add goals (POST /sites/{site}/goals) and status checks (POST /ops/monitors).",
          ],
        },
        201 as 200,
      );
    },
  );

  api.openapi(
    r({ method: "patch", path: "/sites/{site}", tags: ["Sites"], description: "Update a site's name, domains, time zone, retention or settings (settings are merged)", request: { params: siteParam, body: { content: { "application/json": { schema: siteBody.partial().omit({ id: true }) } } } }, scope: "sites:write", middleware: [requireSite] }),
    async (c) => c.json({ data: await updateSite(c.env.DB, c.get("site"), await c.req.json(), c.get("principal").label) }),
  );

  api.openapi(
    r({
      method: "delete",
      path: "/sites/{site}",
      tags: ["Sites"],
      description: "Archive a site (stops collecting, hides it; restorable). With purge=true and confirm=<site id> (admin), delete the site and all its data permanently.",
      request: { params: siteParam, query: z.object({ purge: z.enum(["true", "false"]).optional(), confirm: z.string().optional() }) },
      scope: "sites:write",
    }),
    async (c) => {
      const id = c.req.param("site") ?? "";
      const p = c.get("principal");
      if (!canAccessSite(p, id)) throw new ApiError(404, "site_not_found", "site not found");
      const row = await c.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<SiteRow>();
      if (!row) throw new ApiError(404, "site_not_found", "site not found");
      if (c.req.query("purge") === "true") {
        if (!hasScope(p, "admin")) throw new ApiError(403, "insufficient_scope", "deleting a site's data requires scope admin");
        if (c.req.query("confirm") !== id) throw new ApiError(400, "confirm_required", `pass confirm=${id} to delete this site and all its data`);
        return c.json({ data: { deleted: true, rows: await purgeSite(c.env.DB, id, p.label) } });
      }
      await archiveSite(c.env.DB, id, p.label);
      return c.json({ data: { archived: true } });
    },
  );

  api.openapi(r({ method: "post", path: "/sites/{site}/restore", tags: ["Sites"], description: "Restore an archived site", request: { params: siteParam }, scope: "sites:write" }), async (c) => {
    const id = c.req.param("site") ?? "";
    if (!canAccessSite(c.get("principal"), id)) throw new ApiError(404, "site_not_found", "site not found");
    const res = await c.env.DB.prepare("UPDATE sites SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL").bind(id).run();
    if (!res.meta.changes) throw new ApiError(404, "not_archived", "no archived site with that id");
    invalidateSiteCache();
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "site.restore", id));
    const row = await c.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<SiteRow>();
    return c.json({ data: rowToSite(row!) });
  });

  api.openapi(
    r({ method: "get", path: "/sites/{site}/install-check", tags: ["Sites"], description: "Is the tracker installed? Last pageview, today's accepted/dropped hits, and a fetch of each domain's home page looking for the snippet and a blocking Content-Security-Policy", request: { params: siteParam }, scope: "stats:read", middleware: [requireSite] }),
    async (c) => c.json({ data: await installCheck(c.env, c.get("site")) }),
  );
}

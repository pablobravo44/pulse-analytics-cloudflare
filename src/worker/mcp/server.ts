import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createUser, disableUser, enableUser, listKeys, revokeKey, updateKey, updateUser, listUsers } from "../api/admin.ts";
import { exportRows } from "../api/export.ts";
import { health } from "../api/health.ts";
import { VERSION } from "../api/health.ts";
import { createMonitor, deleteMonitor, getMonitor, listIncidents, listMonitors, monitorView, pauseMonitor, runMonitorNow, testMonitor, updateIncidentRecord, updateMonitor, updateOpsSettings, canTouchMonitor } from "../api/ops.ts";
import { archiveSite, createSite, dataRange, installCheck, purgeSite, snippetFor, updateSite } from "../api/sites.ts";
import { canAccessSite, hasScope, SCOPE_INFO, SCOPES, type Principal, type Scope } from "../auth/principal.ts";
import { capabilitiesFor, capabilityByTool, CAPABILITIES } from "../catalog.ts";
import type { Env } from "../env.ts";
import { audit } from "../lib/audit.ts";
import { ANNOTATION_CATEGORIES, annotationView, type AnnotationRow } from "../lib/annotations.ts";
import { deleteAnnotation, deleteFunnel, deleteGoal, getFunnel, listFunnels, saveFunnel, saveGoal, updateAnnotation } from "../lib/definitions.ts";
import { createShare, deleteLink, deleteView, listConnectedApps, listLinks, listShares, listViews, revokeConnectedApp, revokeShare, saveLink, saveView } from "../api/features.ts";
import { deleteData } from "../api/deletedata.ts";
import { alertHistory, ALERT_INFO, ALERT_KINDS, deleteAlert, evaluateRule, listAlerts, saveAlert, type AlertRow } from "../ops/alerts.ts";
import { CHANNEL_INFO, CHANNEL_KINDS, createChannel, deleteChannel, listChannels, testChannel, updateChannel } from "../ops/notify.ts";
import { buildReport, createReport, deleteReport, getReport, listReports, REPORT_SECTIONS, reportFor, reportView, sendReport, updateReport } from "../ops/reports.ts";
import { ulid } from "../lib/ids.ts";
import { getOpsSettings } from "../lib/settings.ts";
import { invalidateSiteCache, listSitesCached, rowToSite, SITE_COLORS, type Site, type SiteRow } from "../lib/sites.ts";
import { fullGuide, guideTopic, SCHEMA_DOC, TOPICS } from "../guide.ts";
import { errors as errorsReport, funnel, FUNNEL_BREAKDOWNS, insights, listSessions, pageReport, paths, propertyKeys, retention, sessionDetail, vitals } from "../query/analyses.ts";
import { aiSources, breakdown, movers, realtime, summary, timeseries, type Common } from "../query/presets.ts";
import { overview } from "../query/overview.ts";
import { sitesSummary } from "../query/home.ts";
import { resolveRange } from "../query/range.ts";
import { runQuery } from "../query/run.ts";
import { BASE_DIMENSIONS, DATE_PRESETS, FILTER_OPS, METRICS, querySchema } from "../query/schema.ts";
import { INTERVALS, MONITOR_KINDS, statusReport } from "../ops/monitor.ts";

const MAX_ROWS = 1000;
type FunnelSteps = Parameters<typeof funnel>[2]["steps"];

export class McpToolError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const dateRange = z
  .union([z.enum(DATE_PRESETS), z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), z.object({ last_minutes: z.number().int().min(5).max(10_080) })])
  .optional()
  .describe('Preset ("today", "yesterday", "24h", "7d", "28d", "30d", "90d", "mtd", "last_month", "ytd", "12mo", "all"), {from,to} as YYYY-MM-DD in the site time zone, or a rolling {last_minutes}. Default 28d.');
const filters = z
  .array(z.tuple([z.enum(FILTER_OPS), z.string(), z.array(z.union([z.string(), z.number()]))]))
  .optional()
  .describe('Array of [operator, dimension, values]. Operators: is, is_one_of, is_not, contains, not_contains, starts_with, matches / not_matches (* wildcard, e.g. "/blog/*"). Dimension "goal" with goal ids keeps sessions that converted (is) or did not (is_not). Example: [["is","country",["ES"]],["matches","page",["/blog/*"]],["is","goal",["g_abc"]]]. Use "(none)" to match empty values.');
const common = {
  site: z.string().optional().describe("Site id from list_sites. Optional when your key covers exactly one site."),
  date_range: dateRange,
  timezone: z.enum(["site", "UTC"]).optional().describe("Default: the site's time zone."),
  compare: z
    .union([z.enum(["previous_period", "previous_year"]), z.object({ from: z.string(), to: z.string() })])
    .nullable()
    .optional()
    .describe('Comparison period: "previous_period", "previous_year", or explicit days {from,to} (YYYY-MM-DD).'),
  filters,
};
type CommonArgs = { site?: string; date_range?: Common["date_range"]; timezone?: "site" | "UTC"; compare?: Common["compare"]; filters?: Common["filters"] };

function toCommon(a: CommonArgs): Common {
  return { date_range: a.date_range ?? "28d", timezone: a.timezone ?? "site", compare: a.compare, filters: (a.filters ?? []) as Common["filters"] };
}

function capRows<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v) && v.length > MAX_ROWS) (obj as Record<string, unknown>)[k] = v.slice(0, MAX_ROWS);
  }
  return obj;
}

const goalMatch = z.object({
  kind: z.enum(["pageview", "event", "outbound"]),
  path: z.string().optional().describe("pageview: path, * wildcards"),
  event: z.string().optional().describe("event: event name"),
  host: z.string().optional().describe("outbound: host(s), comma-separated"),
  prop: z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }).optional().describe("event: require this property value"),
});

/** A short hint that tells an agent what to do about an error. */
function hintFor(code: string, principal: Principal, message: string): string | undefined {
  if (code === "insufficient_scope") {
    const scope = /scope ([a-z:]+)/.exec(message)?.[1];
    return `This key lacks ${scope ?? "a scope"}. Ask an admin to add it in the dashboard (Settings → API keys → edit this key); it applies on your next call. whoami lists what you can do.`;
  }
  if (code === "site_not_found" || code === "site_required") return "Call list_sites for the site ids this key can use.";
  if (code === "invalid_request" && /dimension/.test(message)) return `Valid dimensions: ${BASE_DIMENSIONS.join(", ")}, event_prop:<key>.`;
  if (code === "invalid_request") return "Check the arguments against the tool's schema; help {topic} has examples.";
  return principal ? undefined : undefined;
}

const READ_ONLY_ADMIN_TOOLS = new Set(["list_keys", "list_users", "list_connected_apps", "audit_log", "list_imports", "list_shares", "list_databases"]);

function instructionsFor(p: Principal, sites: Site[]): string {
  const caps = capabilitiesFor(p);
  const tools = caps.can.map((c) => c.tool).filter(Boolean);
  const writes = caps.can.filter((c) => {
    if (!c.tool || READ_ONLY_ADMIN_TOOLS.has(c.tool)) return false;
    const cap = capabilityByTool(c.tool);
    return !!cap?.scope && cap.scope !== "stats:read" && cap.scope !== "events:export";
  });
  return [
    "Pulse is a private, cookieless web analytics service with uptime checks.",
    `You are ${p.label} with scopes ${p.scopes.join(", ")}; sites: ${p.siteIds === null ? `all (${sites.map((s) => s.id).join(", ") || "none yet"})` : p.siteIds.join(", ")}.`,
    "Start with list_sites, then site_overview. Use query for anything custom (metrics × dimensions × filters). Call help {topic} for metrics, dimensions, filters, the tracker snippet and events, status checks, scopes and recipes; whoami for what this key can and can't do.",
    writes.length ? `You can change things with: ${writes.map((c) => c.tool).join(", ")}.` : "This key is read-only.",
    caps.missing_scopes.length ? `Not available to this key: ${caps.missing_scopes.map((s) => `${s.scope} (${s.allows[0]!.toLowerCase()}${s.allows.slice(1)})`).join("; ")}. An admin can grant these by editing the key in the dashboard.` : "",
    "Caveats: visitor ids rotate daily, so 'visitors' over several days counts visitor-days; retention is same-day; days are local to the site's time zone.",
    `Tools available to you: ${tools.length}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildMcpServer(env: Env, principal: Principal, sitesForInstructions: Site[] = []): McpServer {
  const server = new McpServer({ name: "pulse", version: VERSION }, { instructions: instructionsFor(principal, sitesForInstructions) });

  async function site(id: string | undefined): Promise<Site> {
    const all = (await listSitesCached(env.DB)).filter((s) => canAccessSite(principal, s.id));
    if (!id) {
      if (all.length === 1) return all[0]!;
      throw new McpToolError("site_required", `site is required; one of: ${all.map((s) => s.id).join(", ")}`);
    }
    const s = all.find((x) => x.id === id);
    if (!s) throw new McpToolError("site_not_found", `unknown site ${id}; yours: ${all.map((x) => x.id).join(", ")}`);
    return s;
  }

  function need(scope: Scope) {
    if (!hasScope(principal, scope)) throw new McpToolError("insufficient_scope", `requires scope ${scope}`);
  }

  /**
   * Register a tool if the caller's scopes allow it (its scope comes from the capability catalog), so tools/list
   * shows exactly what this key can do. The run function still checks the scope.
   */
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    opts: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; text?: boolean } = {},
  ) => {
    const cap = capabilityByTool(name);
    if (!cap) throw new Error(`tool ${name} is missing from the capability catalog`);
    if (cap.scope && !hasScope(principal, cap.scope)) return;
    const readOnly = opts.readOnly ?? true;
    server.registerTool(
      name,
      {
        description: `${description}${cap.scope && cap.scope !== "stats:read" ? ` Requires ${cap.scope}.` : ""}`,
        inputSchema: shape,
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && !!opts.destructive, idempotentHint: readOnly || !!opts.idempotent, openWorldHint: false },
      },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          if (cap.scope) need(cap.scope);
          const out = await run(args);
          if (opts.text && typeof out === "string") return { content: [{ type: "text" as const, text: out }] };
          return { content: [{ type: "text" as const, text: JSON.stringify(capRows(out as Record<string, unknown>)) }] };
        } catch (err) {
          const code = err instanceof McpToolError ? err.code : err instanceof z.ZodError ? "invalid_request" : ((err as { code?: string }).code ?? "error");
          const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message;
          const hint = (err instanceof McpToolError && err.hint) || hintFor(code, principal, message);
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message, ...(hint ? { hint } : {}) } }) }] };
        }
      }) as never,
    );
  };

  // ---------- Orientation ----------
  tool("whoami", "Who you are and what this key can do: scopes, sites, the tools and REST operations available, what is locked and which scope would unlock it.", {}, async () => {
    const sites = (await listSitesCached(env.DB)).filter((s) => canAccessSite(principal, s.id));
    return {
      you: { kind: principal.kind, label: principal.label, role: principal.role ?? null, scopes: principal.scopes, site_ids: principal.siteIds },
      sites: sites.map((s) => ({ id: s.id, name: s.name, domains: s.domains, timezone: s.timezone, hidden: s.settings.hidden })),
      ...capabilitiesFor(principal),
      scopes: Object.fromEntries(SCOPES.map((s) => [s, SCOPE_INFO[s]])),
      how_to_get_more: "Ask an admin to edit this key in the dashboard (Settings → API keys): name, scopes, sites and expiry can change without a new key.",
      links: { dashboard: env.PUBLIC_ORIGIN, docs: `${env.PUBLIC_ORIGIN}/docs`, agent_guide: `${env.PUBLIC_ORIGIN}/docs/agents`, openapi: `${env.PUBLIC_ORIGIN}/api/v1/openapi.json`, rest: `${env.PUBLIC_ORIGIN}/api/v1` },
      rate_limit: "600 requests per minute per key",
    };
  });

  tool(
    "help",
    `Guides for using Pulse. Topics: ${TOPICS.join(", ")}. "tracker" has the install snippet and custom events (for adding tracking to a site's code); "status_checks" has every check kind with examples; "recipes" has step-by-step workflows.`,
    { topic: z.enum(TOPICS).optional().describe("Default overview") },
    async (a) => guideTopic(a.topic ?? "overview", env.PUBLIC_ORIGIN),
    { text: true },
  );

  // ---------- Sites ----------
  tool("list_sites", "List the sites you can access with domains, time zone, settings and data range (first/last event, imported vs live counts). Call this first. include_archived (admin) adds archived sites, which archive_site can restore.", { include_archived: z.boolean().optional() }, async (a) => {
    const sites: (Site & { archived?: boolean })[] = (await listSitesCached(env.DB)).filter((s) => canAccessSite(principal, s.id));
    if (a.include_archived && hasScope(principal, "admin")) {
      const { results } = await env.DB.prepare("SELECT * FROM sites WHERE archived_at IS NOT NULL ORDER BY archived_at DESC").all<SiteRow>();
      sites.push(...results.map((r) => ({ ...rowToSite(r), archived: true })).filter((s) => canAccessSite(principal, s.id)));
    }
    const out = await Promise.all(
      sites.map(async (s) => {
        const r = await dataRange(env.DB, s.id);
        return { id: s.id, name: s.name, domains: s.domains, timezone: s.timezone, hidden: s.settings.hidden, ...(s.archived ? { archived: true } : {}), ...r };
      }),
    );
    return { sites: out, summary: `${out.length} site(s): ${out.map((s) => s.id).join(", ")}` };
  });

  tool("get_site", "One site's settings (features, kept query parameters, excluded paths, retention…) and its tracking snippet.", { site: common.site }, async (a) => {
    const s = await site(a.site);
    return { ...s, snippet: snippetFor(env.PUBLIC_ORIGIN, s.id), data_range: await dataRange(env.DB, s.id) };
  });

  const siteSettings = z
    .object({
      features: z.object({ outbound: z.boolean(), downloads: z.boolean(), engagement: z.boolean(), vitals: z.boolean(), errors: z.boolean() }).partial().optional(),
      query_allowlist: z.array(z.string()).optional().describe("Query parameters kept in page URLs"),
      respect_dnt: z.boolean().optional(),
      block_hosting: z.boolean().optional().describe("Drop visits from hosting/cloud networks (datacenter traffic with browser user agents); counted as dropped_hosting. Default true"),
      exclude_paths: z.array(z.string()).optional().describe('Path globs dropped at ingest, e.g. ["/admin/*"]'),
      exclude_hosts: z.array(z.string()).optional().describe('Hostname globs dropped at ingest, e.g. ["staging.*"]'),
      search_params: z.array(z.string()).optional().describe('Query parameters that hold an on-site search, e.g. ["q"]; becomes the search_term dimension'),
      block_referrers: z.array(z.string()).optional().describe("Referrer hosts dropped as spam"),
      block_countries: z.array(z.string()).optional().describe("ISO-2 country codes dropped"),
      revenue_currency: z.string().optional().describe("Currency of the revenue event property, e.g. EUR; revenue sent with another currency is ignored"),
      hidden: z.boolean().optional().describe("Internal site: left out of the sites board, reports and connector consent"),
      include_in_digest: z.boolean().optional().describe("Included in reports that don't list their sites"),
      daily_event_cap: z.number().int().min(0).optional().describe("Circuit breaker: after this many accepted events in a UTC day, ingest pauses until the next day and an email goes to the alert address (default 200000; 0 = no cap)"),
      color: z.enum(SITE_COLORS).nullable().optional().describe(`The site's colour in the dashboard: ${SITE_COLORS.join(", ")}; null = by creation order`),
      primary_goal: z.string().nullable().optional().describe("Goal id shown on the home card and first in reports; null = none"),
    })
    .optional();
  tool(
    "save_site",
    "Add a site (only domains are required; returns the tracking snippet) or update one by id (name, domains, time zone, retention, settings; settings are merged). After adding, put the snippet in the site's <head> and call install_check.",
    {
      id: z.string().optional().describe("Site id: an existing id to update, or a custom slug when creating (omit to derive from the name or domain)"),
      name: z.string().optional(),
      domains: z.array(z.string()).optional().describe("Hostnames that may send data; URLs are accepted. Required when creating."),
      timezone: z.string().optional().describe("IANA time zone, e.g. Europe/Madrid. Decides what a day is in reports."),
      retention_months: z.number().int().min(1).max(120).optional(),
      settings: siteSettings,
    },
    async (a) => {
      const all = await listSitesCached(env.DB);
      const existing = a.id ? all.find((s) => s.id === a.id) : undefined;
      if (existing) {
        if (!canAccessSite(principal, existing.id)) throw new McpToolError("site_not_found", `unknown site ${a.id}`);
        const { id: _id, ...patch } = a;
        const updated = await updateSite(env.DB, existing, patch, principal.label);
        return { site: updated, snippet: snippetFor(env.PUBLIC_ORIGIN, updated.id) };
      }
      if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys cannot create sites");
      if (!a.domains?.length) throw new McpToolError("invalid_request", "domains is required to create a site");
      const s = await createSite(env.DB, { ...a, domains: a.domains, settings: a.settings, timezone: a.timezone ?? "UTC" }, principal.label);
      return { site: s, snippet: snippetFor(env.PUBLIC_ORIGIN, s.id), next_steps: ["Add the snippet to the <head> of every page (help {topic:'tracker'} has framework examples).", `Deploy, open the site, then install_check {site:"${s.id}"}.`] };
    },
    { readOnly: false, idempotent: true },
  );

  tool(
    "archive_site",
    "Archive a site (stops collecting data and hides it; restorable with restore=true). With purge=true and confirm set to the site id (admin), delete the site and all its data permanently: the only undo is D1 Time Travel.",
    { site: z.string(), restore: z.boolean().optional(), purge: z.boolean().optional(), confirm: z.string().optional().describe("The site id again, required with purge") },
    async (a) => {
      if (!canAccessSite(principal, a.site)) throw new McpToolError("site_not_found", `unknown site ${a.site}`);
      if (a.purge) {
        need("admin");
        if (a.confirm !== a.site) throw new McpToolError("confirm_required", `pass confirm: "${a.site}" to delete this site and all its data`);
        if (!(await env.DB.prepare("SELECT 1 FROM sites WHERE id = ?").bind(a.site).first())) throw new McpToolError("site_not_found", `unknown site ${a.site}`);
        return { deleted: true, rows: await purgeSite(env.DB, a.site, principal.label) };
      }
      if (a.restore) {
        const res = await env.DB.prepare("UPDATE sites SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL").bind(a.site).run();
        if (!res.meta.changes) throw new McpToolError("not_archived", `no archived site ${a.site}`);
        invalidateSiteCache();
        await audit(env.DB, principal.label, "site.restore", a.site);
        const row = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(a.site).first<SiteRow>();
        return { restored: true, site: rowToSite(row!) };
      }
      await site(a.site);
      await archiveSite(env.DB, a.site, principal.label);
      return { archived: true, site: a.site };
    },
    { readOnly: false, destructive: true, idempotent: true },
  );

  tool("install_check", "Is the tracker installed on a site? Last pageview, today's accepted and dropped hits (wrong hostname, bots), and a fetch of the home page looking for the snippet and a Content-Security-Policy that would block it. Findings come with fixes.", { site: common.site }, async (a) =>
    installCheck(env, await site(a.site)),
  );

  // ---------- Stats ----------
  tool(
    "sites_summary",
    "Every site you can access at a glance, in one call: visitors with change vs the previous period and a daily (or hourly for today) series, today so far vs yesterday at the same time, visitors live now, top page and source, main goal conversions, errors in the last 24 h, LCP and CLS p75, uptime of its checks and the last event. Use it to answer 'how are my sites doing?'.",
    { date_range: z.enum(["today", "7d", "30d"]).optional().describe("Default 7d") },
    async (a) => {
      const all = await listSitesCached(env.DB);
      const sites = all.filter((s) => canAccessSite(principal, s.id) && !s.settings.hidden);
      return sitesSummary(env, sites, all, a.date_range ?? "7d", Date.now(), principal.siteIds === null);
    },
  );
  tool(
    "site_overview",
    "Start here for a site: KPIs (visitors, sessions, pageviews, bounce rate, durations, events) with change vs the previous period, plus top pages, channels, referrers, countries, devices and goal conversions. Default range 28d. With full: true, the whole dashboard view instead: the series of every KPI, top rows of every panel (entry pages, campaigns, browsers, systems, events, outbound links, weekday × hour…), goals with their previous period, and annotations.",
    { ...common, full: z.boolean().optional().describe("Return the full site view (GET /sites/{site}/overview)") },
    async (a) => (a.full ? overview(env.DB, await site(a.site), toCommon(a as CommonArgs)) : summary(env.DB, await site(a.site), toCommon(a as CommonArgs))),
  );

  tool(
    "query",
    `Composable analytics query: metrics × dimensions × filters over a date range, with optional comparison. Metrics: ${METRICS.join(", ")}. Dimensions: ${BASE_DIMENSIONS.join(", ")}, event_prop:<key>. conversions/conversion_rate need goal (goal id or inline match). Max 1000 rows; paginate with cursor.`,
    {
      ...common,
      metrics: z.array(z.enum(METRICS)).min(1),
      dimensions: z.array(z.string()).max(3).optional(),
      order_by: z.tuple([z.string(), z.enum(["asc", "desc"])]).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().optional(),
      goal: z.union([z.string(), goalMatch]).optional(),
      source_counts: z.boolean().optional().describe("Add meta.source_counts: imported (rybbit) vs live rows in the range"),
    },
    async (a) => {
      const s = await site(a.site);
      const q = querySchema.parse({ ...a, site: undefined, date_range: a.date_range ?? "28d", dimensions: a.dimensions ?? [], filters: a.filters ?? [] });
      const r = await runQuery(env.DB, s, q);
      return { meta: r.meta, rows: r.rows, totals: r.totals, comparison: r.comparison, next_cursor: r.next_cursor };
    },
  );

  tool(
    "timeseries",
    "Metric(s) over time (hour/day/week/month) with an optional comparison series. Missing days are filled with zeros.",
    { ...common, metrics: z.array(z.enum(METRICS)).min(1).optional(), interval: z.enum(["hour", "day", "week", "month"]).optional() },
    async (a) => timeseries(env.DB, await site(a.site), { ...toCommon(a as CommonArgs), metrics: (a.metrics as never) ?? ["visitors", "pageviews"], interval: a.interval ?? "day" }),
  );

  tool(
    "breakdown",
    "Top values of one dimension (e.g. page, referrer_host, country, browser, event_name, event_prop:place), sorted by the first metric.",
    { ...common, dimension: z.string(), metrics: z.array(z.enum(METRICS)).min(1).optional(), limit: z.number().int().min(1).max(1000).optional(), search: z.string().max(100).optional().describe("Only values containing this text") },
    async (a) => breakdown(env.DB, await site(a.site), { ...toCommon(a as CommonArgs), dimension: a.dimension, metrics: (a.metrics as never) ?? ["visitors", "pageviews"], limit: a.limit ?? 25, search: a.search }),
  );

  tool("realtime", "Who is on the site now: visitors in the last 5 minutes, the visits of the last 30 minutes (grouped by visit, active ones marked), current pages and sources, hits per minute for the last 30 minutes.", { site: common.site }, async (a) => realtime(env.DB, await site(a.site)));
  tool("ingest_drops", "What Pulse accepted and dropped for a site per day, by reason (bots, hosting/datacenter networks, Do Not Track, wrong host, excluded, rate limited, over the daily cap, invalid). Use it when traffic looks inflated or missing.", { site: common.site, days: z.number().int().min(1).max(90).optional() }, async (a) => {
    const { ingestDays } = await import("../api/sites.ts");
    return ingestDays(env.DB, (await site(a.site)).id, a.days ?? 30);
  });
  tool("what_changed", "What changed on a site on one day (default yesterday) against the same weekday a week before: visitors and their change, and the channel, page and country that drove it, in one sentence. Good for a daily check-in.", { site: common.site, date: z.string().optional().describe("YYYY-MM-DD, default yesterday") }, async (a) => {
    const { planChanges } = await import("../query/changes.ts");
    const { runMerged } = await import("../query/run.ts");
    const p = await planChanges(env.DB, await site(a.site), Date.now(), a.date);
    return p.finish((await runMerged(env.DB, p.plans)).results);
  });
  tool("live", "Who is on all your sites now, in one call: visitors in the last 5 minutes per site, hits per minute per site, the latest visits across sites (site, pages, source, country, device, active now) and visitors by country.", {}, async () => {
    const { liveVisits } = await import("../query/live.ts");
    const sites = (await listSitesCached(env.DB)).filter((s) => canAccessSite(principal, s.id) && !s.settings.hidden);
    return liveVisits(env.DB, sites);
  });

  tool(
    "traffic_sources",
    "Where traffic comes from: channels (including the AI Assistants channel), named sources (Google, Bing, Facebook, LinkedIn, ChatGPT…), referrers and UTM campaigns, with comparison. Also returns the AI-assistant detail (by assistant and landing page).",
    common,
    async (a) => {
      const s = await site(a.site);
      const c = toCommon(a as CommonArgs);
      const compare = c.compare === undefined ? "previous_period" : c.compare;
      const [channels, sources, referrers, campaigns, ai] = await Promise.all([
        breakdown(env.DB, s, { ...c, compare, dimension: "channel", metrics: ["visitors", "sessions", "bounce_rate"], limit: 20 }),
        breakdown(env.DB, s, { ...c, compare, dimension: "source_name", metrics: ["visitors", "sessions"], limit: 25, filters: [...(c.filters ?? []), ["is_not", "source_name", ["(none)"]]] }),
        breakdown(env.DB, s, { ...c, compare, dimension: "referrer_host", metrics: ["visitors", "sessions"], limit: 25, filters: [...(c.filters ?? []), ["is_not", "referrer_host", ["(none)"]]] }),
        breakdown(env.DB, s, { ...c, compare: null, dimension: "utm_campaign", metrics: ["visitors", "sessions"], limit: 25, filters: [...(c.filters ?? []), ["is_not", "utm_campaign", ["(none)"]]] }),
        aiSources(env.DB, s, c),
      ]);
      return { meta: channels.meta, channels: channels.rows, channels_comparison: channels.comparison?.rows ?? null, sources: sources.rows, referrers: referrers.rows, campaigns: campaigns.rows, ai_assistants: ai };
    },
  );

  tool(
    "top_movers",
    "What changed most against the previous period for one dimension and metric: gainers, losers and biggest relative changes. Use to explain a rise or drop.",
    { ...common, dimension: z.string().optional(), metric: z.enum(METRICS).optional(), limit: z.number().int().min(1).max(50).optional() },
    async (a) => movers(env.DB, await site(a.site), { ...toCommon(a as CommonArgs), dimension: a.dimension ?? "page", metric: a.metric ?? "visitors", limit: a.limit }),
  );

  tool("retention", "Weekly cohorts of visitor-days and how many returned the same day (visitor ids rotate daily, so cross-day retention isn't measurable by design).", common, async (a) => retention(env.DB, await site(a.site), toCommon(a as CommonArgs)));

  tool(
    "journeys",
    "The pages people visit after (or before) a given page, as paths up to 5 steps, with counts and shares.",
    { ...common, page: z.string().min(1).describe("The page to start from, e.g. /pricing"), direction: z.enum(["next", "previous"]).optional(), depth: z.number().int().min(1).max(5).optional() },
    async (a) => paths(env.DB, await site(a.site), { ...toCommon(a as CommonArgs), from: a.page, direction: a.direction ?? "next", depth: a.depth ?? 3 }),
  );

  tool(
    "page_report",
    "Everything about one path: views, visitors, entries, exits, exit rate, engaged time, scroll depth, channels, devices, next/previous pages and Core Web Vitals p75.",
    { ...common, path: z.string().min(1) },
    async (a) => pageReport(env.DB, await site(a.site), { ...toCommon(a as CommonArgs), path: a.path }),
  );

  tool("web_vitals", "Core Web Vitals: p75 of LCP, INP and CLS with good / needs-improvement / poor shares, per page or device.", { ...common, dimension: z.enum(["page", "device", "page,device"]).optional() }, async (a) =>
    vitals(env.DB, await site(a.site), { ...toCommon(a as CommonArgs), dimension: a.dimension }),
  );

  tool("errors", "Grouped JavaScript errors (only when error tracking is enabled for the site).", common, async (a) => errorsReport(env.DB, await site(a.site), toCommon(a as CommonArgs)));

  // ---------- Goals and funnels ----------
  tool("goals", "List the site's goals with conversions and conversion rate for the range (with comparison).", common, async (a) => {
    const s = await site(a.site);
    const c = toCommon(a as CommonArgs);
    const { results } = await env.DB.prepare("SELECT id, name, kind, definition_json FROM goals WHERE site_id = ? ORDER BY name").bind(s.id).all<{ id: string; name: string; kind: string; definition_json: string }>();
    const goals = await Promise.all(
      results.map(async (g) => {
        const r = await runQuery(env.DB, s, querySchema.parse({ ...c, metrics: ["conversions", "conversion_rate"], goal: g.id, compare: c.compare === undefined ? "previous_period" : c.compare }));
        return { id: g.id, name: g.name, match: { kind: g.kind, ...JSON.parse(g.definition_json) }, conversions: r.totals.conversions, conversion_rate: r.totals.conversion_rate, previous: r.comparison?.totals ?? null };
      }),
    );
    return { meta: { site: s.id, date_range: resolveRange(c.date_range ?? "28d", s.timezone) }, goals };
  });

  tool(
    "save_goal",
    'Create a goal (omit id) or edit one (pass id). match: {kind:"pageview", path:"/thanks"} (* wildcards), {kind:"event", event:"signup", prop?:{key,value}} or {kind:"outbound", host:"wa.me"}.',
    { site: z.string(), id: z.string().optional(), name: z.string().optional(), match: goalMatch.optional() },
    async (a) => ({ goal: await saveGoal(env.DB, (await site(a.site)).id, principal.label, a) }),
    { readOnly: false, idempotent: true },
  );

  tool("delete_goal", "Delete a goal.", { site: z.string(), id: z.string() }, async (a) => {
    await deleteGoal(env.DB, (await site(a.site)).id, principal.label, a.id);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  const step = z.object({ name: z.string().optional(), match: goalMatch });
  tool(
    "funnel",
    "Funnel analysis within one session: a saved funnel (funnel_id) or ad-hoc steps (2–8). Returns sessions per step, conversion, drop-off and median time between steps; with compare, the same steps in the comparison period; with breakdown (channel, device, country, browser, os, referrer_host, utm_source, utm_medium, utm_campaign, utm_content, entry_page), sessions per step for each value. step_order strict means no other pageview between steps. Page paths accept * wildcards. With neither funnel_id nor steps, lists the saved funnels.",
    { ...common, funnel_id: z.string().optional(), steps: z.array(step).min(2).max(8).optional(), window_minutes: z.number().int().min(1).max(1440).optional(), step_order: z.enum(["flexible", "strict"]).optional(), breakdown: z.enum(FUNNEL_BREAKDOWNS).optional() },
    async (a) => {
      const s = await site(a.site);
      let steps = a.steps as FunnelSteps | undefined;
      let window = a.window_minutes ?? 30;
      let order = a.step_order ?? "flexible";
      let name: string | null = null;
      if (a.funnel_id) {
        const f = await getFunnel(env.DB, s.id, a.funnel_id);
        if (!f) throw new McpToolError("not_found", "funnel not found", "Call funnel {site} without steps to list saved funnels.");
        steps = f.steps as FunnelSteps;
        window = f.window_minutes;
        order = a.step_order ?? f.step_order;
        name = f.name;
      }
      if (!steps) return { saved_funnels: await listFunnels(env.DB, s.id), hint: "Pass funnel_id to analyze one, or steps for an ad-hoc funnel." };
      return { funnel: name, ...(await funnel(env.DB, s, { ...toCommon(a as CommonArgs), steps, window_minutes: window, step_order: order, breakdown: a.breakdown })) };
    },
  );

  tool(
    "save_funnel",
    "Create a saved funnel (omit id) or edit one (pass id). steps: 2–8 of {name?, match} with the same match shapes as goals; window_minutes default 30; step_order flexible (default) or strict (no other pageview between steps).",
    { site: z.string(), id: z.string().optional(), name: z.string().optional(), steps: z.array(step).min(2).max(8).optional(), window_minutes: z.number().int().min(1).max(1440).optional(), step_order: z.enum(["flexible", "strict"]).optional() },
    async (a) => ({ funnel: await saveFunnel(env.DB, (await site(a.site)).id, principal.label, a) }),
    { readOnly: false, idempotent: true },
  );

  tool("delete_funnel", "Delete a saved funnel.", { site: z.string(), id: z.string() }, async (a) => {
    await deleteFunnel(env.DB, (await site(a.site)).id, principal.label, a.id);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  // ---------- Annotations ----------
  tool(
    "list_annotations",
    "Change markers (deploys, SEO changes, campaigns) for a site, including all-site annotations. Use them to explain changes in traffic.",
    { site: common.site, date_range: dateRange },
    async (a) => {
      const s = await site(a.site);
      const r = resolveRange(a.date_range ?? "90d", s.timezone, Date.now(), "2000-01-01");
      const { results } = await env.DB.prepare("SELECT * FROM annotations WHERE (site_id = ? OR site_id IS NULL) AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 500")
        .bind(s.id, Date.parse(`${r.from}T00:00:00Z`) - 86_400_000, Date.parse(`${r.to}T00:00:00Z`) + 2 * 86_400_000)
        .all<AnnotationRow & { created_by: string }>();
      return { annotations: results.map(annotationView) };
    },
  );

  const annotationSite = async (id: string | undefined): Promise<string | null> => {
    if (id === "*") {
      if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys cannot use site=*");
      return null;
    }
    return (await site(id)).id;
  };

  tool(
    "add_annotation",
    'Add a change marker to a site\'s charts, e.g. after merging an SEO change or a deploy. site "*" marks all sites.',
    { site: common.site, title: z.string().min(1).max(200), body: z.string().max(2000).optional(), url: z.string().url().optional(), ts: z.string().optional().describe("ISO-8601; default now"), category: z.enum(ANNOTATION_CATEGORIES).optional().describe("Shown as a distinct mark on the chart"), affects: z.array(z.enum(METRICS)).optional().describe('Data-quality marker (category "data"): metrics whose definition or source changed here; reports leave out their change across it') },
    async (a) => {
      const siteId = await annotationSite(a.site);
      const id = ulid();
      const ts = a.ts ? Date.parse(a.ts) : Date.now();
      if (Number.isNaN(ts)) throw new McpToolError("invalid_ts", "ts must be ISO-8601");
      await env.DB.prepare("INSERT INTO annotations (id, site_id, ts, title, body, url, category, affects, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, siteId, ts, a.title, a.body ?? null, a.url ?? null, a.category ?? null, a.affects?.length ? JSON.stringify(a.affects) : null, principal.label, Date.now()).run();
      await audit(env.DB, principal.label, "annotation.create", `${siteId ?? "*"}/${id}`);
      return { id, site: siteId ?? "*", ts: new Date(ts).toISOString(), title: a.title, body: a.body ?? null, url: a.url ?? null, category: a.category ?? null, affects: a.affects ?? [] };
    },
    { readOnly: false },
  );

  tool("delete_annotation", 'Delete a change marker (site "*" for an all-sites one).', { site: z.string(), id: z.string() }, async (a) => {
    await deleteAnnotation(env.DB, await annotationSite(a.site), principal.label, a.id);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  tool(
    "export_events",
    "Raw event rows (max 5000 per call; page with after_ts/after_id from the last row).",
    { site: common.site, from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), type: z.string().optional(), limit: z.number().int().min(1).max(5000).optional(), after_ts: z.number().optional(), after_id: z.string().optional() },
    async (a) => {
      const s = await site(a.site);
      const rows = await exportRows(env.DB, s.id, { from: a.from, to: a.to, type: a.type, limit: a.limit ?? 1000, after: a.after_ts !== undefined ? { ts: a.after_ts, id: a.after_id ?? "" } : undefined });
      const last = rows[rows.length - 1];
      return { rows, count: rows.length, next: rows.length === (a.limit ?? 1000) && last ? { after_ts: last.ts, after_id: last.id } : null };
    },
  );

  // ---------- Status ----------
  const visibleCheck = (siteId: string | null) => canTouchMonitor(principal, siteId);
  tool("status", "Status board: every check's state (up, down, degraded, paused), uptime for 24 h / 7 d / 30 d / 90 d, median response time, open incidents, database sizes and backups. Starts with a one-line summary.", {}, async () => {
    const r = await statusReport(env);
    const monitors = r.monitors.filter((m) => visibleCheck(m.site_id)).map(({ days: _days, ...m }) => m);
    return { ...r, monitors, incidents: r.incidents.filter((i) => visibleCheck(i.site_id)), ...(principal.siteIds !== null ? { databases: [], backups: null } : {}) };
  });

  tool(
    "list_checks",
    "Status checks with their configuration. Pass id for one check plus its recent results (hours, default 24).",
    { id: z.string().optional(), hours: z.number().int().min(1).max(2160).optional() },
    async (a) => {
      if (!a.id) return { checks: (await listMonitors(env)).filter((m) => visibleCheck(m.site_id)), kinds: MONITOR_KINDS, intervals: INTERVALS };
      const m = await getMonitor(env.DB, a.id);
      if (!m || !visibleCheck(m.site_id)) throw new McpToolError("not_found", "check not found", "Call list_checks without id.");
      const { results } = await env.DB.prepare("SELECT ts, ok, status, ms, error FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 500")
        .bind(m.id, Date.now() - (a.hours ?? 24) * 3_600_000)
        .all<{ ts: number; ok: number; status: number | null; ms: number | null; error: string | null }>();
      return { check: monitorView(env, m), results: results.map((x) => ({ ...x, ok: !!x.ok, ts: new Date(x.ts).toISOString() })) };
    },
  );

  const checkFields = {
    name: z.string().optional(),
    kind: z.enum(MONITOR_KINDS).optional().describe("http, json, heartbeat, d1_query, pulse_ingest, dns, domain_expiry (json_nonempty is legacy). help {topic:'status_checks'} has examples."),
    url: z.string().optional().describe("http/json: https URL, or self:/path for a Pulse URL"),
    site_id: z.string().nullable().optional().describe("Group under a site on the status page"),
    interval_min: z.number().int().optional().describe(`One of ${INTERVALS.join(", ")}`),
    timeout_ms: z.number().int().optional(),
    failures_to_alert: z.number().int().optional(),
    degraded_ms: z.number().int().nullable().optional(),
    notify: z.boolean().optional(),
    channel_ids: z.array(z.string()).nullable().optional().describe("Notification channels for this check; null = all (list_channels)"),
    config: z.record(z.string(), z.unknown()).optional().describe("Kind-specific settings (merged when editing)"),
    quiet_hours: z.object({ from: z.string(), to: z.string(), tz: z.string().optional() }).nullable().optional().describe('Daily window when failures open no incident, e.g. {from:"01:00", to:"07:00", tz:"Europe/Madrid"} for a nightly lull; null removes it'),
  };
  tool(
    "save_check",
    "Add a status check (omit id, or pass a new id) or edit one (pass an existing id). Heartbeat checks return heartbeat_url once: call it from the job. Set new_ping_url to issue a new heartbeat URL. Try a configuration first with run_check.",
    { id: z.string().optional(), ...checkFields, new_ping_url: z.boolean().optional() },
    async (a) => {
      const { id, new_ping_url, ...input } = a;
      const existing = id ? await getMonitor(env.DB, id) : null;
      if (existing) {
        if (!visibleCheck(existing.site_id)) throw new McpToolError("not_found", "check not found");
        if (new_ping_url) {
          const cfg = JSON.parse(existing.config_json) as Record<string, unknown>;
          delete cfg.token_hash;
          await env.DB.prepare("UPDATE monitors SET config_json = ? WHERE id = ?").bind(JSON.stringify(cfg), existing.id).run();
        }
        return { check: await updateMonitor(env, principal, existing.id, input as never) };
      }
      if (!input.name) throw new McpToolError("invalid_request", "name is required to add a check");
      return { check: await createMonitor(env, principal, { ...input, ...(id ? { id } : {}) } as never) };
    },
    { readOnly: false, idempotent: true },
  );

  tool("delete_check", "Delete a status check and its history.", { id: z.string() }, async (a) => {
    const m = await getMonitor(env.DB, a.id);
    if (!m || !visibleCheck(m.site_id)) throw new McpToolError("not_found", "check not found");
    await deleteMonitor(env, principal, a.id);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  tool(
    "run_check",
    "Run a saved check now (id; record=true stores the result and can open/resolve an incident), or dry-run an unsaved configuration (kind, url, config…) without an id.",
    { id: z.string().optional(), record: z.boolean().optional(), ...checkFields },
    async (a) => {
      if (a.id) {
        const m = await getMonitor(env.DB, a.id);
        if (!m || !visibleCheck(m.site_id)) throw new McpToolError("not_found", "check not found");
        if (m.kind === "d1_query" && !hasScope(principal, "admin")) throw new McpToolError("insufficient_scope", "database query checks require scope admin");
        return runMonitorNow(env, a.id, !!a.record);
      }
      const { id: _id, record: _record, ...input } = a;
      return testMonitor(env, principal, input as never);
    },
    { readOnly: false },
  );

  tool(
    "pause_check",
    "Pause a check for maintenance (minutes, or until an ISO time), or resume it (resume=true).",
    { id: z.string(), minutes: z.number().int().min(1).max(525_600).optional(), until: z.string().optional(), resume: z.boolean().optional() },
    async (a) => {
      const m = await getMonitor(env.DB, a.id);
      if (!m || !visibleCheck(m.site_id)) throw new McpToolError("not_found", "check not found");
      return pauseMonitor(env, principal, a.id, a.resume ? {} : { minutes: a.minutes ?? null, until: a.until ?? null });
    },
    { readOnly: false, idempotent: true },
  );

  tool(
    "list_incidents",
    "Incidents, newest first (status open or all), optionally for one check (monitor id from list_checks). Default limit 20.",
    { status: z.enum(["open", "all"]).optional(), monitor: z.string().max(64).optional(), limit: z.number().int().min(1).max(500).optional() },
    async (a) => ({
      incidents: (await listIncidents(env, a.status ?? "all", a.limit ?? 20, a.monitor)).filter((i) => visibleCheck((i.site_id as string | null) ?? null)),
    }),
  );

  tool(
    "update_incident",
    "Add a note to, acknowledge or close an incident.",
    { id: z.string(), note: z.string().max(2000).nullable().optional(), acknowledged: z.boolean().optional(), resolved: z.literal(true).optional() },
    async (a) => {
      const { id, ...b } = a;
      return { incident: await updateIncidentRecord(env, principal, id, b) };
    },
    { readOnly: false, idempotent: true },
  );

  tool("ops_settings", "Ops settings: which D1 databases are backed up weekly and restored in the monthly drill, and the D1 size warning. Scheduled reports (the weekly digest) are list_reports / save_report.", {}, async () => getOpsSettings(env.DB));

  tool(
    "update_ops_settings",
    "Change ops settings (merged): backup_databases, drill_databases (changing either needs scope admin), d1_warn_gb, email_only_errors (true = email only for new JavaScript errors and failed backups). The digest schedule is a report now: save_report.",
    {
      backup_databases: z.array(z.string()).optional(),
      drill_databases: z.array(z.string()).optional(),
      d1_warn_gb: z.number().optional(),
      email_only_errors: z.boolean().optional(),
    },
    async (a) => {
      if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys can't change instance settings");
      return updateOpsSettings(env, principal, a);
    },
    { readOnly: false, idempotent: true },
  );

  tool("list_databases", "D1 databases in the Cloudflare account (names and sizes), for backups and database checks.", {}, async () => {
    const { listD1 } = await import("../ops/cfapi.ts");
    const dbs = await listD1(env);
    return { databases: dbs.map((d) => ({ name: d.name, size_mb: d.file_size ? Math.round((d.file_size / 1048576) * 10) / 10 : null })) };
  });

  tool(
    "run_ops_job",
    "Run an ops job now: monitors (all checks), db_sizes, ops_backup, restore_drill, digest (sends the weekly-digest report now), pulse_backup, retention.",
    { job: z.enum(["monitors", "db_sizes", "ops_backup", "restore_drill", "digest", "pulse_backup", "retention"]) },
    async (a) => {
      const mon = await import("../ops/monitor.ts");
      const bk = await import("../ops/backups.ts");
      const cron = await import("../cron/jobs.ts");
      const run: Record<string, () => Promise<unknown>> = {
        monitors: () => mon.runMonitors(env),
        db_sizes: () => mon.recordDbSizes(env),
        ops_backup: () => bk.backupDatabases(env),
        restore_drill: () => bk.restoreDrill(env),
        digest: async () => {
          const rep = await import("../ops/reports.ts");
          const d = await rep.sendReport(env, rep.reportView(await rep.getReport(env.DB, "weekly-digest")));
          return { delivered: d.delivered, subject: d.subject };
        },
        pulse_backup: () => cron.backup(env),
        retention: () => cron.retention(env),
      };
      await audit(env.DB, principal.label, "ops.run", a.job);
      return { job: a.job, result: (await run[a.job]!()) ?? "done" };
    },
    { readOnly: false },
  );

  // ---------- Admin ----------
  tool("list_keys", "API keys: name, prefix, scopes, sites, last use, expiry and status (never the secret).", { status: z.enum(["active", "revoked", "all"]).optional() }, async (a) => ({ keys: await listKeys(env.DB, a.status ?? "active", principal) }));

  tool(
    "update_key",
    "Rename a key or change its scopes, sites (null = all, including future sites) or expiry (ISO or null). Applies on the key's next request. Creating and rotating keys stay in the dashboard and REST: a key is a credential, and an agent reading analytics data must not be able to mint one.",
    { id: z.string(), name: z.string().optional(), scopes: z.array(z.enum(SCOPES)).optional(), site_ids: z.array(z.string()).nullable().optional(), expires_at: z.string().nullable().optional() },
    async (a) => {
      const { id, ...b } = a;
      return { key: await updateKey(env.DB, principal, id, b) };
    },
    { readOnly: false, idempotent: true },
  );

  tool("revoke_key", "Revoke an API key (it stops working immediately).", { id: z.string() }, async (a) => {
    await revokeKey(env.DB, principal, a.id);
    return { revoked: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  tool("list_users", "People with access: email, role (owner, admin, viewer), site access, disabled.", {}, async () => {
    if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys can't manage people");
    return { users: await listUsers(env.DB) };
  });

  tool(
    "add_user",
    "Give someone access to the dashboard: they sign in with a one-time code sent to this email (the Cloudflare Access policy must let the address request one). role viewer (default; site_ids limits their sites), admin or owner (owners only).",
    { email: z.string().email(), name: z.string().max(120).nullable().optional(), role: z.enum(["owner", "admin", "viewer"]).optional(), site_ids: z.array(z.string()).min(1).nullable().optional() },
    async (a) => ({ user: await createUser(env.DB, principal, a) }),
    { readOnly: false, idempotent: false },
  );

  tool(
    "update_user",
    "Change a person's name, role or site access (viewers; null = all), or disable/enable them. Owners can only be changed by owners.",
    { id: z.string(), name: z.string().nullable().optional(), role: z.enum(["owner", "admin", "viewer"]).optional(), site_ids: z.array(z.string()).nullable().optional(), disabled: z.boolean().optional() },
    async (a) => {
      const { id, disabled, ...b } = a;
      if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys can't manage people");
      if (disabled !== undefined) await (disabled ? disableUser(env.DB, principal, id) : enableUser(env.DB, principal, id));
      return { user: Object.keys(b).length ? await updateUser(env.DB, principal, id, b) : (await listUsers(env.DB)).find((u) => u.id === id) };
    },
    { readOnly: false, idempotent: true },
  );

  tool("list_imports", "History of data imports from other analytics tools: site, source, date range, rows and status.", { limit: z.number().int().min(1).max(100).optional() }, async (a) => {
    const { results } = await env.DB.prepare("SELECT * FROM imports ORDER BY created_at DESC LIMIT ?").bind(a.limit ?? 50).all<Record<string, unknown>>();
    return { imports: results.filter((i) => canAccessSite(principal, String(i.site_id))) };
  });

  tool(
    "delete_data",
    "Delete a site's raw events and sessions in a date range, or only the sessions matching filters (spam referrers, test visits). First call it with dry_run: true to get the counts and a confirm_token, show the counts to the user, then call again with that confirm_token. D1 Time Travel (30 days) is the only undo.",
    { site: z.string(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), filters: common.filters, dry_run: z.boolean().optional(), confirm_token: z.string().optional() },
    async (a) => {
      const { site: sid, ...b } = a;
      return deleteData(env.DB, await site(sid), principal.label, b as never, { requireToken: true });
    },
    { readOnly: false, destructive: true },
  );

  tool("audit_log", "Who changed what, newest first. action filters by prefix, e.g. key. or site.", { action: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, async (a) => {
    const { results } = await env.DB.prepare(a.action ? "SELECT * FROM audit_log WHERE action LIKE ? ORDER BY ts DESC LIMIT ?" : "SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?")
      .bind(...(a.action ? [`${a.action.replace(/[%_]/g, "")}%`, a.limit ?? 100] : [a.limit ?? 100]))
      .all<{ ts: number }>();
    return { entries: results.map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })) };
  });

  tool("health", "System health: ingest lag, last event per site, queue dead letters, database size, backups, version.", {}, async () => health(env));

  // ---------- Explorers ----------
  tool("event_properties", "Custom event property keys seen in the range (optionally for one event), with counts. Break events down by one with breakdown {dimension: \"event_prop:<key>\"}.", { ...common, event: z.string().optional() }, async (a) =>
    propertyKeys(env.DB, await site(a.site), { ...toCommon(a as CommonArgs), event: a.event }),
  );

  tool(
    "sessions",
    "Anonymous sessions (same-day only by design): without id, recent sessions matching the filters with entry, exit, pages, duration, source, device and country; with id, that session's hits in order.",
    { ...common, id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), before: z.number().optional().describe("next_before from the previous page") },
    async (a) => {
      const s = await site(a.site);
      if (a.id) {
        const d = await sessionDetail(env.DB, s, a.id);
        if (!d) throw new McpToolError("not_found", "session not found");
        return d;
      }
      return listSessions(env.DB, s, { ...toCommon(a as CommonArgs), limit: a.limit, before: a.before });
    },
  );

  tool("insights", "What stands out in a range: traffic swings, rising and falling pages, new referrers, slower pages, goal changes, each with its numbers. A good first call after site_overview.", common, async (a) => insights(env.DB, await site(a.site), toCommon(a as CommonArgs)));

  // ---------- Saved views ----------
  tool("list_views", "Saved views (named filter sets) for a site. Apply one by passing its filters to any stats tool.", { site: common.site }, async (a) => ({ views: await listViews(env.DB, (await site(a.site)).id) }));
  tool(
    "save_view",
    "Save a view (omit id) or edit one (id): a name, filters, optional date_range (preset or \"YYYY-MM-DD,YYYY-MM-DD\"), compare and pinned.",
    { site: z.string(), id: z.string().optional(), name: z.string().optional(), filters, date_range: z.string().nullable().optional(), compare: z.string().max(40).nullable().optional().describe("previous_period, previous_year, none, or \"YYYY-MM-DD,YYYY-MM-DD\""), pinned: z.boolean().optional() },
    async (a) => ({ view: await saveView(env.DB, (await site(a.site)).id, principal.label, a as never) }),
    { readOnly: false, idempotent: true },
  );
  tool("delete_view", "Delete a saved view.", { site: z.string(), id: z.string() }, async (a) => {
    await deleteView(env.DB, (await site(a.site)).id, principal.label, a.id);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  tool("list_shares", "Read-only public share links for a site (names, password yes/no, expiry, last use; never the token).", { site: z.string() }, async (a) => ({ shares: await listShares(env.DB, (await site(a.site)).id) }));
  tool(
    "create_share",
    "Create a read-only public link to a site's reports, optionally with a password, an expiry, a saved view whose filters always apply (view_id from list_views) and https origins allowed to embed it. The URL is returned only now: anyone with it can read the site's stats, so hand it only to whoever asked for it.",
    { site: z.string(), name: z.string().min(1).max(80), password: z.string().min(6).max(200).optional(), expires_in_days: z.number().int().min(1).max(3650).optional(), view_id: z.string().optional(), embed_origins: z.array(z.string()).max(10).optional() },
    async (a) => {
      const { site: sid, ...b } = a;
      return { share: await createShare(env, (await site(sid)).id, principal.label, b) };
    },
    { readOnly: false },
  );
  tool("revoke_share", "Revoke a share link (it stops working immediately).", { site: z.string(), id: z.string() }, async (a) => {
    await revokeShare(env.DB, (await site(a.site)).id, principal.label, a.id);
    return { revoked: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  // ---------- Tracked links ----------
  tool("list_links", "Tracked short links for a site (<origin>/l/<slug>) with their click counts.", { site: common.site }, async (a) => ({ links: await listLinks(env.DB, await site(a.site), env.PUBLIC_ORIGIN) }));
  tool(
    "save_link",
    "Create a short link that records a link_click event (props slug, campaign) and redirects to target. Use it for newsletters, QR codes and social bios.",
    { site: z.string(), target: z.string().url(), slug: z.string().optional(), campaign: z.string().optional() },
    async (a) => ({ link: await saveLink(env.DB, (await site(a.site)).id, principal.label, { target: a.target, slug: a.slug, campaign: a.campaign }, env.PUBLIC_ORIGIN) }),
    { readOnly: false },
  );
  tool("delete_link", "Delete a short link.", { site: z.string(), slug: z.string() }, async (a) => {
    await deleteLink(env.DB, (await site(a.site)).id, principal.label, a.slug);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  // ---------- Alerts ----------
  tool("list_alerts", "Traffic alert rules for a site with their last value, plus recent firings and the available kinds.", { site: common.site }, async (a) => {
    const s = await site(a.site);
    return { alerts: await listAlerts(env.DB, s.id), history: await alertHistory(env.DB, s.id, 30), kinds: ALERT_INFO };
  });
  tool("test_alert", "Evaluate an alert rule now without sending anything: its current value and whether it would fire.", { site: z.string(), id: z.string() }, async (a) => {
    const s = await site(a.site);
    const row = await env.DB.prepare("SELECT * FROM alert_rules WHERE id = ? AND site_id = ?").bind(a.id, s.id).first<AlertRow>();
    if (!row) throw new McpToolError("not_found", "alert not found", "Call list_alerts.");
    return evaluateRule(env.DB, s, row);
  });
  tool(
    "save_alert",
    `Create an alert (omit id) or edit one (id). kind: ${Object.entries(ALERT_INFO).map(([k, v]) => `${k} (${v})`).join("; ")}. window_min 15–2880; cooldown_min between alerts; channel_ids null = every channel.`,
    {
      site: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      kind: z.enum(ALERT_KINDS).optional(),
      metric: z.enum(METRICS).optional(),
      event_name: z.string().nullable().optional(),
      filters,
      window_min: z.number().int().optional(),
      threshold: z.number().optional(),
      cooldown_min: z.number().int().optional(),
      channel_ids: z.array(z.string()).nullable().optional(),
      enabled: z.boolean().optional(),
    },
    async (a) => {
      const { site: sid, ...b } = a;
      return { alert: await saveAlert(env.DB, (await site(sid)).id, principal.label, b as never) };
    },
    { readOnly: false, idempotent: true },
  );
  tool("delete_alert", "Delete an alert rule.", { site: z.string(), id: z.string() }, async (a) => {
    await deleteAlert(env.DB, (await site(a.site)).id, principal.label, a.id);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  tool("update_annotation", 'Edit a change marker: title, body, url, ts (ISO), category (deploy, content, campaign, incident, data, other), affects (metrics not comparable across it). site "*" for an all-sites one.', { site: z.string(), id: z.string(), title: z.string().max(200).optional(), body: z.string().max(2000).nullable().optional().describe("null clears it"), url: z.string().url().nullable().optional().describe("null clears it"), ts: z.string().optional(), category: z.enum(ANNOTATION_CATEGORIES).optional(), affects: z.array(z.enum(METRICS)).nullable().optional().describe("null clears it") }, async (a) => {
    const { site: sid, id, ...b } = a;
    return { annotation: await updateAnnotation(env.DB, await annotationSite(sid), principal.label, id, b) };
  }, { readOnly: false, idempotent: true });

  // ---------- Notification channels, connected apps ----------
  tool("list_channels", "Notification channels where incident and traffic alerts go (kind, name, a safe preview of the target, last error; never the URL or token).", {}, async () => ({ channels: await listChannels(env.DB), kinds: CHANNEL_INFO, secret_key_configured: !!env.PULSE_SECRET_KEY }));
  tool(
    "save_channel",
    "Add a notification channel (no id) or rename, enable/disable or repoint one (id). config by kind: webhook/slack/discord {url}; telegram {bot_token, chat_id}; ntfy {url, token?}; email {} (goes to ALERT_EMAIL). URLs and tokens are stored encrypted and never shown again; a new webhook returns its signing_secret once. Anything but email needs the PULSE_SECRET_KEY Worker secret.",
    { id: z.string().optional(), name: z.string().min(1).max(80).optional(), kind: z.enum(CHANNEL_KINDS).optional(), config: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional() },
    async (a) => {
      if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys can't change channels");
      if (a.id) {
        const ch = await updateChannel(env, a.id, { name: a.name, enabled: a.enabled, config: a.config });
        await audit(env.DB, principal.label, "channel.update", a.id);
        return { channel: ch };
      }
      if (!a.name || !a.kind) throw new McpToolError("invalid_request", "name and kind are required to add a channel");
      const out = await createChannel(env, { name: a.name, kind: a.kind, config: a.config ?? {}, enabled: a.enabled });
      await audit(env.DB, principal.label, "channel.create", out.channel.id, { kind: out.channel.kind });
      return out;
    },
    { readOnly: false },
  );
  tool("delete_channel", "Delete a notification channel.", { id: z.string() }, async (a) => {
    if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys can't change channels");
    await deleteChannel(env, a.id);
    await audit(env.DB, principal.label, "channel.delete", a.id);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });
  tool("test_channel", "Send a test message to a notification channel.", { id: z.string() }, async (a) => {
    if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys can't use channels");
    return testChannel(env, a.id);
  }, { readOnly: false });
  const reportVisible = async (id: string) => {
    const rep = reportFor(reportView(await getReport(env.DB, id)), principal.siteIds);
    if (!rep) throw new McpToolError("not_found", "report not found");
    return rep;
  };
  const instanceOnly = () => {
    if (principal.siteIds !== null) throw new McpToolError("forbidden", "site-scoped keys can't change or send reports");
  };
  tool("list_reports", "Scheduled reports: weekly or monthly summaries of chosen sites sent to notification channels (the weekly digest is one), with schedule, sections and last send.", {}, async () => ({ reports: await listReports(env.DB, principal.siteIds), sections: REPORT_SECTIONS }));
  tool(
    "save_report",
    "Create a scheduled report (omit id) or edit one (id). Fields: name; site_ids (null = every site with include_in_digest); frequency weekly|monthly; weekday 0–6 (0 = Sunday) or day_of_month 1–28; hour 0–23; timezone (IANA); sections from kpis, pages, sources, ai, goals, movers; include_ops (status checks, backups, database sizes); channel_ids (null = every enabled channel); enabled.",
    {
      id: z.string().optional(),
      name: z.string().optional(),
      site_ids: z.array(z.string()).nullable().optional(),
      frequency: z.enum(["weekly", "monthly"]).optional(),
      weekday: z.number().int().min(0).max(6).optional(),
      day_of_month: z.number().int().min(1).max(28).optional(),
      hour: z.number().int().min(0).max(23).optional(),
      timezone: z.string().optional(),
      sections: z.array(z.enum(REPORT_SECTIONS)).optional(),
      include_ops: z.boolean().optional(),
      channel_ids: z.array(z.string()).nullable().optional(),
      enabled: z.boolean().optional(),
    },
    async ({ id, ...a }) => {
      instanceOnly();
      const out = id ? await updateReport(env.DB, id, a) : await createReport(env.DB, principal.label, a);
      await audit(env.DB, principal.label, id ? "report.update" : "report.create", out.id);
      return out;
    },
    { readOnly: false },
  );
  tool("delete_report", "Delete a scheduled report.", { id: z.string() }, async (a) => {
    instanceOnly();
    await deleteReport(env.DB, a.id);
    await audit(env.DB, principal.label, "report.delete", a.id);
    return { deleted: true };
  }, { readOnly: false, destructive: true, idempotent: true });
  tool("preview_report", "Build a report for its last complete period without sending it: subject, plain text and the numbers.", { id: z.string() }, async (a) => {
    const { html: _html, ...rest } = await buildReport(env, await reportVisible(a.id));
    return rest;
  });
  tool("send_report", "Send a report now through its channels.", { id: z.string() }, async (a) => {
    instanceOnly();
    const out = await sendReport(env, await reportVisible(a.id));
    await audit(env.DB, principal.label, "report.send", a.id);
    return { delivered: out.delivered, subject: out.subject, range: out.range };
  }, { readOnly: false });
  tool("list_connected_apps", "Apps connected through OAuth (claude.ai, Claude Desktop): who connected them and their scopes.", {}, async () => ({ apps: await listConnectedApps(env, principal) }));
  tool("revoke_connected_app", "Disconnect an OAuth app (pass id and user_id from list_connected_apps).", { id: z.string(), user_id: z.string() }, async (a) => {
    await revokeConnectedApp(env, principal, a.id, a.user_id);
    return { revoked: true };
  }, { readOnly: false, destructive: true, idempotent: true });

  // ---------- Resources and prompts ----------
  server.registerResource("sites", "pulse://sites", { title: "Sites", mimeType: "application/json" }, async (uri) => {
    const sites = (await listSitesCached(env.DB)).filter((s) => canAccessSite(principal, s.id));
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(sites.map((s) => ({ id: s.id, name: s.name, domains: s.domains, timezone: s.timezone }))) }] };
  });
  server.registerResource("schema", "pulse://schema", { title: "Metrics and dimensions", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SCHEMA_DOC }] }));
  server.registerResource("guide", "pulse://guide", { title: "Pulse guide for agents", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: fullGuide(env.PUBLIC_ORIGIN) }] }));
  server.registerResource(
    "site-settings",
    new ResourceTemplate("pulse://site/{id}/settings", { list: undefined }),
    { title: "Site settings", mimeType: "application/json" },
    async (uri, vars) => {
      const s = await site(String(vars.id));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(s) }] };
    },
  );

  const prompt = (name: string, description: string, argsSchema: z.ZodRawShape, text: (a: Record<string, string | undefined>) => string) =>
    server.registerPrompt(name, { description, argsSchema }, ((a: Record<string, string | undefined>) => ({ messages: [{ role: "user", content: { type: "text", text: text(a) } }] })) as never);

  prompt("weekly_report", "Write a weekly analytics report for a site", { site: z.string(), week: z.string().optional().describe("Monday YYYY-MM-DD; default last full week") }, ({ site: s, week }) =>
    `Write a concise weekly analytics report for site "${s}"${week ? ` for the week starting ${week}` : " for the last full week"}. Use site_overview (with date_range as that week and compare previous_period), traffic_sources (note the AI Assistants channel), top_movers for page and referrer_host, goals, and list_annotations to explain changes. Lead with the 3 most important findings, then numbers, then suggested actions.`,
  );
  prompt("investigate_change", "Investigate why a metric changed on a date", { site: z.string(), metric: z.string(), date: z.string() }, ({ site: s, metric, date }) =>
    `On site "${s}", investigate the change in ${metric} around ${date}. Compare the 7 days after with the 7 days before using timeseries and top_movers across page, channel, referrer_host, country and device. Check list_annotations near the date and status for incidents. Report the most likely cause with supporting numbers, and what would confirm it.`,
  );
  prompt("setup_site", "Add a new site end to end: create it, install the tracker, verify, add a goal and a check", { domain: z.string() }, ({ domain }) =>
    `Set up Pulse analytics for ${domain}. 1) save_site {domains:["${domain}"]} (add www. if the site uses it). 2) Read help {topic:"tracker"} and add the returned snippet to the site's <head> in its codebase (and pulse("…") calls for its key actions). 3) After it's deployed, call install_check until status is "receiving" and fix any findings. 4) save_goal for the main conversion. 5) save_check for the home page (kind http) and any API it depends on. Report what you did and anything that needs a person to do.`,
  );
  prompt("site_health", "Check a site's health: traffic, tracking, uptime, vitals, errors", { site: z.string() }, ({ site: s }) =>
    `Give a health check for site "${s}": install_check (is data arriving, anything dropped?), status (its checks and incidents), site_overview for 7d vs previous period, web_vitals (anything poor?), errors (new or frequent). List problems first, each with a concrete fix.`,
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. */
export async function handleMcp(req: Request, env: Env, principal: Principal): Promise<Response> {
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST" },
    });
  }
  const sites = (await listSitesCached(env.DB)).filter((s) => canAccessSite(principal, s.id) && !s.settings.hidden);
  const server = buildMcpServer(env, principal, sites);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  void server.close();
  return res;
}

/** Every tool name in the catalog (for tests and docs). */
export const CATALOG_TOOLS = CAPABILITIES.filter((c) => c.mcp).map((c) => c.mcp!);

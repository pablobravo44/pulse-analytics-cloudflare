// The capability catalog: everything Pulse can do, with the scope it needs, its REST operations, its MCP tool
// (or why there is none) and where it lives in the dashboard. MCP instructions, whoami, help, GET /api/v1/,
// /llms.txt and /docs are built from it, and test/unit/catalog.test.ts fails when a REST operation or an MCP
// tool is missing here. Rule 9 in AGENTS.md: every new capability lands here in the same change.
import { hasScope, SCOPES, SCOPE_INFO, type Principal, type Scope } from "./auth/principal.ts";

export type Group = "Sites" | "Stats" | "Goals" | "Funnels" | "Annotations" | "Views" | "Alerts" | "Reports" | "Links" | "Export" | "Status" | "Admin" | "System";

export interface Capability {
  id: string;
  group: Group;
  /** What it does, in plain words, for people and agents. */
  summary: string;
  /** null = any authenticated caller. */
  scope: Scope | null;
  /** "METHOD /path" relative to /api/v1. */
  rest: string[];
  mcp?: string;
  /** Why there is no MCP tool. */
  mcpExclusion?: string;
  /** Dashboard location ($site = a site id). */
  dashboard?: string;
}

export const CAPABILITIES: Capability[] = [
  // Sites
  { id: "sites.list", group: "Sites", summary: "List the sites you can access, with domains, time zone, settings and data range", scope: "stats:read", rest: ["GET /sites"], mcp: "list_sites", dashboard: "/" },
  { id: "sites.read", group: "Sites", summary: "One site's settings and its tracking snippet", scope: "stats:read", rest: ["GET /sites/{site}"], mcp: "get_site", dashboard: "/sites/$site/settings" },
  { id: "sites.save", group: "Sites", summary: "Add a site (only its domain is required) or change its name, domains, time zone, retention and tracking settings", scope: "sites:write", rest: ["POST /sites", "PATCH /sites/{site}"], mcp: "save_site", dashboard: "/sites/new" },
  { id: "sites.archive", group: "Sites", summary: "Archive a site (stops collecting, restorable) or restore it; admins can delete it with all its data", scope: "sites:write", rest: ["DELETE /sites/{site}", "POST /sites/{site}/restore"], mcp: "archive_site", dashboard: "/sites/$site/settings" },
  { id: "sites.ingest", group: "Sites", summary: "Hits accepted and dropped per day by reason (bots, hosting networks, DNT, wrong host, excluded, rate, cap, invalid)", scope: "stats:read", rest: ["GET /sites/{site}/ingest"], mcp: "ingest_drops", dashboard: "/sites/$site/settings" },
  { id: "sites.install_check", group: "Sites", summary: "Check that the tracker is installed: last pageview, dropped hits, the snippet on the home page, blocking CSP", scope: "stats:read", rest: ["GET /sites/{site}/install-check"], mcp: "install_check", dashboard: "/sites/$site/settings" },
  { id: "sites.utm_builder", group: "Sites", summary: "Build a campaign link with utm_source, utm_medium, utm_campaign (and content, term) for a site's page", scope: null, rest: [], mcpExclusion: "Pure URL building in the browser; agents append the utm_* parameters themselves (help topic dimensions lists them)", dashboard: "/sites/$site/settings" },
  // Stats
  { id: "stats.summary", group: "Stats", summary: "KPIs with change vs the previous period, plus top pages, channels, referrers, countries, devices and goals; or the whole site view at once (series, every panel, goals, annotations)", scope: "stats:read", rest: ["GET /sites/{site}/summary", "GET /sites/{site}/overview"], mcp: "site_overview", dashboard: "/sites/$site" },
  { id: "stats.sites_summary", group: "Stats", summary: "Every site at a glance: visitors with change and series, today vs the same time yesterday, live now, top page and source, main goal, errors, vitals, uptime and last event, plus today's visitors per hour", scope: "stats:read", rest: ["GET /sites/summary"], mcp: "sites_summary", dashboard: "/" },
  { id: "stats.query", group: "Stats", summary: "Any metric × dimension × filter over a date range, with comparison (every other report is built on this); as JSON or a CSV download", scope: "stats:read", rest: ["POST /sites/{site}/query"], mcp: "query", dashboard: "/sites/$site" },
  { id: "stats.timeseries", group: "Stats", summary: "Metrics over time by hour, day, week or month, with a comparison series", scope: "stats:read", rest: ["GET /sites/{site}/timeseries"], mcp: "timeseries", dashboard: "/sites/$site" },
  { id: "stats.breakdown", group: "Stats", summary: "Top values of one dimension (pages, referrers, countries, event properties…)", scope: "stats:read", rest: ["GET /sites/{site}/breakdown/{dimension}"], mcp: "breakdown", dashboard: "/sites/$site" },
  { id: "stats.live", group: "Stats", summary: "Who is on all your sites now: visitors per site, hits per minute, the latest visits across sites and visitors by country", scope: "stats:read", rest: ["GET /live"], mcp: "live", dashboard: "/live" },
  { id: "stats.realtime", group: "Stats", summary: "Visitors in the last 5 minutes, their pages and sources", scope: "stats:read", rest: ["GET /sites/{site}/realtime"], mcp: "realtime", dashboard: "/sites/$site/realtime" },
  { id: "stats.sources", group: "Stats", summary: "Channels, named sources (Google, Facebook…), referrers, campaigns and AI-assistant traffic", scope: "stats:read", rest: ["GET /sites/{site}/sources/ai"], mcp: "traffic_sources", dashboard: "/sites/$site" },
  { id: "stats.changes", group: "Stats", summary: "What changed yesterday (or any day) against the same weekday a week before, and what drove it, in one sentence", scope: "stats:read", rest: ["GET /sites/{site}/changes"], mcp: "what_changed", dashboard: "/" },
  { id: "stats.movers", group: "Stats", summary: "What changed most against the previous period, to explain a rise or a drop", scope: "stats:read", rest: ["GET /sites/{site}/movers"], mcp: "top_movers" },
  { id: "stats.retention", group: "Stats", summary: "Weekly cohorts of same-day returning visitors", scope: "stats:read", rest: ["GET /sites/{site}/retention"], mcp: "retention", dashboard: "/sites/$site/retention" },
  { id: "stats.paths", group: "Stats", summary: "Journeys: the pages people visit after or before a page", scope: "stats:read", rest: ["GET /sites/{site}/paths"], mcp: "journeys", dashboard: "/sites/$site/paths" },
  { id: "stats.vitals", group: "Stats", summary: "Core Web Vitals (LCP, INP, CLS) p75 and good/poor shares by page or device", scope: "stats:read", rest: ["GET /sites/{site}/vitals"], mcp: "web_vitals", dashboard: "/sites/$site/vitals" },
  { id: "stats.errors", group: "Stats", summary: "Grouped JavaScript errors (when error tracking is on)", scope: "stats:read", rest: ["GET /sites/{site}/errors"], mcp: "errors", dashboard: "/sites/$site/errors" },
  { id: "stats.properties", group: "Stats", summary: "Custom event property keys seen in a range, to break events down with event_prop:<key>", scope: "stats:read", rest: ["GET /sites/{site}/properties"], mcp: "event_properties", dashboard: "/sites/$site" },
  { id: "stats.sessions", group: "Stats", summary: "Recent anonymous sessions (entry, exit, pages, duration, source, device) and one session's hits in order", scope: "stats:read", rest: ["GET /sites/{site}/sessions", "GET /sites/{site}/sessions/{id}"], mcp: "sessions", dashboard: "/sites/$site/sessions" },
  { id: "stats.insights", group: "Stats", summary: "Findings for a range: traffic swings, rising and falling pages, new referrers, slower pages, goal changes", scope: "stats:read", rest: ["GET /sites/{site}/insights"], mcp: "insights", dashboard: "/sites/$site" },
  { id: "stats.page_report", group: "Stats", summary: "Everything about one page: views, entries, exits, engagement, sources, next/previous pages, vitals", scope: "stats:read", rest: ["GET /sites/{site}/pages/report"], mcp: "page_report" },
  // Goals and funnels
  { id: "goals.list", group: "Goals", summary: "Goals with conversions and conversion rate", scope: "stats:read", rest: ["GET /sites/{site}/goals", "GET /sites/{site}/goals/{id}/conversions"], mcp: "goals", dashboard: "/sites/$site/goals" },
  { id: "goals.save", group: "Goals", summary: "Create or edit a goal (a page visit, a custom event or an outbound click, optionally with a property)", scope: "sites:write", rest: ["POST /sites/{site}/goals", "PATCH /sites/{site}/goals/{id}"], mcp: "save_goal", dashboard: "/sites/$site/goals" },
  { id: "goals.delete", group: "Goals", summary: "Delete a goal", scope: "sites:write", rest: ["DELETE /sites/{site}/goals/{id}"], mcp: "delete_goal", dashboard: "/sites/$site/goals" },
  { id: "funnels.analyze", group: "Funnels", summary: "List saved funnels and analyze a saved or ad-hoc funnel (steps within one session)", scope: "stats:read", rest: ["GET /sites/{site}/funnels", "GET /sites/{site}/funnels/{id}", "POST /sites/{site}/funnels/analyze"], mcp: "funnel", dashboard: "/sites/$site/funnels" },
  { id: "funnels.save", group: "Funnels", summary: "Create or edit a saved funnel", scope: "sites:write", rest: ["POST /sites/{site}/funnels", "PATCH /sites/{site}/funnels/{id}"], mcp: "save_funnel", dashboard: "/sites/$site/funnels" },
  { id: "funnels.delete", group: "Funnels", summary: "Delete a saved funnel", scope: "sites:write", rest: ["DELETE /sites/{site}/funnels/{id}"], mcp: "delete_funnel", dashboard: "/sites/$site/funnels" },
  // Annotations
  { id: "annotations.list", group: "Annotations", summary: "Change markers on the charts (deploys, content changes, campaigns)", scope: "stats:read", rest: ["GET /sites/{site}/annotations"], mcp: "list_annotations", dashboard: "/sites/$site/annotations" },
  { id: "annotations.add", group: "Annotations", summary: "Add a change marker to one site or all sites", scope: "annotations:write", rest: ["POST /sites/{site}/annotations"], mcp: "add_annotation", dashboard: "/sites/$site/annotations" },
  { id: "annotations.deploy_hook", group: "Annotations", summary: "Deploy markers from CI, one per site and commit (retries don't duplicate)", scope: "annotations:write", rest: ["POST /hooks/deploy"], mcpExclusion: "Called by CI after a deploy, not by agents; agents mark a change with add_annotation", dashboard: "/sites/$site/annotations" },
  { id: "annotations.update", group: "Annotations", summary: "Edit a change marker (title, note, link, time, category: deploy, content, campaign, incident, other)", scope: "annotations:write", rest: ["PATCH /sites/{site}/annotations/{id}"], mcp: "update_annotation", dashboard: "/sites/$site/annotations" },
  { id: "annotations.delete", group: "Annotations", summary: "Delete a change marker", scope: "annotations:write", rest: ["DELETE /sites/{site}/annotations/{id}"], mcp: "delete_annotation", dashboard: "/sites/$site/annotations" },
  // Saved views, share links, tracked links
  { id: "views.list", group: "Views", summary: "Saved views: named filter sets (segments) shared by everyone who can see the site", scope: "stats:read", rest: ["GET /sites/{site}/views"], mcp: "list_views", dashboard: "/sites/$site" },
  { id: "views.save", group: "Views", summary: "Save or edit a view (filters, optional date range and comparison, pinned)", scope: "sites:write", rest: ["POST /sites/{site}/views", "PATCH /sites/{site}/views/{id}"], mcp: "save_view", dashboard: "/sites/$site" },
  { id: "views.delete", group: "Views", summary: "Delete a saved view", scope: "sites:write", rest: ["DELETE /sites/{site}/views/{id}"], mcp: "delete_view", dashboard: "/sites/$site" },
  { id: "shares.list", group: "Views", summary: "Read-only public share links for a site (never the token)", scope: "sites:write", rest: ["GET /sites/{site}/shares"], mcp: "list_shares", dashboard: "/sites/$site/settings" },
  { id: "shares.create", group: "Views", summary: "Create a read-only public link to a site's reports, optionally with a password and expiry", scope: "sites:write", rest: ["POST /sites/{site}/shares"], mcp: "create_share", dashboard: "/sites/$site/settings" },
  { id: "shares.revoke", group: "Views", summary: "Revoke a share link", scope: "sites:write", rest: ["DELETE /sites/{site}/shares/{id}"], mcp: "revoke_share", dashboard: "/sites/$site/settings" },
  { id: "links.list", group: "Links", summary: "Tracked short links (/l/<slug>) with click counts", scope: "stats:read", rest: ["GET /sites/{site}/links"], mcp: "list_links", dashboard: "/sites/$site/settings" },
  { id: "links.save", group: "Links", summary: "Create a short link that records a link_click event and redirects (newsletters, QR codes, bios)", scope: "sites:write", rest: ["POST /sites/{site}/links"], mcp: "save_link", dashboard: "/sites/$site/settings" },
  { id: "links.delete", group: "Links", summary: "Delete a short link", scope: "sites:write", rest: ["DELETE /sites/{site}/links/{id}"], mcp: "delete_link", dashboard: "/sites/$site/settings" },
  // Alerts
  { id: "alerts.list", group: "Alerts", summary: "Traffic alert rules with their last value, and recent firings", scope: "stats:read", rest: ["GET /sites/{site}/alerts"], mcp: "list_alerts", dashboard: "/sites/$site/settings" },
  { id: "alerts.test", group: "Alerts", summary: "Evaluate an alert rule now without sending anything", scope: "stats:read", rest: ["POST /sites/{site}/alerts/{id}/test"], mcp: "test_alert", dashboard: "/sites/$site/settings" },
  { id: "alerts.save", group: "Alerts", summary: "Create or edit an alert: metric above/below a threshold, % change vs last week, no data, every occurrence of an event, new JS errors", scope: "sites:write", rest: ["POST /sites/{site}/alerts", "PATCH /sites/{site}/alerts/{id}"], mcp: "save_alert", dashboard: "/sites/$site/settings" },
  { id: "alerts.delete", group: "Alerts", summary: "Delete an alert rule", scope: "sites:write", rest: ["DELETE /sites/{site}/alerts/{id}"], mcp: "delete_alert", dashboard: "/sites/$site/settings" },
  // Export
  { id: "export.events", group: "Export", summary: "Raw event rows for a date range (NDJSON or CSV over REST, pages of up to 5,000 over MCP)", scope: "events:export", rest: ["GET /sites/{site}/export"], mcp: "export_events", dashboard: "/sites/$site" },
  // Status
  { id: "status.board", group: "Status", summary: "Status board: every check's state, uptime, response time and 90 days of history; incidents; backups", scope: "stats:read", rest: ["GET /ops/status"], mcp: "status", dashboard: "/status" },
  { id: "status.checks.list", group: "Status", summary: "Status checks with their configuration, and one check's recent results", scope: "stats:read", rest: ["GET /ops/monitors", "GET /ops/monitors/{id}", "GET /ops/monitors/{id}/checks"], mcp: "list_checks", dashboard: "/status" },
  { id: "status.checks.save", group: "Status", summary: "Add or edit a status check (URL, keyword, JSON, heartbeat, database query, DNS, domain expiry, Pulse ingest)", scope: "ops:write", rest: ["POST /ops/monitors", "PATCH /ops/monitors/{id}", "POST /ops/monitors/{id}/heartbeat-token"], mcp: "save_check", dashboard: "/status" },
  { id: "status.checks.delete", group: "Status", summary: "Delete a status check and its history", scope: "ops:write", rest: ["DELETE /ops/monitors/{id}"], mcp: "delete_check", dashboard: "/status" },
  { id: "status.checks.run", group: "Status", summary: "Run a saved check now, or try an unsaved configuration", scope: "ops:write", rest: ["POST /ops/monitors/{id}/check", "POST /ops/monitors/test"], mcp: "run_check", dashboard: "/status" },
  { id: "status.checks.pause", group: "Status", summary: "Pause a check for maintenance, or resume it", scope: "ops:write", rest: ["POST /ops/monitors/{id}/pause"], mcp: "pause_check", dashboard: "/status" },
  { id: "status.incidents.list", group: "Status", summary: "Incidents (open and past)", scope: "stats:read", rest: ["GET /ops/incidents"], mcp: "list_incidents", dashboard: "/status" },
  { id: "status.incidents.update", group: "Status", summary: "Add a note to, acknowledge or close an incident", scope: "ops:write", rest: ["PATCH /ops/incidents/{id}"], mcp: "update_incident", dashboard: "/status" },
  { id: "status.settings.read", group: "Status", summary: "Ops settings: backed-up databases, restore drill, database size warning, email only for errors", scope: "stats:read", rest: ["GET /ops/settings"], mcp: "ops_settings", dashboard: "/settings/ops" },
  { id: "status.settings.update", group: "Status", summary: "Change ops settings", scope: "ops:write", rest: ["PATCH /ops/settings"], mcp: "update_ops_settings", dashboard: "/settings/ops" },
  { id: "status.databases", group: "Status", summary: "D1 databases in the Cloudflare account, for backups and database checks", scope: "ops:write", rest: ["GET /ops/databases"], mcp: "list_databases", dashboard: "/settings/ops" },
  { id: "status.channels.list", group: "Status", summary: "Notification channels (email, webhook, Slack, Discord, Telegram, ntfy) with a safe preview of where they point", scope: "stats:read", rest: ["GET /ops/channels"], mcp: "list_channels", dashboard: "/settings/notifications" },
  { id: "status.channels.save", group: "Status", summary: "Add or edit a notification channel (its URL or token is stored encrypted and never shown again)", scope: "ops:write", rest: ["POST /ops/channels", "PATCH /ops/channels/{id}"], mcp: "save_channel", dashboard: "/settings/notifications" },
  { id: "status.channels.delete", group: "Status", summary: "Delete a notification channel", scope: "ops:write", rest: ["DELETE /ops/channels/{id}"], mcp: "delete_channel", dashboard: "/settings/notifications" },
  { id: "status.channels.test", group: "Status", summary: "Send a test message to a channel", scope: "ops:write", rest: ["POST /ops/channels/{id}/test"], mcp: "test_channel", dashboard: "/settings/notifications" },
  { id: "reports.list", group: "Reports", summary: "Scheduled reports (weekly or monthly summaries sent to notification channels; the weekly digest is one)", scope: "stats:read", rest: ["GET /ops/reports"], mcp: "list_reports", dashboard: "/settings/reports" },
  { id: "reports.preview", group: "Reports", summary: "Build a report for its last complete period without sending it", scope: "stats:read", rest: ["GET /ops/reports/{id}/preview"], mcp: "preview_report", dashboard: "/settings/reports" },
  { id: "reports.save", group: "Reports", summary: "Create or edit a scheduled report: sites, weekly or monthly schedule, sections, channels", scope: "ops:write", rest: ["POST /ops/reports", "PATCH /ops/reports/{id}"], mcp: "save_report", dashboard: "/settings/reports" },
  { id: "reports.delete", group: "Reports", summary: "Delete a scheduled report", scope: "ops:write", rest: ["DELETE /ops/reports/{id}"], mcp: "delete_report", dashboard: "/settings/reports" },
  { id: "reports.send", group: "Reports", summary: "Send a report now", scope: "ops:write", rest: ["POST /ops/reports/{id}/send"], mcp: "send_report", dashboard: "/settings/reports" },
  { id: "status.run_job", group: "Status", summary: "Run an ops job now (checks, backups, restore drill, the weekly-digest report, retention)", scope: "admin", rest: ["POST /ops/run"], mcp: "run_ops_job", dashboard: "/settings/system" },
  // Admin
  { id: "keys.list", group: "Admin", summary: "API keys with their scopes, sites, last use and status (never the secret)", scope: "admin", rest: ["GET /keys", "GET /keys/{id}"], mcp: "list_keys", dashboard: "/settings/keys" },
  { id: "keys.create", group: "Admin", summary: "Create an API key", scope: "admin", rest: ["POST /keys"], mcpExclusion: "returns a secret, and secrets must not pass through chat; create keys in the dashboard", dashboard: "/settings/keys" },
  { id: "keys.update", group: "Admin", summary: "Rename a key or change its scopes, sites or expiry (applies on its next request)", scope: "admin", rest: ["PATCH /keys/{id}"], mcp: "update_key", dashboard: "/settings/keys" },
  { id: "keys.rotate", group: "Admin", summary: "Replace a key's secret", scope: "admin", rest: ["POST /keys/{id}/rotate"], mcpExclusion: "returns a secret; rotate keys in the dashboard", dashboard: "/settings/keys" },
  { id: "keys.revoke", group: "Admin", summary: "Revoke an API key", scope: "admin", rest: ["DELETE /keys/{id}"], mcp: "revoke_key", dashboard: "/settings/keys" },
  { id: "users.list", group: "Admin", summary: "People with access and their roles", scope: "admin", rest: ["GET /users"], mcp: "list_users", dashboard: "/settings/people" },
  { id: "users.add", group: "Admin", summary: "Give someone access: they sign in with a one-time code sent to their email, as an owner, admin or viewer of some sites", scope: "admin", rest: ["POST /users"], mcp: "add_user", dashboard: "/settings/people" },
  { id: "users.update", group: "Admin", summary: "Change a person's role or site access, disable or re-enable them", scope: "admin", rest: ["PATCH /users/{id}", "DELETE /users/{id}", "POST /users/{id}/enable"], mcp: "update_user", dashboard: "/settings/people" },
  { id: "connected.list", group: "Admin", summary: "Apps connected through OAuth (claude.ai, Claude Desktop), who connected them and their scopes", scope: "admin", rest: ["GET /connected-apps"], mcp: "list_connected_apps", dashboard: "/settings/keys" },
  { id: "connected.revoke", group: "Admin", summary: "Disconnect an OAuth app", scope: "admin", rest: ["DELETE /connected-apps/{id}"], mcp: "revoke_connected_app", dashboard: "/settings/keys" },
  { id: "audit.list", group: "Admin", summary: "Audit log: who changed what", scope: "admin", rest: ["GET /audit"], mcp: "audit_log", dashboard: "/settings/audit" },
  { id: "imports.list", group: "Admin", summary: "History of data imports", scope: "admin", rest: ["GET /imports"], mcp: "list_imports", dashboard: "/settings/imports" },
  { id: "imports.run", group: "Admin", summary: "Bulk upsert of historical events and sessions", scope: "admin", rest: ["POST /admin/import"], mcpExclusion: "bulk uploads come from import scripts, not chat" },
  { id: "data.delete", group: "Admin", summary: "Delete a site's raw data in a date range, or only the sessions matching filters (remove spam or test visits): a dry run gives the counts and a confirmation token", scope: "admin", rest: ["POST /sites/{site}/delete-data"], mcp: "delete_data", dashboard: "/sites/$site/settings" },
  // System
  { id: "system.whoami", group: "System", summary: "Who you are: your scopes, sites, and what you can and can't do", scope: null, rest: ["GET /me", "GET /"], mcp: "whoami" },
  { id: "system.help", group: "System", summary: "Guides: metrics, dimensions, filters, tracker install and events, status checks, scopes, recipes", scope: null, rest: [], mcp: "help", dashboard: "/docs" },
  { id: "system.health", group: "System", summary: "Ingest lag, queue, last event per site, database size, backups, version", scope: "stats:read", rest: ["GET /health"], mcp: "health", dashboard: "/settings/system" },
];

export function capabilityByTool(tool: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.mcp === tool);
}

export function allowed(p: Principal, c: Capability): boolean {
  return c.scope === null || hasScope(p, c.scope);
}

/** What a principal can and can't do, for whoami, GET /api/v1/ and the MCP instructions. */
export function capabilitiesFor(p: Principal) {
  const can = CAPABILITIES.filter((c) => allowed(p, c));
  const locked = CAPABILITIES.filter((c) => !allowed(p, c));
  const missing = SCOPES.filter((s) => !hasScope(p, s));
  return {
    can: can.map((c) => ({ id: c.id, summary: c.summary, tool: c.mcp ?? null, rest: c.rest, dashboard: c.dashboard ?? null })),
    locked: locked.map((c) => ({ id: c.id, summary: c.summary, needs_scope: c.scope, tool: c.mcp ?? null })),
    missing_scopes: missing.map((s) => ({ scope: s, allows: SCOPE_INFO[s] })),
  };
}

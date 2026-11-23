// The Pulse guide: one set of texts for the MCP `help` tool, the pulse://guide resource, /llms.txt and /docs.
import { SCOPES, SCOPE_INFO } from "./auth/principal.ts";
import { CAPABILITIES, type Group } from "./catalog.ts";
import { SITE_COLORS } from "./lib/sites.ts";
import { INTERVALS, KIND_INFO, MONITOR_KINDS } from "./ops/monitor.ts";
import { BASE_DIMENSIONS, DATE_PRESETS, FILTER_OPS, METRICS } from "./query/schema.ts";

export const TOPICS = ["overview", "metrics", "dimensions", "filters", "date_ranges", "goals_and_funnels", "tracker", "sites", "status_checks", "alerts", "scopes", "api", "recipes"] as const;
export type Topic = (typeof TOPICS)[number];

const IDENTITY = `## How visitors are counted
- No cookies. visitor_id = HMAC(daily salt, site | IP | user agent); salts rotate every UTC day and are deleted after 48 h. The IP is never stored.
- So "visitors" over a multi-day range counts visitor-days, and retention means returning within the same day.
- A session = hits from one visitor with gaps under 30 minutes. Bounce = one pageview and under 10 s engaged time.
- Dates are local days in the site's time zone unless timezone = "UTC".
- Imported history (source = rybbit) uses Rybbit's ids and sessions; live data has source = pulse.`;

const METRIC_DOC: Record<string, string> = {
  visitors: "distinct visitor ids with a pageview or event",
  sessions: "sessions with a pageview or event in the range",
  pageviews: "pageview hits",
  views_per_session: "pageviews / sessions",
  bounce_rate: "% of sessions that bounced",
  avg_session_duration: "seconds from first to last hit, averaged over sessions",
  avg_engaged_time: "visible time on page (seconds) per pageview",
  events: "custom events (pulse.track)",
  conversions: "sessions that reached the goal (needs goal)",
  conversion_rate: "conversions / sessions, %",
  entries: "sessions that landed on the page (page dimension)",
  exits: "sessions that left from the page",
  exit_rate: "exits / pageviews, %",
  scroll_depth: "average max scroll %, from engagement hits",
  lcp_p75: "75th percentile Largest Contentful Paint, ms",
  inp_p75: "75th percentile Interaction to Next Paint, ms",
  cls_p75: "75th percentile Cumulative Layout Shift (unitless)",
  revenue: "total revenue from numeric revenue properties on custom events (in the site's revenue_currency)",
  average_revenue: "mean revenue per revenue-bearing event",
  revenue_per_visitor: "total revenue / visitors",
};

function metrics(): string {
  return `# Metrics\n\n| metric | definition |\n|---|---|\n${METRICS.map((m) => `| ${m} | ${METRIC_DOC[m] ?? ""} |`).join("\n")}\n\n${IDENTITY}`;
}

function dimensions(): string {
  return `# Dimensions
- Pages: page, entry_page, exit_page, hostname, title
- Sources: referrer, referrer_host, channel, source_name, utm_source, utm_medium, utm_campaign, utm_term, utm_content
  - channel values: AI Assistants, Paid Search, Paid Social, Email, Organic Search, Organic Social, Referral, Direct
  - source_name: the named engine or network (Google, Bing, DuckDuckGo, Facebook, Instagram, X, LinkedIn, ChatGPT…), from the referrer host or utm_source; unknown sources show their host. Split a channel with dimensions ["source_name"] and filter [["is","channel",["Organic Search"]]]
- Location (from the request; the IP is never stored): country (ISO-2), region, city, continent
- Technology: device (desktop/mobile/tablet), browser, browser_version, os, os_version, screen, language
- Events: event_name, event_prop:<key> (any custom event property), outbound_url, download_url
- Time: day, hour (0–23), datehour ("YYYY-MM-DD HH", for rolling windows), weekday (0 = Sunday), week (Monday), month
- Other: type, source

All: ${BASE_DIMENSIONS.join(", ")}, event_prop:<key>. Up to 3 dimensions per query.`;
}

function filters(): string {
  return `# Filters
An array of [operator, dimension, values]. Operators: ${FILTER_OPS.join(", ")}. Several values = any of them.
- [["is","country",["ES","MX"]], ["contains","page",["/blog"]]]
- is_one_of is the same as is (named for readability). matches / not_matches take * wildcards: [["matches","page",["/blog/*"]]]; other characters are literal.
- "(none)" matches empty values: [["is_not","referrer_host",["(none)"]]]
- Filters on event_name, event_prop:*, outbound_url, download_url select whole sessions that contain a matching event.
- Segment by conversion: [["is","goal",["<goal id>"]]] keeps sessions that converted on that goal (several ids = any of them); is_not keeps the ones that didn't.
- Value suggestions: breakdown {dimension, search:"blo"} returns only values containing the text.`;
}

function dateRanges(): string {
  return `# Date ranges and comparison
- date_range: a preset (${DATE_PRESETS.join(", ")}), {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} in the site's time zone, or a rolling window {"last_minutes": 180}. Default 28d. "24h" is the last 24 hours, not a calendar day.
  REST takes date_range=… or from=…&to=… as query parameters (the paths report uses date_from/date_to, because "from" is the page).
- timezone: "site" (default) or "UTC".
- compare: "previous_period" (same length, just before), "previous_year", explicit days {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}, or none. REST query strings take compare_from=…&compare_to=… for explicit days.
- Timeseries interval: hour, day, week, month. Missing days are filled with zeros.`;
}

function goalsAndFunnels(): string {
  return `# Goals and funnels
A goal counts sessions that did something. Match kinds:
- {"kind":"pageview","path":"/thanks"}: a page visit; * wildcards: "/blog/*", "/*/pricing"
- {"kind":"event","event":"signup"}: a custom event; add "prop":{"key":"plan","value":"pro"} to require a property
- {"kind":"outbound","host":"wa.me"}: a click to another site (host list, comma-separated)

save_goal {site, name:"Signup", match:{kind:"event", event:"signup"}} creates one (pass id to edit).
goals {site} lists them with conversions and conversion rate. query accepts goal = goal id or an inline match for conversions/conversion_rate.

A funnel is 2–8 steps (same match shapes) completed in order within one session and a time window (default 30 min).
step_order "flexible" (default) allows other pages between steps; "strict" ends the run at any other pageview between steps.
funnel {site, steps:[…]} analyzes ad hoc; save_funnel stores one; funnel {site, funnel_id} analyzes a saved one; funnel {site} lists saved funnels.
Add compare to see the same steps in the comparison period, and breakdown (channel, device, country, browser, os, referrer_host, utm_source, utm_medium, utm_campaign, utm_content, entry_page) for sessions per step by that dimension.`;
}

function tracker(origin: string): string {
  return `# Install the tracker and send events
Add one line to the <head> of every page:
\`\`\`html
<script defer src="${origin}/p.js" data-site="SITE_ID"></script>
\`\`\`
- Next.js (App Router, \`app/layout.tsx\`): \`<Script defer src="${origin}/p.js" data-site="SITE_ID" strategy="afterInteractive" />\` from \`next/script\`.
- Astro / Vite / plain HTML: put the plain \`<script>\` tag in your base layout's \`<head>\` (or \`index.html\`).
- WordPress: a header-scripts plugin or the theme's \`header.php\`.
- Content-Security-Policy: if the site sends a CSP header, add \`${origin}\` to \`script-src\` (and \`script-src-elem\` if used) and \`connect-src\`.
The site's domains must include every hostname that serves the page (add \`www.\` too, or \`*.example.com\` for subdomains). Verify with \`install_check {site}\`.

Attributes: data-api (ingest URL), data-exclude="/admin/*,/t/*", data-dev (allow localhost), data-respect-dnt="true", data-errors="true" (JS errors and unhandled rejections; the site's errors feature must be on), data-vitals="false", data-forms="true" (every untagged form sends form_submit with its id or name).

Tagged events need no JavaScript: <button data-pulse-event="signup" data-pulse-prop-plan="pro"> sends on click; <form data-pulse-event="contact"> sends on submit (field values are never sent).

Custom events (queue works before the script loads):
\`\`\`js
window.pulse = window.pulse || function () { (window.pulse.q = window.pulse.q || []).push(arguments) };
pulse("signup", { plan: "pro" });   // or pulse.track(name, props)
pulse("404");                        // on your not-found page
pulse("purchase", { revenue: 49.9, currency: "EUR" }); // revenue: numeric; another currency than the site's is ignored
pulse.pageview("/virtual/path");     // manual pageview
\`\`\`
Limits: names ≤ 80 chars, ≤ 20 props, values are strings (≤ 200), numbers or booleans. Never send personal data (emails, names, ids).
Automatic: pageviews incl. SPA navigation, engaged time and scroll depth, outbound clicks, downloads (pdf zip docx xlsx csv mp4 ics apk), Core Web Vitals.
Ignore your own visits: open the site once with #pulse-ignore (undo with #pulse-unignore).
No cookies or storage, so Pulse needs no cookie banner (audience-measurement exemption), but give visitors a way to object: a "don't count my visits" control that sets localStorage pulse_ignore = "1" (Pulse then sends nothing), and data-respect-dnt="true" on the script tag.`;
}

function sites(): string {
  return `# Sites
- save_site {domains:["example.com","www.example.com"]} creates a site; the id comes from the name or domain unless you pass one. Full URLs are accepted. "*.example.com" allows every subdomain.
- Response includes the snippet. Then install_check {site} until status = "receiving".
- Settings (save_site {id, settings:{…}}, merged): features {outbound, downloads, engagement, vitals, errors}, query_allowlist (query parameters kept in page URLs), respect_dnt, block_hosting (default true: drop visits from hosting/cloud networks, counted as dropped_hosting), exclude_paths (globs dropped at ingest), exclude_hosts (hostname globs dropped at ingest, e.g. "staging.*"), search_params (query parameters holding a site search), block_referrers and block_countries (dropped as spam), revenue_currency (revenue sent with another currency is ignored), color (${SITE_COLORS.join(", ")}, or null for automatic), primary_goal (goal id shown on the home card and first in reports, or null), hidden (internal sites: left out of the board, reports and connector consent), include_in_digest (part of reports that don't list their sites), daily_event_cap (circuit breaker, default 200000: after that many accepted events in a UTC day the site's hits are dropped until midnight UTC and the alert address gets one email; 0 = no cap; install_check reports it).
- timezone decides what "a day" is for reports. retention_months (default 25) keeps raw events; older days become daily rollups.
- archive_site stops collecting and hides the site (restorable). Permanent deletion is admin-only, in the dashboard or REST.`;
}

function statusChecks(): string {
  const examples: Record<string, string> = {
    http: '{"name":"Home","kind":"http","url":"https://example.com/","config":{"expect_status":"200-299","keyword":"Welcome"}}',
    json: '{"name":"API has items","kind":"json","url":"https://example.com/api/items","config":{"path":"data.items","expect":"non_empty"}}',
    heartbeat: '{"name":"Nightly scraper","kind":"heartbeat","config":{"period_min":1440,"grace_min":60}} → returns heartbeat_url once; call it from the job: curl -fsS <heartbeat_url>',
    d1_query: '{"name":"Scraper ran today","kind":"d1_query","config":{"database":"my-db","sql":"SELECT COUNT(*) > 0 AS ok FROM runs WHERE day = :today","timezone":"Europe/Madrid"}}',
    pulse_ingest: '{"name":"Events arriving","kind":"pulse_ingest","config":{"max_lag_min":120,"site_id":"example"}}',
    dns: '{"name":"MX record","kind":"dns","config":{"name":"example.com","type":"MX","expect_contains":"google"}}',
    domain_expiry: '{"name":"Domain renewal","kind":"domain_expiry","config":{"domain":"example.com","warn_days":30}}',
  };
  return `# Status checks
Each check runs every interval_min (${INTERVALS.join(", ")} minutes). After failures_to_alert consecutive failures (default 2) an incident opens and, when notify is on, a message goes to the check's channel_ids (null = every enabled notification channel); another on recovery. degraded_ms marks slow responses without an incident. site_id groups a check under a site.

Kinds:
${MONITOR_KINDS.map((k) => `- ${k}: ${KIND_INFO[k]}${examples[k] ? `\n  save_check ${examples[k]}` : ""}`).join("\n")}

http/json config: method (GET/HEAD/POST), body, headers (no secrets), expect_status ("200", "200-299", "200,301"), follow_redirects, keyword, keyword_absent; json adds path ("a.b[0].c"), expect (non_empty, exists, equals + value, max_age_minutes).
d1_query: one read-only SELECT on a D1 database in the account; the row's "ok" column (or first column) must be true; :today is the local date in config.timezone; an optional "detail" column is shown when it fails.
Try before saving: run_check {config…} (dry run). Run a saved one now: run_check {id}. Maintenance: pause_check {id, minutes}. History: list_checks {id}.
Not possible from a Worker: TLS certificate expiry, multi-region checks, DNS/TLS timing breakdowns.`;
}

function alerts(): string {
  return `# Alerts, notification channels and reports
Notification channels are where messages go: email (your verified ALERT_EMAIL address), Slack, Discord, Telegram, ntfy and signed webhooks. list_channels shows them (targets as safe hints); test_channel {id} sends a test; save_channel adds or edits one (its URL or token is stored encrypted and never shown again) and delete_channel removes it.

Traffic alerts (save_alert {site, …}) are checked every 5 minutes through the query engine:
- above / below: a metric over the last window_min crosses threshold, e.g. {"name":"Traffic spike","kind":"above","metric":"visitors","window_min":60,"threshold":500}
- change_pct: the window vs the same window a week earlier changes by more than threshold % (a negative threshold watches for drops)
- no_data: no pageviews for window_min (tracking broke or the site is down)
- event: event_name (e.g. "purchase") happened at least threshold times in the window
- new_error: a JavaScript error not seen in the previous 30 days
filters narrow the traffic, channel_ids pick channels (null = all), cooldown_min (default 60) limits repeats. test_alert {site, id} evaluates without sending; list_alerts shows recent firings.

Scheduled reports (save_report) send a summary of chosen sites weekly (weekday 0–6, 0 = Sunday) or monthly (day_of_month 1–28) at an hour in a time zone, with sections kpis, pages, sources, ai, goals, movers and optionally include_ops (checks, backups, database sizes). site_ids null = every site with include_in_digest. preview_report {id} shows what would be sent; send_report {id} sends now. The old weekly digest is the report "weekly-digest".`;
}

function scopes(): string {
  return `# Scopes
| scope | allows |
|---|---|
${SCOPES.map((s) => `| ${s} | ${SCOPE_INFO[s]} |`).join("\n")}

A key can also be limited to some sites. If you need more, ask an admin to edit this key in the dashboard (Settings → API keys); changes apply on your next request, no new key needed. whoami lists what you can do and what is locked.`;
}

function api(origin: string): string {
  const groups = [...new Set(CAPABILITIES.map((c) => c.group))] as Group[];
  return `# REST API
Base ${origin}/api/v1, header Authorization: Bearer pulse_sk_…. OpenAPI 3.1: ${origin}/api/v1/openapi.json (every operation has x-required-scope). Rendered: ${origin}/docs/api.
JSON, snake_case, ISO dates; errors {"error":{"code","message","details"}}. 600 requests/min per key. Reads send ETag.
GET ${origin}/api/v1/ says who you are and what you can do.

${groups
  .map(
    (g) =>
      `## ${g}\n${CAPABILITIES.filter((c) => c.group === g)
        .map((c) => `- ${c.summary}. ${c.rest.length ? c.rest.map((x) => `\`${x}\``).join(", ") : "MCP only"}${c.mcp ? ` · MCP \`${c.mcp}\`` : ""} · scope ${c.scope ?? "any"}`)
        .join("\n")}`,
  )
  .join("\n\n")}`;
}

function recipes(): string {
  return `# Recipes
- Weekly report: site_overview {date_range:{from,to}, compare:"previous_period"} → traffic_sources → top_movers for page and referrer_host → goals → list_annotations to explain changes. Lead with the 3 most important findings.
- Explain a drop on a date: timeseries around it; top_movers across page, channel, referrer_host, country, device for the 7 days after vs before; list_annotations near the date; status for incidents.
- Set up a new site end to end: save_site {domains} → add the snippet to the site's <head> (help tracker) → deploy → install_check until "receiving" → save_goal for the key action → save_check for the home page and any API the site depends on.
- Track a signup: in the site's code call pulse("signup", {plan}) after success → save_goal {match:{kind:"event", event:"signup"}} → goals.
- Watch a cron job or scraper: save_check {kind:"heartbeat", config:{period_min}} → call the returned heartbeat_url at the end of each successful run.
- Mark a deploy: add_annotation {site:"*" or a site, title:"Deploy …", url:<commit>} (site "*" = all sites over REST).`;
}

function overview(origin: string): string {
  return `# Pulse
Private, cookieless web analytics plus uptime checks for a handful of sites, with a REST API and this MCP server.

Start: list_sites → site_overview {site}. For anything custom use query (metrics × dimensions × filters). whoami shows your scopes and what you can do; help {topic} explains: ${TOPICS.join(", ")}.

What you can do (depending on your key's scopes):
${[...new Set(CAPABILITIES.map((c) => c.group))].map((g) => `- ${g}: ${CAPABILITIES.filter((c) => c.group === g && c.mcp).map((c) => c.mcp).join(", ") || "dashboard only"}`).join("\n")}

${IDENTITY}

REST: ${origin}/api/v1 (OpenAPI at /api/v1/openapi.json). MCP: ${origin}/mcp (API key as a Bearer token, or OAuth for claude.ai connectors). Dashboard: ${origin}/.`;
}

export function guideTopic(topic: Topic, origin: string): string {
  switch (topic) {
    case "overview":
      return overview(origin);
    case "metrics":
      return metrics();
    case "dimensions":
      return dimensions();
    case "filters":
      return filters();
    case "date_ranges":
      return dateRanges();
    case "goals_and_funnels":
      return goalsAndFunnels();
    case "tracker":
      return tracker(origin);
    case "sites":
      return sites();
    case "status_checks":
      return statusChecks();
    case "alerts":
      return alerts();
    case "scopes":
      return scopes();
    case "api":
      return api(origin);
    case "recipes":
      return recipes();
  }
}

/** pulse://schema: metrics, dimensions, filters and the counting caveats. */
export const SCHEMA_DOC = `${metrics()}\n\n${dimensions()}\n\n${filters()}\n\n${dateRanges()}`;

/** The whole guide as one markdown document (pulse://guide, /docs/agents). */
export function fullGuide(origin: string): string {
  return TOPICS.map((t) => guideTopic(t, origin)).join("\n\n---\n\n");
}

/** /llms.txt: a short public index for agents (no site names or data). */
export function llmsTxt(origin: string): string {
  return `# Pulse

> Private, cookieless web analytics and uptime checks with a REST API and an MCP server for agents.

Pulse is private: every call needs an API key (pulse_sk_…) or an OAuth connection made by a signed-in user.

## Connect
- MCP (Streamable HTTP): ${origin}/mcp with header "Authorization: Bearer pulse_sk_…". Claude Code: claude mcp add --transport http pulse ${origin}/mcp --header "Authorization: Bearer $PULSE_KEY"
- REST: ${origin}/api/v1 with the same header. GET ${origin}/api/v1/ lists what your key can do.
- claude.ai / Claude Desktop: add a custom connector with ${origin}/mcp (OAuth).

## Docs
- [Agent guide](${origin}/docs/agents): metrics, dimensions, filters, tracker install, status checks, scopes, recipes
- [OpenAPI 3.1](${origin}/api/v1/openapi.json)
- [API reference](${origin}/docs/api)
- [Human guide](${origin}/docs)

## First calls
1. whoami (MCP) or GET /api/v1/ (REST): your scopes and sites
2. list_sites
3. site_overview {site}
4. help {topic} for details: ${TOPICS.join(", ")}
`;
}

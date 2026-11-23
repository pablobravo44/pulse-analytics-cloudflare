# REST API v1

Base `https://pulse.example.com/api/v1`. Machine-readable spec: `/api/v1/openapi.json` (OpenAPI 3.1; every operation carries `x-required-scope`). Rendered reference: `/docs/api`. **`GET /api/v1/`** tells a key who it is and what it can do.

## Auth
`Authorization: Bearer pulse_sk_…`. Keys have scopes and optional site limits; create and edit them in Settings → API keys, with `PATCH /keys/{id}`, or with `npm run admin -- key:create`.

| Scope | Allows |
|---|---|
| `stats:read` | every read, incl. status checks, ops settings and install checks |
| `events:export` | raw rows (`/export`, MCP `export_events`) |
| `annotations:write` | add/delete annotations |
| `sites:write` | add/edit/archive sites, goals, funnels |
| `ops:write` | add/edit/pause/test status checks, incidents, ops settings |
| `admin` | keys, people, imports, ops jobs, data deletion (implies all) |

Dashboard requests use the session cookie plus `X-Pulse-Client: dashboard`; writes must come from the same origin.

## Conventions
- JSON, `snake_case`, ISO-8601 dates; errors `{"error":{"code","message","details"}}` with the right status.
- Every stats response has `meta` (`site`, `date_range`, `timezone`, `generated_at`). `POST /query` with `"source_counts": true` adds `meta.source_counts` (imported vs live rows in the range; it scans the range, so it is off by default). Rates and averages (bounce rate, durations, conversion rate…) are `null` when there is nothing to divide, counts are 0. A range that ends today compares with the previous period cut at the same time of day; whole calendar months compare with the months before, a month to date with the same days of last month.
- `ETag` and `Cache-Control: private, max-age=30` on reads. Rate limit 600 requests/min per key (`RateLimit-Policy`), shared with that key's `/mcp` calls. Per client (IPv4 address or IPv6 /64): ingest 120 hits/min per site, sign-in steps under `/auth` and OAuth client registration 20/min, heartbeat pings 600/min.
- Shared query parameters: `date_range` (`today yesterday 24h 7d 28d 30d 90d mtd last_month ytd 12mo all`) or `from`+`to` (the query body also takes `{"last_minutes": N}`); `timezone` (`site`|`UTC`); `compare` (`previous_period`|`previous_year`|`none`) or `compare_from`+`compare_to` for explicit days (the query body takes `"compare": {"from","to"}`); `filters` = JSON `[[op, dimension, values[]], …]`.
- Outside the API, `GET /icons/favicon/{host}` serves a referrer's favicon to the dashboard's `<img>` tags: signed-in sessions only (the dashboard cookie), fetched by the Worker from that host itself (`/favicon.ico`, else the home page's icon link) and cached a week, so neither the reader's browser nor an icon service learns which sites send traffic. Not an agent capability (images), so it has no MCP tool.

## The query engine
`POST /sites/{site}/query`

```json
{
  "metrics": ["visitors", "pageviews", "bounce_rate"],
  "dimensions": ["channel"],
  "filters": [["is", "country", ["ES"]], ["contains", "page", ["/blog"]]],
  "date_range": "28d",
  "compare": "previous_period",
  "order_by": ["visitors", "desc"],
  "limit": 50
}
```
Returns `rows`, `totals`, `comparison` and `next_cursor`. `conversions`/`conversion_rate` need `"goal": "<goal id>"` or an inline match `{"kind":"event","event":"start_free"}`.

**Metrics:** visitors, sessions, pageviews, views_per_session, bounce_rate, avg_session_duration, avg_engaged_time, events, conversions, conversion_rate, entries, exits, exit_rate, scroll_depth, lcp_p75, inp_p75, cls_p75, revenue, average_revenue, revenue_per_visitor (from a numeric `revenue` property on events).

**Share links:** requests with `X-Pulse-Share: <token>` (and `X-Pulse-Share-Password` when set) get read-only access to that one site's reports.

**Dimensions:** page, entry_page, exit_page, hostname, title · referrer, referrer_host, channel, source_name (Google, Bing, Facebook, LinkedIn, ChatGPT…; unknown sources fall back to the referrer host, then utm_source), utm_* · country, region, city, continent · device, browser, browser_version, os, os_version, screen, language · event_name, event_prop:&lt;key&gt;, outbound_url, download_url · search_term (site search, per-site `search_params`) · day, hour, datehour, weekday, week, month · type, source.

**Filters:** `is` (alias `is_one_of`), `is_not`, `contains`, `not_contains`, `starts_with`, `matches`/`not_matches` (`*` wildcard, everything else literal). `"(none)"` matches empty values. Filters on `event_name`, `event_prop:*`, `outbound_url`, `download_url` select whole sessions containing a matching event. `["is", "goal", ["<goal id>"]]` keeps sessions that converted on the goal (`is_not`: those that didn't).

## Endpoints
| Endpoint | Purpose |
|---|---|
| `GET /api/v1/` | Start here: who you are, what you can do, what's locked |
| `GET /me` | The authenticated principal |
| **Sites** | |
| `GET /sites` (`?include_archived=true` for admins), `GET /sites/{site}` | Sites, settings, snippet, data range |
| `POST /sites` | Add a site: only `domains` is required (URLs are normalized; `id` and `name` are derived). Returns the snippet and next steps |
| `PATCH /sites/{site}` | Name, domains, time zone, retention, settings (merged: `features`, `query_allowlist`, `respect_dnt`, `block_hosting` (default true; drops visits from hosting/cloud networks, counted in `dropped_hosting`), `exclude_paths`, `exclude_hosts` (hostname globs like `staging.*`), `search_params`, `block_referrers`, `block_countries`, `revenue_currency` (revenue sent in another `currency` is ignored and counted), `hidden`, `include_in_digest`, `daily_event_cap` (default 200000; after that many accepted events in a UTC day ingest pauses until midnight UTC and one alert email goes out; 0 = no cap), `color` (violet, teal, amber, magenta, blue, olive, coral, indigo, emerald, plum, cyan or slate; null = by creation order), `primary_goal` (one of the site's goal ids)). Sites in `GET /sites` and `GET /sites/{site}` carry `color`: their slot `s1`…`s12` |
| `DELETE /sites/{site}` | Archive (stops collecting, restorable). `?purge=true&confirm=<site id>` (admin) deletes the site and all its data |
| `POST /sites/{site}/restore` | Restore an archived site |
| `GET /sites/{site}/install-check` | Last pageview, today's accepted/dropped hits (bots, wrong host, excluded by the site's rules, invalid, rate limited) and ignored revenue, snippet found on the home page, blocking CSP; findings with fixes |
| **Stats** | |
| `POST /sites/{site}/query` | Composable query (above); `?format=csv` downloads the rows as CSV (dimensions, then metrics) |
| `GET /sites/summary?date_range=today\|7d\|30d` | Every site at a glance (the home page): per site visitors with change and series (hourly for today), today so far vs yesterday at the same time, live now, top page and source, main goal, errors in 24 h, LCP/CLS p75, uptime of its checks, last event, `low_traffic` (under 5 visitors a day: draw bars); `hours` = today vs yesterday per hour. One D1 query for all sites, cached 60 s. `include_hidden=true` adds internal sites. The site id `summary` is reserved |
| `GET /sites/{site}/summary` | Start here: KPIs with change, top pages/channels/referrers/countries/devices, goals |
| `GET /sites/{site}/overview` | The whole site view in one call (what the dashboard opens): KPIs with change, the series of every KPI, top rows of every panel (`panels=`, `limit=`), goals with the previous period, annotations. Answered from the daily rollups as one D1 query and cached at the edge (60 s when the range includes today, 10 min otherwise; `X-Pulse-Cache: hit|miss`, `Server-Timing` carries D1 statements and rows read) |
| `GET /sites/{site}/timeseries?metrics=&interval=` | Series with comparison. Every interval is present (hours up to now, days, Monday weeks, months); an empty interval has counts 0 and rates `null`. `comparison.series[i]` is the i-th interval of the previous period (its own date), filled the same way |
| `GET /sites/{site}/breakdown/{dimension}?metrics=&search=` | One dimension; `search` keeps values containing the text (value suggestions) |
| `GET /sites/{site}/ingest?days=30` | Hits accepted and dropped per UTC day by reason (`bot`, `hosting`, `dnt`, `wrong_host`, `excluded`, `rate_limited`, `over_cap`, `invalid`), with totals and the dropped share |
| `GET /sites/{site}/changes?date=` | What changed on one day (default yesterday) against the same weekday a week before: visitors, change, the channel/page/country that drove it, and a sentence. Also in `/sites/summary` per site as `changes` |
| `GET /live` | Who is on all your sites now: visitors in the last 5 minutes and hits per minute per site, the visits of the last 30 minutes across sites (newest first; site, pages, source, country, device, `active`), visitors by country. Visits carry no ids |
| `GET /sites/{site}/realtime` | Last 5 minutes: visitors, pages, sources, hits per minute (30 min); `visits` = the visits of the last 30 minutes grouped by visit (pages, source, country, device, `active` when it had a hit in the last 5 minutes, the same rule as `visitors`); `recent` = the latest events |
| `GET /sites/{site}/sources/ai` | AI-assistant channel detail |
| `GET /sites/{site}/movers?dimension=&metric=` | Biggest changes vs comparison |
| `GET /sites/{site}/pages/report?path=` | Everything about one page |
| `GET /sites/{site}/retention` | Weekly cohorts (same-day return; ids rotate daily) |
| `GET /sites/{site}/paths?from=/page&direction=next|previous&depth=` | Journeys (dates via `date_from`/`date_to` here) |
| `GET /sites/{site}/vitals`, `GET /sites/{site}/errors` | Web vitals, grouped JS errors |
| `GET /sites/{site}/insights` | Findings: traffic swings, rising/falling pages, new referrers, slower pages, goal changes. Each has an English `title`/`detail` and a stable `code` (`traffic_up`, `traffic_down`, `page_gaining`, `page_losing`, `new_referrer`, `lcp_slower`, `inp_slow`, `goal_up`, `goal_down`) with `params` to word it in another language |
| `GET /sites/{site}/properties?event=` | Custom event property keys with counts |
| `GET /sites/{site}/sessions?limit=&before=`, `GET /sites/{site}/sessions/{id}` | Anonymous sessions (same-day), one session's hits |
| **Goals, funnels, annotations, export** | |
| `GET/POST /sites/{site}/goals`, `PATCH/DELETE /sites/{site}/goals/{id}`, `GET /sites/{site}/goals/{id}/conversions` | Goals CRUD and conversions |
| `GET/POST /sites/{site}/funnels`, `GET/PATCH/DELETE /sites/{site}/funnels/{id}`, `POST /sites/{site}/funnels/analyze` | Funnels CRUD and analysis. `step_order`: `flexible` (default) or `strict` (no other pageview between steps). Analysis takes `compare` (the same steps in the comparison period) and `breakdown` (`channel`, `device`, `country`, `browser`, `os`, `referrer_host`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `entry_page`) |
| `GET/POST /sites/{site}/annotations`, `PATCH/DELETE /sites/{site}/annotations/{id}` (`site=*` for all sites) | Change markers, with `category` (deploy, content, campaign, incident, data, other). A data-quality marker lists in `affects` the metrics whose definition or source changed there; `/summary` and `/overview` then give those KPIs `change_pct: null` and `not_comparable: "<title>"` when the marker falls between the two periods. A finished import adds one where its data ends |
| `POST /hooks/deploy` (annotations:write) | From CI after a deploy: `{sites: [ids] or "*", repo, sha, message?, url?, environment?}` adds one `deploy` marker per site, idempotent per commit (a retried build adds nothing). `scripts/annotate-deploy.mjs` calls it from Workers Builds |
| **Views, shares, links, alerts** | |
| `GET/POST /sites/{site}/views`, `PATCH/DELETE /sites/{site}/views/{id}` | Saved views (named filter sets) |
| `GET/POST /sites/{site}/shares`, `DELETE /sites/{site}/shares/{id}` | Read-only public links (`/share/<token>`, optional password and expiry; the URL is shown once). Links are rate limited like API keys; wrong passwords lock a link for a minute after 20 tries. Passwords are stored as PBKDF2-SHA256 (100000 iterations, random salt); links made earlier with a SHA-256 hash keep working and are rehashed on the first right password. `view_id` binds the link to a saved view whose filters apply to every report it shows (realtime, retention and the views list are then unavailable, and site-wide counts are left out); `embed_origins` (https origins) allows embedding in an iframe, and the response includes an `embed` snippet |
| `GET/POST /sites/{site}/links`, `DELETE /sites/{site}/links/{id}` | Tracked short links `/l/<slug>` (record `link_click`, redirect) |
| `GET/POST /sites/{site}/alerts`, `PATCH/DELETE /sites/{site}/alerts/{id}`, `POST /sites/{site}/alerts/{id}/test` | Traffic alerts and a dry evaluation |
| `GET /sites/{site}/export?from&to&format=ndjson|csv&type=` | Raw events, streamed in (ts, id) order; `type` is pageview, event, outbound, download, vitals or error. The dashboard's **Export** button (site view) uses this and `/query?format=csv` |
| **Status** | |
| `GET /ops/status` | Board: every check's state, uptime over the last 24 h (rolling) and 7/30/90 UTC days (precomputed daily cells, today included), p50, 90 daily cells; incidents; databases; backups |
| `GET /ops/monitors`, `GET /ops/monitors/{id}`, `GET /ops/monitors/{id}/checks?hours=` | Checks with configuration; recent results |
| `POST /ops/monitors`, `PATCH /ops/monitors/{id}`, `DELETE /ops/monitors/{id}` | Add (409 if the id exists), edit (config merged), delete. `quiet_hours` `{from, to, tz}` (local HH:MM, may cross midnight): failures inside it are recorded but open no incident and notify nobody (nightly lulls, a job's run window); `null` removes it |
| `POST /ops/monitors/test` | Dry run of an unsaved configuration |
| `POST /ops/monitors/{id}/check?record=` | Run a check now |
| `POST /ops/monitors/{id}/pause` | `{minutes}` or `{until}`; `{}` resumes |
| `POST /ops/monitors/{id}/heartbeat-token` | New ping URL for a heartbeat check (shown once) |
| `GET /ops/incidents?status=open|all`, `PATCH /ops/incidents/{id}` | Incidents; note, acknowledge, close |
| `GET /ops/settings`, `PATCH /ops/settings` | Backed-up and drilled databases (changing them needs `admin`), D1 size warning and `email_only_errors` (default `true`: email goes only for new JavaScript errors and failed or stale backups; other alerts, status checks and warnings skip email channels; scheduled reports keep their own schedule) (`ops:write`) |
| `GET/POST /ops/reports`, `PATCH/DELETE /ops/reports/{id}` | Scheduled reports: sites (`null` = every site with `include_in_digest`), `frequency` weekly/monthly, `weekday`/`day_of_month`, `hour`, `timezone`, `sections` (kpis, pages, sources, ai, goals, movers), `include_ops`, `channel_ids`, `enabled`. The old digest is `weekly-digest` |
| `GET /ops/reports/{id}/preview`, `POST /ops/reports/{id}/send` | Build a report for its last complete period (subject, text, HTML, numbers) without sending; send now |
| `GET /ops/databases` | D1 databases in the account (for pickers) |
| `GET/POST /ops/channels`, `PATCH/DELETE /ops/channels/{id}`, `POST /ops/channels/{id}/test` | Notification channels (email, webhook signed with `X-Pulse-Signature`, Slack, Discord, Telegram, ntfy); secrets sealed with `PULSE_SECRET_KEY` |
| `POST /ops/run` | Run an ops job now (admin) |
| **Admin** | |
| `GET /keys?status=`, `GET /keys/{id}`, `POST /keys`, `PATCH /keys/{id}`, `POST /keys/{id}/rotate`, `DELETE /keys/{id}` | API keys: list, create (secret shown once), edit name/scopes/sites/expiry, rotate, revoke |
| `GET /users`, `POST /users`, `PATCH /users/{id}`, `DELETE /users/{id}`, `POST /users/{id}/enable` | People: add someone by email (they sign in with a one-time code), roles, site access, disable/enable (with `site_ids` for viewers) |
| `GET /audit?action=`, `GET /imports` | Audit log, import history |
| `GET /connected-apps`, `DELETE /connected-apps/{id}?user_id=` | OAuth apps (claude.ai, Claude Desktop) and disconnecting them |
| `POST /admin/import` | Idempotent batch upsert for historical sessions and events |
| `POST /sites/{site}/delete-data` | Delete raw data in a range, or only sessions matching `filters`; `dry_run` counts first |
| `GET /health` | Ingest lag, queue/DLQ, last event per site, D1 size, backups, version |

Status check kinds: `http`, `json`, `json_nonempty` (legacy), `heartbeat` (your job calls `/hb/<token>`), `d1_query` (read-only SELECT on a D1 database), `pulse_ingest`, `dns`, `domain_expiry`. The agent guide (`/docs/agents`, topic status_checks) has each kind's config with examples.

## Examples
```sh
K="Authorization: Bearer $PULSE_KEY"
curl -H "$K" "$BASE/"                                   # what can this key do?
curl -H "$K" "$BASE/sites/example/summary?date_range=7d"
curl -H "$K" -X POST "$BASE/sites" -H 'Content-Type: application/json' -d '{"domains":["example.com","www.example.com"],"timezone":"Europe/Madrid"}'
curl -H "$K" -X PATCH "$BASE/keys/<id>" -H 'Content-Type: application/json' -d '{"scopes":["stats:read","sites:write"],"site_ids":null}'
curl -H "$K" -X POST "$BASE/ops/monitors" -H 'Content-Type: application/json' -d '{"name":"Home","url":"https://example.com/","site_id":"example","config":{"keyword":"Welcome"}}'
curl -H "$K" -X POST "$BASE/sites/*/annotations" -d '{"title":"Pricing page rewrite"}' -H 'Content-Type: application/json'
```

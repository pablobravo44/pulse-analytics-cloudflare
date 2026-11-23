# MCP server

`https://pulse.example.com/mcp` — Streamable HTTP, **stateless** (JSON responses, no sessions; `GET`/`DELETE` answer 405).

## Connect
**Claude Code** (API key):
```sh
claude mcp add --transport http pulse https://pulse.example.com/mcp --header "Authorization: Bearer $PULSE_KEY"
```

**Codex CLI** (API key):
```sh
codex mcp add pulse --url https://pulse.example.com/mcp --bearer-token-env-var PULSE_KEY
```

**Cursor / `.mcp.json`** (API key):
```json
{
  "mcpServers": {
    "pulse": {
      "type": "http",
      "url": "https://pulse.example.com/mcp",
      "headers": { "Authorization": "Bearer ${PULSE_KEY}" }
    }
  }
}
```
Managed agents: a vault `static_bearer` credential with the key. For an end-to-end deploy and site-onboarding runbook designed for coding agents, see [AGENT-SETUP.md](AGENT-SETUP.md).

**claude.ai / Claude Desktop** (OAuth 2.1): add a custom connector with the URL above. The client registers itself (DCR or Client ID Metadata Document), you sign in, then choose permissions (`stats:read`, `annotations:write`, `events:export`, `sites:write`, `ops:write`) and sites. Tokens last an hour and refresh; the grant itself lasts 30 days from consent, then the connector asks you to approve it again. What you approved is re-checked against your account on every request: if your role drops to viewer or you lose a site, the connector loses the same scopes and sites immediately (and stops working when no site is left).

Rate limits: 600 requests a minute per API key (shared with its REST calls) or per OAuth grant; OAuth client registration 20 a minute per client. Over the limit `/mcp` answers 429.

Discovery: `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`. Public index for agents: `/llms.txt`; full agent guide: `/docs/agents` (markdown at `/docs/agents.md`).

## What an agent sees
- **Only the tools its key's scopes allow.** A `stats:read` key gets the read tools plus `whoami` and `help`; write tools appear when an admin adds `sites:write`, `ops:write`, `annotations:write`, `events:export` or `admin` to the key (Settings → API keys → edit; no new key needed, it applies on the next request).
- **Instructions written for the key**: who it is, its sites, what it can change, what is locked and which scope unlocks it, and the counting caveats.
- `whoami` returns the same as structured data, and `help {topic}` returns the guides (topics: overview, metrics, dimensions, filters, date_ranges, goals_and_funnels, tracker, sites, status_checks, alerts, scopes, api, recipes).
- Errors are `{"error":{"code","message","hint"}}`; the hint says what to do (which scope is missing, which site ids exist, valid dimensions).

The list of capabilities, tools and scopes lives in `src/worker/catalog.ts`; `test/unit/catalog.test.ts` fails when a REST route or a tool is missing from it or from this file (AGENTS.md rule 9).

## Tools
Stats tools accept `site` (optional when the credential covers one site) and the shared `date_range`, `timezone`, `compare` (`previous_period`, `previous_year` or explicit `{from,to}`), `filters` (see API.md; operators include `matches` with `*` wildcards, and the `goal` dimension segments by conversion). Results are compact JSON, capped at 1,000 rows.

| Tool | Scope | Use it for |
|---|---|---|
| `whoami` | any | Your scopes, sites, what you can and can't do |
| `help` | any | Guides: metrics, dimensions, filters, tracker install and events, status checks, scopes, recipes |
| `list_sites` | stats:read | First call: sites, domains, time zones, data range; `include_archived` (admin) adds archived sites |
| `get_site` | stats:read | One site's settings and tracking snippet |
| `save_site` | sites:write | Add a site (domains only) or edit one (name, domains, time zone, retention, settings) |
| `archive_site` | sites:write | Archive or restore a site |
| `install_check` | stats:read | Is the tracker installed? Findings with fixes |
| `sites_summary` | stats:read | Every site at a glance in one call (what the home page shows): visitors with change and series, today vs yesterday at the same time, live now, top page and source, main goal, errors, vitals, uptime, last event |
| `site_overview` | stats:read | KPIs with change, top pages/channels/referrers/countries/devices, goals, one-line summary; `full: true` returns the whole site view (`GET /sites/{site}/overview`) |
| `query` | stats:read | Anything custom: metrics × dimensions × filters; `source_counts: true` adds imported vs live row counts |
| `timeseries` | stats:read | Trends, with comparison series |
| `breakdown` | stats:read | Top values of one dimension; `search` narrows to values containing a text |
| `realtime` | stats:read | Who is on the site now, with the visits of the last 30 minutes (active ones marked) and the latest events |
| `ingest_drops` | stats:read | Accepted and dropped hits per day by reason, when traffic looks inflated or missing |
| `what_changed` | stats:read | Yesterday (or a day) against the same weekday a week before, with the drivers, in one sentence |
| `live` | stats:read | Who is on all your sites now: visitors and hits per site, the latest visits across sites, visitors by country |
| `traffic_sources` | stats:read | Channels, named sources (Google, Bing, Facebook…), referrers, campaigns, AI-assistant detail |
| `top_movers` | stats:read | Explain a change: gainers, losers, biggest relative moves |
| `retention` | stats:read | Weekly cohorts (same-day return) |
| `journeys` | stats:read | Pages visited after or before a page |
| `page_report` | stats:read | Everything about one page |
| `insights` | stats:read | What stands out: traffic swings, rising/falling pages, new referrers, slower pages, goal changes |
| `event_properties` | stats:read | Custom event property keys, to break events down with `event_prop:<key>` |
| `sessions` | stats:read | Recent anonymous sessions, or one session's hits in order |
| `web_vitals` | stats:read | p75 and good/NI/poor shares |
| `errors` | stats:read | Grouped JS errors |
| `goals` | stats:read | Goals with conversions |
| `save_goal` / `delete_goal` | sites:write | Create, edit, delete goals |
| `funnel` | stats:read | Saved (`funnel_id`) or ad-hoc steps; `step_order` flexible/strict, `compare`, `breakdown` (channel, device, country…); no arguments lists saved funnels |
| `save_funnel` / `delete_funnel` | sites:write | Create, edit (incl. `step_order`), delete saved funnels |
| `list_annotations` | stats:read | Change markers with category and `affects` |
| `add_annotation` / `update_annotation` / `delete_annotation` | annotations:write | Add, edit or delete change markers with a `category` (deploy, content, campaign, incident, data, other; `site: "*"` = all sites) and, for data-quality markers, `affects` (metrics whose change is not shown across it). Incidents of a site's status checks are added automatically |
| `list_views` | stats:read | Saved views (named filter sets) |
| `save_view` / `delete_view` | sites:write | Save, edit, delete views |
| `list_shares` / `create_share` / `revoke_share` | sites:write | Read-only public share links: list (never the token), create (password, expiry, bound view, embedding; the URL is returned once), revoke |
| `list_links` | stats:read | Tracked short links with click counts |
| `save_link` / `delete_link` | sites:write | Short links `/l/<slug>` that record a `link_click` event |
| `list_alerts` / `test_alert` | stats:read | Traffic alert rules, recent firings; evaluate one now |
| `save_alert` / `delete_alert` | sites:write | Alerts: above/below a threshold, % change vs last week, no data, every event, new JS errors |
| `export_events` | events:export | Raw rows, ≤ 5,000 per call |
| `status` | stats:read | Status board: checks, uptime, incidents, backups |
| `list_checks` | stats:read | Checks with configuration; one check's recent results |
| `save_check` | ops:write | Add or edit a check (http, json, heartbeat, d1_query, pulse_ingest, dns, domain_expiry), with optional `quiet_hours` when failures should not alert |
| `delete_check` | ops:write | Delete a check |
| `run_check` | ops:write | Run a saved check now, or dry-run a configuration |
| `pause_check` | ops:write | Pause for maintenance, or resume |
| `list_incidents` | stats:read | Open and past incidents, optionally for one check (`monitor`), newest first (`limit`, default 20) |
| `list_channels` | stats:read | Where alerts go (email, webhook, Slack, Discord, Telegram, ntfy), with a safe preview of each target |
| `save_channel` / `delete_channel` | ops:write | Add, rename, enable/disable, repoint or delete a channel; URLs and tokens are stored encrypted and never shown again (a new webhook returns its signing secret once) |
| `test_channel` | ops:write | Send a test message to a channel |
| `update_incident` | ops:write | Note, acknowledge or close an incident |
| `ops_settings` / `update_ops_settings` | stats:read / ops:write | Backed-up databases and restore drill (changing them needs admin), size warning, `email_only_errors` |
| `list_reports` | stats:read | Scheduled reports (weekly or monthly summaries to notification channels; the weekly digest is `weekly-digest`) |
| `preview_report` | stats:read | Build a report for its last complete period without sending it |
| `save_report` / `delete_report` | ops:write | Create or edit a report: sites, weekly/monthly schedule, sections, `include_ops`, channels; delete one |
| `send_report` | ops:write | Send a report now |
| `list_databases` | ops:write | D1 databases in the account |
| `run_ops_job` | admin | Run checks, backups, drill, the weekly-digest report or retention now |
| `list_keys` / `update_key` / `revoke_key` | admin | API keys: list, edit name/scopes/sites/expiry, revoke |
| `list_users` / `add_user` / `update_user` | admin | People: add someone by email, roles, site access, disable/enable |
| `list_connected_apps` / `revoke_connected_app` | admin | OAuth apps (claude.ai, Claude Desktop) and disconnecting them |
| `list_imports` | admin | History of data imports from other analytics tools |
| `delete_data` | admin | Delete a site's raw data in a range, or only sessions matching filters: `dry_run` returns the counts and a `confirm_token`, the second call needs it |
| `audit_log` | admin | Who changed what |
| `health` | stats:read | Ingest lag, queue, database size, backups |

`archive_site` also deletes a site with all its data (`purge: true`, `confirm: "<site id>"`, admin).

Not available over MCP, by design (dashboard or REST only): creating and rotating API keys, because a key is a credential and an agent reading attacker-controlled analytics data (page titles, referrers, event properties) should never be able to mint one; bulk imports, which come from import scripts.

Resources: `pulse://sites`, `pulse://schema` (metric and dimension definitions and caveats), `pulse://guide` (everything `help` knows), `pulse://site/{id}/settings`.
Prompts: `weekly_report(site, week?)`, `investigate_change(site, metric, date)`, `setup_site(domain)`, `site_health(site)`.

## Test with MCP Inspector
```sh
npx @modelcontextprotocol/inspector --cli https://pulse.example.com/mcp --transport http \
  --header "Authorization: Bearer $PULSE_KEY" --method tools/list
npx @modelcontextprotocol/inspector --cli https://pulse.example.com/mcp --transport http \
  --header "Authorization: Bearer $PULSE_KEY" --method tools/call --tool-name whoami
```
Locally, point the same commands at `http://localhost:8787/mcp` (`npm run dev:api`).

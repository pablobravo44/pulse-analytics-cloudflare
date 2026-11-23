# Design decisions

Why Pulse is built the way it is. Read this before changing one of these areas; if you change a decision, update its entry.

## Platform and storage

### One Worker, D1, Queues
One Worker serves the tracker, ingest, REST API, MCP server, OAuth and the dashboard on one hostname. D1 holds raw events and sessions: the API needs exact, joinable, importable data, which Analytics Engine (sampled, no joins, no updates) can't give. A queue sits between ingest and D1 so a page's beacon never waits on a database write, and so a burst is drained at a bounded rate (`max_concurrency: 3`) instead of scaling out against a database that runs one query at a time.

### 1-click deploy & custom-domain environments
The top level of `wrangler.jsonc` is ready for Cloudflare's **Deploy to Cloudflare** 1-click button (`workers_dev: true`, auto-provisioned D1/KV/R2/Queues; `PUBLIC_ORIGIN` and `RP_ID` resolve automatically from the request origin and cache in `kv_meta` for cron jobs). For a custom domain with `workers_dev: false`, EU jurisdiction and Cloudflare Email Routing, `env.production` holds `${PULSE_*}` placeholders filled by `scripts/deploy-config.mjs` from `.env.deploy` or Cloudflare build variables (`npm run deploy:custom`). Optional pieces (Access, alert sender and destination, account id, the ops bucket) are dropped from the rendered config when their variable is empty.

### D1 binds JS numbers as REAL
`(ts - ?) / 60000` returns fractional minutes on D1 because the bound number arrives as REAL, while node:sqlite binds integers as INTEGER. Integer arithmetic on bound parameters must use `CAST(... AS INTEGER)`. The workerd integration tests and the e2e suite catch this class of difference; the Node unit tests don't.

### Five cron triggers
A Worker gets five cron triggers. Finer schedules (10-minute ingest snapshot, hourly salt cleanup and database sizes, scheduled reports at a local hour) are derived inside the `*/5` trigger from the current minute and hour.

## Privacy

### A daily visitor hash, salts deleted with their day
`visitor_id` is an HMAC of `site | IP | user agent` under a random salt per local day of the site's time zone. The salt is deleted once that day is over (at most about 25 hours after it starts, never later than 48 h), so ids can't be linked across days or reversed. Using the site's local day rather than UTC means a visitor isn't split in two at UTC midnight and matches the days reports count in. The cost: "visitors" over several days counts visitor-days, and retention is same-day only. The IP is used for the hash and the rate-limit key and then dropped before the queue.

### Exclusions and drops are counted, not silent
Hits dropped by a site's own rules (paths, hostname globs, countries, referrers), by hosting-network filtering, by Do Not Track or by the daily cap are counted per reason in `ingest_stats`, and revenue sent in a currency other than the site's `revenue_currency` is removed from the event and counted. The installation check and `ingest_drops` can then explain a gap instead of leaving it a mystery.

## Ingest

### Drop counters in isolate memory
Rejected hits (invalid body, unknown site, rate limited, bot, wrong host, excluded) don't write D1 per request: counters are kept in isolate memory and flushed in one batch at most once a minute per isolate (`src/worker/ingest/stats.ts`). A flood of junk costs no D1 writes. Drop counts are approximate (an evicted isolate loses what it held); `accepted` is exact because the queue consumer writes it.

### Rate limits by IPv6 /64
The ingest rate limit (120 hits a minute per site and client) keys IPv6 clients by their /64 prefix (`src/worker/lib/ip.ts`): a single subscriber usually holds a whole /64 and could otherwise rotate addresses. The visitor hash still uses the full address.

### A fixed daily event cap per site
`settings.daily_event_cap` (default 200000, 0 = off): once a site has accepted that many events in a UTC day, its hits are dropped before the queue until midnight UTC and one email goes out. Each isolate reads today's accepted counts at most once a minute and adds what it queued since, so the check costs no D1 read per hit and may overshoot by up to a minute of traffic. A fixed number rather than a multiple of recent traffic: it needs no history and can't be gamed by slowly ramping a flood.

## Reading

### Every number comes from one query engine
Every read endpoint, MCP tool, alert and report is a preset over `src/worker/query` (AGENTS.md rule 7), which aggregates per session first and then per dimension. Summary, timeseries, breakdowns and reports therefore always agree.

### Daily rollups inside the engine, exact
Re-reading raw events for every metric of a range overloaded D1 (docs/PERFORMANCE.md). Reads now come from `stat_days` (`src/worker/query/rollup.ts`) whenever a rollup answers the query exactly: no filters, a stored goal or none, local days (not 24h/last_minutes, not UTC), and zero or one stored dimension (or weekday × hour). Everything else reads raw events.
- Exact, not approximate: each row stores the additive parts of every metric plus the part that continues from the day before, so a session or visitor that crosses local midnight is counted once over a range, like the raw engine. This holds because sessions end after 30 idle minutes and visitor ids rotate daily. Chosen over counting multi-day visitors from `sessions` (still a scan per query) and over accepting a small overcount near midnight.
- Closed days (90 minutes after local midnight) are final; today and, until it closes, yesterday are rebuilt by the 5-minute cron. Fresh rows (under 15 minutes old) are used as they are; if the cron stalls, the read computes the missing days from raw events in the same statement, so a stall costs speed, never correctness. Imports and data deletion reset the watermark; retention deletes a day's rows with its raw events.
- Goal conversions are stored per goal definition (`<id>#<hash>`), so an edited goal rebuilds only its own rows and reads raw events until they catch up.
- `test/unit/rollup.test.ts` runs 220+ query shapes over generated data and checks rollup = raw.

### One statement per view
`runMerged` joins many query plans into one D1 statement and splits the result, so a whole site view (`/overview`), the sites summary and insights each cost one round trip, and responses go through the Cache API keyed by the query and the rollup watermark.

### Query language details
`matches` / `not_matches` compile `*` globs to `LIKE … ESCAPE` (everything else literal); `is_one_of` is an alias of `is`. The `goal` filter dimension keeps sessions that converted on a goal of the same site (ids resolved per site before building SQL). `compare` takes explicit days. Funnels have `step_order: strict` (any other pageview between steps ends the run), a comparison period and a breakdown by a session dimension.

### The `pulse_ingest` check walks an existing index
"Latest live event" walks the `events_site_ts (site_id, ts)` index backwards per site (`ORDER BY ts DESC LIMIT 1`) instead of scanning `events`. Chosen over a new `(source, ts)` index, which would add a write to every insert. The check is adaptive by default: silence alerts only when the same hours of the last 7 days usually had at least 3 events, so a quiet site at night isn't reported as down.

## Configuration as data
Sites, goals, funnels, status checks, notification channels, reports and ops settings (which databases are backed up and drilled, the size warning) are rows edited in the dashboard, REST or MCP. The code holds no site ids, database names, time zones or emails. Sites are added by people: `POST /sites` needs only domains (normalized, the id derived from the first one); `DELETE` archives and `purge=true` (admin) deletes everything. Migrations may seed defaults, but they must work on a fresh install where no particular site exists.

## Sign-in and access

### Cloudflare Access for the dashboard
The dashboard signs people in with a one-time code by email through Cloudflare Access, which guards only `/auth/access`; the Worker verifies the Access JWT (signature, audience, issuer, expiry) and creates its own session. Pulse stores no passwords and sends no sign-in mail itself, and the tracker, API keys and MCP never touch Access. Allowed: the `ACCESS_EMAILS` secret (they become owners on first sign-in, so a new install has someone who can sign in) or any enabled person an admin added in Settings → People, so adding someone needs no config change. The Access policy still decides who may request a code. Passkeys and invite links were removed to keep a single sign-in path.

### Roles and grants are re-checked on every request
Roles are owner, admin and viewer; viewers can be limited to sites. OAuth grants (MCP connectors) freeze scopes and sites at consent, so `/mcp` intersects them with the user's current role and site access on every request (`narrowToUser`) and answers 401 when no site is left. Refresh tokens last 30 days, so a connector is re-approved monthly.

### API keys bypass the OAuth provider
`pulse_sk_` bearer tokens are routed to the app before `OAuthProvider`, so keys and OAuth tokens both work on `/mcp` without the provider's external-token hook. Keys, sessions, share tokens and heartbeat tokens are stored only as SHA-256 hashes.

### Sign-in redirects stay on Pulse
`next` on `/login` and `/auth/access` must resolve to a path on Pulse's own origin; backslashes, whitespace and control characters are refused (browsers read `/\` as `//host`). One rule, `sameOriginPath`, in the Worker (`src/worker/lib/url.ts`) and the dashboard.

### Share links
A share link is read-only and limited to one site. Bound to a saved view, it carries the view's filters in its principal and `filterClauses` appends them to every query (the one place every report's filters pass through), so a viewer can narrow but never widen; reports that ignore filters (realtime, retention) refuse such links, and a deleted view stops the link rather than showing everything. `embed_origins` (https origins only) replaces `frame-ancestors 'none'` for that link's page; every share page is `noindex`. Passwords use PBKDF2-SHA256 (16-byte salt, 100000 iterations, the most Workers' WebCrypto allows); only wrong passwords count against the link's rate limit, and 20 a minute lock it for a minute.

### Other hardening
- Admin-defined globs (excluded paths and hostnames, funnel and goal paths) use a linear-time matcher instead of a RegExp, so a visitor's long path can't make a glob with many stars backtrack.
- `d1_query` checks blank every string, quoted identifier and comment in one pass before looking for write keywords, so a quote inside another kind of quote can't hide a `DELETE`. They need `admin`, because the ops token can read every D1 database in the account.
- OAuth client registration, `/mcp` and `/hb/:token` are rate limited on the same bindings as the API.

## Agents

### Stateless MCP on the SDK's web-standard transport
`@modelcontextprotocol/sdk` ships `WebStandardStreamableHTTPServerTransport`, which runs on Workers. A fresh server per request (no session ids) avoids Durable Objects; `GET`/`DELETE` answer 405.

### A capability catalog keeps agents in step with features
Every REST operation and MCP tool is listed in `src/worker/catalog.ts` with its scope; `test/unit/catalog.test.ts` fails when one is missing, when scopes disagree, or when the docs don't mention it (AGENTS.md rule 9). MCP tools are registered only when the key has their scope, so `tools/list` is exactly what an agent can do, and `whoami` lists what is locked and which scope unlocks it.

### API keys can't be created over MCP
Creating or rotating an API key returns a secret. An agent reads attacker-controlled text all day (page titles, referrers, event properties), so a prompt injection must never be able to mint a credential: keys are created and rotated only in the dashboard or over REST. Destructive MCP tools take a confirmation instead: `delete_data` returns a `confirm_token` from a dry run, and purging a site needs its id as `confirm` and `admin`.

### Changing the backup lists needs `admin`
`ops:write`, which an OAuth connector can hold, manages checks and the size warning but can't change `backup_databases` or `drill_databases` (sending the current lists back unchanged is allowed), so a connector can't switch backups off.

## Backups

### Two copies, retention-locked keys
Every Sunday Pulse writes its own tables as NDJSON to `pulse-backups` (12 weeks) and exports each chosen D1 database as SQL to `ops-backups` (84 days). The buckets are meant to carry retention locks (no overwrite or delete for 30 days), so writers never reuse a key: `<date>`, then `<date>T<HHMM>`, then `<date>T<HHMMSS>` (`src/worker/lib/backupkeys.ts`). Readers (restore drill, pruning) parse every shape, and pruning logs, rather than fails on, a delete a lock refuses. A database chosen for backup that no longer exists is listed as `missing`, a settings problem rather than a failed backup.

### Streaming, and why the drill isn't
Both writers stream rows (or the D1 export download) through gzip into an R2 multipart upload in 8 MiB parts, so memory holds one page and one part; `limits.cpu_ms` is 300000 for these jobs. The restore drill still loads one decompressed export into memory: the D1 import API takes one file with an MD5 of the whole, and the reorder that makes exports importable needs every table's rows. Pulse's own database isn't in the default drill list for that reason (note in `src/worker/lib/settings.ts`); its backups are still checked for age daily.

### The drill compares against the backup
Live tables change after the weekly backup, so the monthly drill checks that every source table exists in the restore, that its row count equals the export's, and that a checksum of its first 20 rows (parsed from the export's `INSERT` literals) matches the restored copy. Rows written with SQL functions (`replace(…)`, `unistr(…)`) leave their table `unchecked` instead of failing.

### Freshness is read from the buckets
A daily job lists the buckets themselves (not Pulse's own record of the last run) and emails when the newest backup of any chosen database, or the newest NDJSON folder, is older than 8 days or missing, at most once a day.

## Notifications and reports

### Email only for errors by default
`email_only_errors` (ops settings, on by default): email goes out for new JavaScript errors and for failed or stale backups, because losing backups silently is worse than one more email. Traffic, event and no-data alerts, status checks and the size and ingest warnings stay visible in Pulse and still reach non-email channels. Scheduled reports are opt-in schedules, so they bypass the switch.

### The digest is a scheduled report
Reports are weekly or monthly summaries of chosen sites with chosen sections, sent through notification channels; email gets an HTML layout with a plain-text twin, chat channels get the text. The `*/5` trigger sends due reports, claimed per period with a conditional UPDATE before they're built, so a report goes out at most once per period; manual sends don't count against the schedule, and site-scoped principals never see the ops section.

### Report previews have their own page
The dashboard CSP forbids inline styles, and a `srcdoc` iframe inherits it, so the email preview is served from `/reports/:id/preview` (session cookie, `stats:read`, site-scoped) with a CSP that allows inline styles only and `frame-ancestors 'self'`.

### Channel secrets are encrypted
Webhook URLs and bot tokens for Slack, Discord, Telegram, ntfy and webhook channels are encrypted with `PULSE_SECRET_KEY` before they're stored, and the API shows only safe hints of them.

## Dashboard

### Favicons through Pulse
Referrer favicons come from `/icons/favicon/{host}` (`src/worker/web/favicon.ts`), outside `/api/v1`: `<img>` tags can't send the `X-Pulse-Client` header the API requires of cookie sessions, so the route checks the session cookie itself (images over GET carry no CSRF risk). The Worker fetches the icon from the host, so no third-party icon service learns your referrers, and caches hits a week and misses a day. Well-known brands use bundled simple-icons logos and never hit the route.

### Visual system
See docs/DESIGN.md.

## Development

### Unit tests and the dev server run the real Worker in Node
workerd doesn't run everywhere (for example on some Windows machines). `node:sqlite` behind a small D1 shim runs the actual query engine, ingest, consumer, REST, MCP and OAuth flows in Vitest, and `scripts/dev/server.ts` puts the same Worker behind an HTTP server with a file database, demo data and a dev-only `/__dev/login`. `cloudflare:*` imports resolve to test stubs through Node module hooks (`scripts/dev/register.mjs`). The workerd integration tests (`@cloudflare/vitest-plugin`) run in Workers Builds and catch the remaining differences.

### Batch history import
`POST /api/v1/admin/import` supports idempotent batch upserts of historical sessions and events (marking imported rows with their `source`), and `sites.legacy_ids_json` / `ingest_stats.legacy_hits` remain in the schema for compatibility.

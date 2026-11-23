# Operations

A runbook for a running Pulse deployment. Setting one up is in [SELF-HOSTING.md](SELF-HOSTING.md). Examples use `pulse.example.com`; your domain is `PULSE_DOMAIN`.

## Deploys

Production is the only deployed environment; there is no staging. Test locally (`npm run dev`, the unit tests), then deploy.

```sh
npm run build          # dashboard → dist/public, tracker → dist/public/p.js
npm run deploy         # render wrangler.deploy.jsonc, apply D1 migrations, wrangler deploy --env production
node scripts/smoke.mjs production
```

`npm run deploy` runs `node scripts/deploy-config.mjs` (fills the `${PULSE_*}` placeholders of `wrangler.jsonc` from the environment or `.env.deploy` and writes the git-ignored `wrangler.deploy.jsonc`), then `wrangler d1 migrations apply pulse --remote -c wrangler.deploy.jsonc --env production` and `wrangler deploy -c wrangler.deploy.jsonc --env production`. `npm run deploy:config` renders the config alone, to inspect it. The variables are listed in [SELF-HOSTING.md](SELF-HOSTING.md#deploy-variables).

The Worker answers only on its custom domain: `workers_dev` and `preview_urls` are off, so there is no `*.workers.dev` URL; smoke tests, e2e and deploy annotations all use the custom domain.

Roll back: `npx wrangler rollback -c wrangler.deploy.jsonc --env production` (the previous Worker version; migrations are not rolled back, so they are always additive).

### Continuous deploy (Workers Builds)
| Setting | Value |
|---|---|
| Branch | `main` (preview builds off) |
| Build command | `npm ci && npm run typecheck && npm run lint && npm test && npm run test:integration && npm run tracker:size && npm run build` |
| Deploy command | `npm run deploy && node scripts/smoke.mjs production && node scripts/annotate-deploy.mjs` |

Build variables (Worker → Settings → Builds → Variables and secrets). For an existing deployment they can be left out: `npm run build` in Workers Builds (`deploy-config.mjs --ci`) reads missing values from the deployed Worker's bindings and fills `wrangler.jsonc` in the build's checkout, so `npx wrangler deploy --env production` works as a deploy command too.
- The deploy variables (`PULSE_DOMAIN`, `PULSE_D1_ID`, `PULSE_KV_ID` and any optional ones).
- `SMOKE_KEY_PRODUCTION` (secret): a `stats:read` key limited to the hidden `pulse-smoke` site; without it the smoke test skips its API and MCP checks. Without `PULSE_DOMAIN` it skips entirely.
- `PULSE_ANNOTATE_KEY` (secret, `annotations:write`), `PULSE_SITE` (site ids, comma-separated, or `*`), `PULSE_REPO` (`owner/name` on GitHub, for the commit link): `scripts/annotate-deploy.mjs` adds a "deployed" annotation; `PULSE_ORIGIN` overrides `https://$PULSE_DOMAIN`. Without the key no annotation is written; it never fails the deploy.

A failed build or smoke test leaves the previous version live.

Worker secrets (`ACCESS_EMAILS`, `ALERT_EMAIL`, `PULSE_SECRET_KEY`, `PULSE_OPS_TOKEN`) are set with `npx wrangler secret put <NAME> -c wrangler.deploy.jsonc --env production`, typed at the prompt or piped from a file, never echoed into logs or shell history.

## Admin CLI
Runs SQL against the production database through `wrangler d1 execute --remote`, using the rendered deploy config (so the `PULSE_*` variables must be set). Secrets it creates are written to `.data/`, never printed.
```sh
npm run admin -- site:create --id example --name Example --domains example.com --env production
npm run admin -- key:create --name claude-code --scopes stats:read,annotations:write --env production   # → .data/keys.env
npm run admin -- session --label e2e --ttl 1h --env production  # cookie value → .data/session-production-e2e.txt
npm run admin -- session:delete --label e2e --env production    # always clean up
npm run admin -- keys --env production
```
`npm run admin` with no command lists them all. People sign in with a Cloudflare Access one-time code: the `ACCESS_EMAILS` addresses (owners on first sign-in) and anyone an admin adds in Settings → People.

## Local full stack (no workerd needed)
```sh
npm run dev:seed      # .data/dev.sqlite: demo-shop, demo-blog, pulse-smoke with ~120 days of traffic, goals, a funnel, checks
npm run build         # the dev server serves dist/public
npm run dev           # Node dev server on :8787 (the real Worker, node:sqlite D1) + Vite on :5173 with HMR
```
Open http://localhost:5173/__dev/login (or :8787). `PULSE_E2E_ORIGIN=http://localhost:8787 npx playwright test` runs the e2e suite against it (the seed writes the session to `.data/session-local-e2e.txt`). `node scripts/dev/shoot.mjs <label> [paths…]` saves screenshots at 1440/390 px, light/dark, and reports console errors and horizontal overflow (in Git Bash prefix `MSYS_NO_PATHCONV=1`). Cron jobs run every 5 minutes in the dev server; ops jobs needing `PULSE_OPS_TOKEN` report that it's missing.

## Local runs and tests against production
`npx wrangler dev` runs the Worker on http://localhost:8787 from the top-level (local-only) config in `wrangler.jsonc`: simulated D1/Queues/KV/R2, `ENVIRONMENT=development`, the tracker fixture page `/__e2e/fixture` on. It needs workerd. Apply migrations locally first with `npx wrangler d1 migrations apply pulse-local --local`. `npm run dev:dashboard` proxies `/api` and `/auth` to it.
```sh
node scripts/smoke.mjs production                                # https://$PULSE_DOMAIN
npm run admin -- session --label e2e --ttl 1h --env production && PULSE_E2E_ORIGIN=https://pulse.example.com npx playwright test && npm run admin -- session:delete --label e2e --env production
PULSE_E2E_KEY=… npx playwright test -g tracker   # fixture test, local only (default origin http://localhost:8787)
node scripts/loadtest.ts ingest --hits 50000 --minutes 5      # local wrangler dev only, never production
node scripts/loadtest.ts seed --events 1000000 --months 12 && node scripts/loadtest.ts read   # key: --key-var (default PULSE_KEY_ADMIN_SEED_LOCAL)
```
The ingest load test comes from one IP, so the 120/min per-IP limiter drops most hits by design: "all counted" means `accepted + dropped_rate` in `ingest_stats` equals the number sent, with no 5xx and an empty DLQ. Drop counters are written at most once a minute per isolate, so wait a minute and send one more hit before comparing (and allow for a small shortfall if an isolate was evicted).

## Crons (five triggers)
| Cron (UTC) | Jobs |
|---|---|
| `*/5 * * * *` | status checks, scheduled reports, rollups; every 10 min ingest snapshot; at :05 salts + cleanup and D1 sizes with the size warning |
| `0 3 * * *` | retention rollups; check results older than 90 days deleted; backup age check |
| `0 4 * * SUN` | Pulse NDJSON backup → `pulse-backups`; D1 SQL exports → `ops-backups` |
| `0 5 1 * *` | restore drill into the scratch D1 database `restore-drill` |

Ops jobs (checks, alerts, reports, backups, drill) run only in production. Run any job now: `POST /api/v1/ops/run {"job": "monitors|db_sizes|ops_backup|restore_drill|digest|pulse_backup|retention"}` with an admin key.

## Status checks
Everything that is checked lives in the `monitors` table and is edited on `/status` (Add check, or click a check → Edit / Check now / Pause / Delete), over REST (`/api/v1/ops/monitors…`, scope `ops:write`) or MCP (`save_check`, `run_check`, `pause_check`, `delete_check`). Nothing about a site's checks is in code. A fresh install starts with "Pulse healthz" and "Pulse ingest lag".

| Kind | Checks | Notes |
|---|---|---|
| `http` | status (`200`, `200-299`, `200,301`), keyword present/absent, response time | `self:/path` targets Pulse itself |
| `json` | a value at a path: exists, non-empty, equals, or a recent date | `json_nonempty` is the older form |
| `heartbeat` | your job calls `/hb/<token>` at least every `period_min` + grace | the URL is shown once; "New ping URL" issues another |
| `d1_query` | a read-only `SELECT` on a D1 database returns `ok` = true; `:today` = local date | admin only (the ops token reads every D1 database); needs `PULSE_OPS_TOKEN` |
| `pulse_ingest` | live events arrived within `max_lag_min`, overall or for one site | adaptive by default: silence alerts only when the same hours of the last 7 days usually had ≥ 3 events |
| `dns` | a record resolves (and contains a value), via DNS over HTTPS | |
| `domain_expiry` | RDAP expiry date is more than `warn_days` away | runs daily; some ccTLDs publish no RDAP data |

Each check has an interval (5 min to daily), "alert after N failures", an optional "slow above" threshold (marks it degraded, no alert), email on/off, and a pause. Not possible from a Worker: TLS certificate expiry (`fetch` doesn't expose the certificate), multi-region checks, DNS/TLS timing breakdowns.

## Monitoring and alerts
`/status` in the dashboard, `GET /api/v1/ops/status`, `GET /api/v1/health`. Alert and report emails go to `ALERT_EMAIL` (a verified Email Routing destination) from `PULSE_ALERT_FROM`, or `alerts@<your Pulse domain>` when it isn't set; the sender's domain must have Email Routing on. By default email is sent only for errors (new JavaScript errors, failed or stale backups; `email_only_errors` in Settings → Backups); everything else still reaches Slack, Discord, Telegram, ntfy and webhook channels. Test a channel with Settings → Notifications → Test, or test an alert by adding a check for a 404 URL with "alert after 1", clicking "Check now", then deleting it.

## Ops settings (no code changes)
Settings → Backups (or `PATCH /api/v1/ops/settings`): which D1 databases are exported every Sunday and restored in the monthly drill (changing those lists needs `admin`, so an `ops:write` key or connector can't switch backups off), the D1 size warning and email-only-errors. A fresh install backs up `pulse` and drills nothing.

Settings → Reports (or `/api/v1/ops/reports`, MCP `save_report`): scheduled summaries, weekly or monthly, at a local hour, for chosen sites (or every site with "Include in reports"), with chosen sections and optionally the ops status, sent to chosen notification channels. A fresh install has the report `weekly-digest` (UTC; change its time zone there). Reports are sent from the 5-minute cron when the local day and hour match, at most once per period; Preview shows the email without sending, Send now sends it.

## Sites (no code changes)
Add a site at `/add-site` (or `POST /api/v1/sites` with just `domains`, or MCP `save_site`): Pulse derives the id, returns the snippet and checks the installation (`/install-check`: last pageview, dropped hits by reason, the snippet on the home page, a blocking CSP). Per-site settings (domains, time zone, retention, what to collect, kept query parameters, site search parameters, ignored paths and hostnames, blocked referrers and countries, revenue currency, daily event cap, internal flag, inclusion in reports, alerts, share links, short links) are on the site's settings page. Archive stops collection; delete removes all data (admin).

## Backups and restore
- `pulse-backups/<env>/<stamp>/<table>.ndjson.gz` (12 weeks) and `ops-backups/<db>/<stamp>.sql.gz` (84 days). `<stamp>` is the UTC date of the run. Writers never overwrite: a second run on the same day writes `<date>T<HHMM>` (then `<date>T<HHMMSS>`), so the buckets can carry retention locks (recommended: 30 days, no overwrite or delete, on `production/` in `pulse-backups` and on each database's prefix in `ops-backups`; R2 → bucket → Settings → Bucket lock rules). The drill and pruning read every key shape; "latest" is the greatest key.
- Both writers stream: rows (or the D1 export download) go through gzip into an R2 multipart upload in 8 MiB parts, so memory holds one page and one part, not a whole table or database. The Worker's CPU limit is 5 minutes per invocation (`limits.cpu_ms` in `wrangler.jsonc`, Workers Paid) for these jobs.
- SQL exports need `PULSE_OPS_TOKEN` (D1 Edit + Account Settings Read) and the `ops-backups` bucket (`PULSE_OPS_BACKUPS=false` drops it). A database chosen in Settings → Backups that no longer exists in the account is listed as **missing**, separately from failed backups.
- D1 Time Travel covers the last 30 days; restoring a SQL backup needs a reorder first. Both are in [Disaster recovery](#disaster-recovery) below.
- The monthly drill restores the newest SQL backup of each `drill_databases` entry into the scratch database `restore-drill` and compares, per table, the row count and a checksum of the first 20 rows with the export (tables whose export rows use SQL functions are listed as `unchecked`); its result is in `/api/v1/ops/status` and in reports with ops included. `pulse` isn't drilled by default (see the note on `drill_databases` in `src/worker/lib/settings.ts`: memory). The drill decodes the export in the Worker's 128 MB, so a backup over 5 MB compressed (`DRILL_MAX_GZ_BYTES`) is skipped and listed as "not drilled" on the status board; the off-site copy's SQLite restore test covers those. A database deleted from the account is listed as missing, not as a failed backup.
- Alerts by email: a failed or partial weekly backup, a failed drill (cron runs only; `/ops/run` shows the result instead), and, checked daily at 03:00 from the buckets themselves, any backed-up database (and Pulse's NDJSON backup) whose newest backup is older than 8 days or missing (at most one email a day).

### Off-site copy (GitHub Actions)
`.github/workflows/offsite-backup.yml` copies the newest backups out of Cloudflare every Sunday at 06:30 UTC into a GitHub Actions artifact kept 90 days, after a test restore, so a compromised Cloudflare account or deploy token can't delete every copy. It skips with a notice until configured:

| Name | Kind | Value |
|---|---|---|
| `R2_BACKUP_READ_TOKEN` | repository secret | an account API token with only "Workers R2 Storage: Read" |
| `CF_ACCOUNT_ID` | repository variable | your Cloudflare account id |
| `OFFSITE_DATABASES` | repository variable, optional | space-separated databases backed up to `ops-backups` (the list in Settings → Backups); default `pulse` |
| `OFFSITE_REQUIRED` | repository variable, optional | tables that must not be empty after the test restore, as `db:table,table db2:table`; default `pulse:events,sites,users` |
| `R2_JURISDICTION` | repository variable, optional | `eu` (default), `fedramp` or `none`, the same as `PULSE_JURISDICTION` |

Keep the repository private if its artifacts hold your backups, or run the workflow from a private fork.

## Disaster recovery
Every command below runs against production from your machine (`-c wrangler.deploy.jsonc --env production` / `--remote`; run `npm run deploy:config` first). Do them by hand, one at a time, and read the output.

**1. Stop the damage first (kill switches).**
| What | How | Undo |
|---|---|---|
| Bad deploy | `npx wrangler rollback -c wrangler.deploy.jsonc --env production` (previous version) | deploy again |
| One site flooded with junk | lower its **Daily event cap** (site settings or `PATCH /api/v1/sites/{site}` `{"settings":{"daily_event_cap":1}}`): its hits are dropped until 00:00 UTC; or block the referrers, countries, paths or hostnames | raise the cap (`0` = no cap); takes effect within a minute |
| Stop collecting a site entirely | archive it (`DELETE /api/v1/sites/{site}`, no `purge`) | restore it |
| A key or connector misbehaving | revoke the key (Settings → API keys) or the connected app (`revoke_connected_app`) | issue a new one |
| A noisy check | pause it on `/status` | resume |
| Ingest backlog hurting D1 | `npx wrangler queues pause-delivery pulse-events` (hits stay queued, nothing lost for up to the queue's retention) | `npx wrangler queues resume-delivery pulse-events` |
| Abuse from many IPs | a WAF rate-limiting rule on `pulse.example.com/e` in the Cloudflare dashboard (the Worker's own limits are per client and per site) | delete the rule |

**2. Undo recent damage to a D1 database with Time Travel (last 30 days).** Time Travel restores **in place**: everything written after the chosen moment is gone, including good data. Export first so nothing is lost for good:
```sh
npx wrangler d1 export pulse --remote -c wrangler.deploy.jsonc --env production --output pre-restore-$(date -u +%Y%m%dT%H%M).sql
npx wrangler d1 time-travel info pulse -c wrangler.deploy.jsonc --env production --timestamp 2026-01-15T09:00:00Z     # shows the bookmark for that moment
npx wrangler d1 time-travel restore pulse -c wrangler.deploy.jsonc --env production --timestamp 2026-01-15T09:00:00Z  # prints the bookmark to undo the restore
```
Keep the "previous bookmark" it prints: `time-travel restore … --bookmark <it>` undoes the restore. For another database you back up, use its name with the wrangler config of the project that owns it.

**3. Rebuild a database from a weekly export in R2 (older than 30 days, or the database is gone).** Restore into a **new** database, check it, then switch over:
```sh
npx wrangler r2 object get ops-backups/<db>/<stamp>.sql.gz --jurisdiction eu --remote --file backup.sql   # newest <stamp> = greatest key; plain SQL (stored with Content-Encoding: gzip, wrangler decodes it)
npm run restore:order -- backup.sql restore.sql     # CREATE TABLEs first, parent rows before child rows; prints row counts per table
npx wrangler d1 create <db>-restored --jurisdiction eu
npx wrangler d1 execute <db>-restored --remote --file restore.sql
npx wrangler d1 execute <db>-restored --remote --command "SELECT COUNT(*) FROM <a big table>"   # compare with the counts printed above
```
Use the jurisdiction you deployed with (`PULSE_JURISDICTION`; drop `--jurisdiction` for `none`). The reorder is required: D1 exports tables in creation order and imports in batches, so a raw export of a database whose tables were rebuilt by later migrations fails with "no such table" and then a foreign key violation. To switch Pulse over, set `PULSE_D1_ID` to the new database's id and run `npm run deploy`; for another database, point its own Worker's `d1_databases` entry at the new id. Keep the old database until the new one has run for a while. For Pulse, `ops-backups/pulse/` (SQL) is the restorable copy; `pulse-backups/production/<stamp>/<table>.ndjson.gz` is a second, table-by-table copy for reading or partial repair, not a one-command restore. With retention locks on, backup objects can't be overwritten or deleted by mistake during an incident.

## Queue and DLQ
The consumer runs at most 3 batches of 100 at once (`max_concurrency`; the DLQ consumer 1), so a backlog drains at a bounded D1 write rate instead of scaling out. Hits that fail 5 times go to `pulse-events-dlq`; its consumer retries once and records the count in `kv_meta.dlq_depth` (visible in `/health`).

# Run your own Pulse

> **Fastest option — 1-click Deploy to Cloudflare:** [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pablobravo44/pulse-analytics-cloudflare)
> Cloudflare automatically clones this repo, provisions D1, Queues, KV and R2, runs migrations and deploys Pulse to `https://pulse.<your-subdomain>.workers.dev` (requires **Workers Paid**, $5/mo).
>
> **Want an AI coding agent to deploy and connect your sites?** Point Claude Code, Codex, or Cursor at [AGENT-SETUP.md](AGENT-SETUP.md).

Pulse is one Cloudflare Worker with a D1 database, a queue, a KV namespace and R2 backups. Below is the full step-by-step guide for a **custom-domain, EU-pinned deployment** (`npm run deploy:custom`). For a quick `workers.dev` install, just click the Deploy button above (or run `npm ci && npm run build && npm run deploy`), then jump straight to [step 6 (Secrets)](#6-secrets) and [step 7 (First steps)](#7-first-steps-after-deploy).

Your custom-domain values (domain, resource ids, email addresses) never go into the repository: `env.production` in `wrangler.jsonc` holds `${PULSE_*}` placeholders that `npm run deploy:custom` fills from your environment or a git-ignored `.env.deploy` file. That keeps your fork free of merge conflicts when you pull upstream changes.

## What you need

- A Cloudflare account on **Workers Paid** ($5/month). Queues (the ingest buffer) and the 5-minute CPU limit of the backup jobs need it.
- A domain whose DNS is on Cloudflare. Pulse gets a hostname on it, for example `pulse.example.com`; Cloudflare creates the DNS record and certificate on the first deploy.
- Node 22 or newer and git.
- Optional, for alert emails: **Email Routing** enabled on that domain (Email → Email Routing) with the address that should receive alerts added and verified under Destination addresses.

## 1. Get the code and log in

```sh
git clone <your fork of this repository> pulse
cd pulse
npm ci
npx wrangler login
npx wrangler whoami          # note your account id
```

## 2. Create the resources

```sh
npx wrangler d1 create pulse --jurisdiction eu                # prints the database_id → PULSE_D1_ID
npx wrangler queues create pulse-events
npx wrangler queues create pulse-events-dlq
npx wrangler kv namespace create OAUTH_KV                     # prints the id → PULSE_KV_ID
npx wrangler r2 bucket create pulse-backups --jurisdiction eu
npx wrangler r2 bucket create ops-backups --jurisdiction eu   # optional: SQL exports of D1 databases (step 7)
```

The names `pulse`, `pulse-events`, `pulse-events-dlq`, `pulse-backups` and `ops-backups` are fixed in `wrangler.jsonc`; keep them.

**Jurisdiction.** `eu` keeps the data in the EU. For no jurisdiction, drop `--jurisdiction eu` from every command and set `PULSE_JURISDICTION=none`; for FedRAMP use `fedramp` in both places. Use the same choice for D1 and R2: the R2 jurisdiction in the deploy config must match the one the buckets were created with.

**Optional extras** (can be added later):
- `npx wrangler d1 create restore-drill --jurisdiction eu`: the scratch database the monthly restore drill writes into. Without it the drill reports "scratch database restore-drill not found"; it only runs for databases you add to the drill list (step 7).
- Bucket lock rules on the backup buckets (R2 → bucket → Settings → Bucket lock rules, for example 30 days on all objects), so backups can't be overwritten or deleted by mistake or by a stolen token. Pulse never reuses a backup key, so locks don't get in its way.

## 3. Sign-in with Cloudflare Access

The dashboard signs people in with a one-time code by email through Cloudflare Access (Zero Trust; the free plan covers up to 50 people). Access guards only the path `/auth/access`; the tracker, the API, API keys and MCP never go through it. Pulse verifies the token Access issues, then creates its own session.

1. Open **Zero Trust** (pick a team name if it's your first time). Your **team domain** is `<team>.cloudflareaccess.com` (Settings → Custom pages / Team domain). That is `PULSE_ACCESS_TEAM_DOMAIN`.
2. Under Settings → Authentication, make sure **One-time PIN** is an enabled login method.
3. Access → Applications → **Add an application → Self-hosted**. Application domain: `pulse.example.com`, path `auth/access`. Session duration as you like.
4. Add a policy with action **Allow** that includes the people who should be able to request a code: for example **Emails** (your address and anyone you'll add later) or **Emails ending in** `@example.com`. Pulse checks its own list on top of this, so a broad policy is safe; a narrow one means you edit it each time you add someone.
5. Save, open the application's overview and copy the **Application Audience (AUD) Tag**. That is `PULSE_ACCESS_AUD`.

Without these two variables the dashboard shows "Sign-in isn't configured on this server." The tracker, API and MCP work regardless.

## 4. Deploy variables

Copy [.env.deploy.example](../.env.deploy.example) to `.env.deploy` in the repository root (it is git-ignored) and fill in your values:

```sh
# Required
PULSE_DOMAIN=pulse.example.com            # hostname of the dashboard, API and tracker (no https://)
PULSE_D1_ID=00000000-0000-0000-0000-000000000000   # from `wrangler d1 create pulse`
PULSE_KV_ID=0123456789abcdef0123456789abcdef       # from `wrangler kv namespace create OAUTH_KV`

# Dashboard sign-in (step 3); both or neither
PULSE_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
PULSE_ACCESS_AUD=0123456789abcdef...

# Optional
PULSE_ACCOUNT_ID=0123456789abcdef0123456789abcdef  # your account id; needed if your login or ops token sees several accounts
PULSE_ALERT_FROM=alerts@example.com       # sender of alert and report emails, on a domain with Email Routing; default alerts@$PULSE_DOMAIN
PULSE_ALERT_TO=you@example.com            # pins the email binding to this one verified destination (should equal ALERT_EMAIL)
PULSE_JURISDICTION=eu                     # eu (default), fedramp or none; must match the buckets
PULSE_OPS_BACKUPS=true                    # false if you didn't create the ops-backups bucket
```

### Deploy variables

| Variable | Required | What it does |
|---|---|---|
| `PULSE_DOMAIN` | yes | Custom domain of the Worker (route, `PUBLIC_ORIGIN`, `RP_ID`) |
| `PULSE_D1_ID` | yes | `database_id` of the `pulse` D1 database |
| `PULSE_KV_ID` | yes | id of the KV namespace for OAuth (MCP connectors) |
| `PULSE_ACCESS_TEAM_DOMAIN`, `PULSE_ACCESS_AUD` | for sign-in | Cloudflare Access team domain and application AUD tag; dropped unless both are set |
| `PULSE_ACCOUNT_ID` | no | Sets `account_id` for wrangler and the `CF_ACCOUNT_ID` variable the ops jobs use when `PULSE_OPS_TOKEN` can see several accounts. `CLOUDFLARE_ACCOUNT_ID` also sets `account_id`, but not the ops variable |
| `PULSE_ALERT_FROM` | no | Sender address of alert and report emails |
| `PULSE_ALERT_TO` | no | Restricts the `send_email` binding to this address |
| `PULSE_JURISDICTION` | no | R2 jurisdiction: `eu` (default), `fedramp`, or `none` |
| `PULSE_OPS_BACKUPS` | no | `false` drops the `ops-backups` bucket binding |

Real environment variables win over `.env.deploy`. Check the result with:

```sh
npm run deploy:config     # writes wrangler.deploy.jsonc (git-ignored) or names the missing variables
```

## 5. First deploy

```sh
npm run build             # dashboard and tracker into dist/public
npm run deploy:custom     # deploy:config + D1 migrations + wrangler deploy --env production
```

`npm run deploy:custom` renders `wrangler.deploy.jsonc`, applies every migration in `migrations/` to the remote `pulse` database and deploys the Worker `pulse` on `pulse.example.com`. (If you used the 1-click Deploy button or `workers.dev`, use `npm run deploy` instead.) The first deploy can take a minute or two longer while Cloudflare issues the certificate for the custom domain.

Check it: `https://pulse.example.com/healthz` answers, and `PULSE_DOMAIN=pulse.example.com node scripts/smoke.mjs production` passes the checks that don't need a key.

## 6. Secrets

Set them on the deployed Worker. Each command asks for the value; nothing is written to disk or shell history.

```sh
npx wrangler secret put ACCESS_EMAILS -c wrangler.deploy.jsonc --env production      # you@example.com (comma-separated for several)
npx wrangler secret put ALERT_EMAIL -c wrangler.deploy.jsonc --env production        # where alert and report emails go (a verified Email Routing destination)
npx wrangler secret put PULSE_SECRET_KEY -c wrangler.deploy.jsonc --env production   # output of: openssl rand -base64 32
npx wrangler secret put PULSE_OPS_TOKEN -c wrangler.deploy.jsonc --env production    # API token, see below
```

| Secret | Needed for |
|---|---|
| `ACCESS_EMAILS` | Sign-in. These addresses become **owners** the first time they sign in. Add everyone else later in Settings → People |
| `ALERT_EMAIL` | Email alerts, backup failures and emailed reports. Without it nothing is emailed; other channels still work |
| `PULSE_SECRET_KEY` | Slack, Discord, Telegram, ntfy and webhook channels: their URLs and tokens are encrypted with it. 32 random bytes, base64 |
| `PULSE_OPS_TOKEN` | SQL backups of D1 databases, `d1_query` checks, the database size warning, listing database names in Settings → Backups |

`PULSE_OPS_TOKEN` is an API token (My Profile → API Tokens → Create token → Custom) with two permissions: **Account → D1 → Edit** and **Account → Account Settings → Read**, limited to your account. Pulse finds the account through the token; if the token can see several accounts, set `PULSE_ACCOUNT_ID`.

Changing a secret takes effect immediately; no redeploy needed.

## 7. First steps after deploy

1. **Sign in.** Open `https://pulse.example.com`, choose "Sign in with an email code", enter an `ACCESS_EMAILS` address and the code Access sends you.
2. **Add a site.** Add site → its domain. Pulse derives an id (`example.com` → `example`), shows the snippet and checks the installation:
   ```html
   <script defer src="https://pulse.example.com/p.js" data-site="example"></script>
   ```
   Put it in the site's `<head>`. If the site sends a Content-Security-Policy, add `https://pulse.example.com` to `script-src` and `connect-src`. Options and custom events: [TRACKER.md](TRACKER.md).
3. **People.** Settings → People → add someone by email with a role: **owner**, **admin** or **viewer** (viewers can be limited to some sites). They sign in with a one-time code; your Access policy must let their address request one (step 3).
4. **Agents.** Settings → API keys & agents: create a key with the scopes it needs, then for Claude Code:
   ```sh
   claude mcp add --transport http pulse https://pulse.example.com/mcp --header "Authorization: Bearer $PULSE_KEY"
   ```
   claude.ai and Claude Desktop connect through OAuth: add a custom connector with `https://pulse.example.com/mcp`, sign in and choose scopes and sites. API keys can be created only in the dashboard or over REST, never over MCP. See [MCP.md](MCP.md) and [API.md](API.md); `/docs` on your install documents the REST API and `/llms.txt` tells agents what they can do.
5. **Notifications.** Settings → Notifications: the email channel "Alert email" goes to `ALERT_EMAIL`; add Slack, Discord, Telegram, ntfy or webhooks (needs `PULSE_SECRET_KEY`) and press Test. By default only errors are emailed (new JavaScript errors, failed or stale backups); everything else still reaches the other channels.
6. **Status checks.** `/status` starts with "Pulse healthz" and "Pulse ingest lag"; add checks for your sites (http, keyword, JSON, heartbeat, DNS, domain expiry, D1 query).
7. **Reports.** Settings → Reports has a weekly digest in UTC; set its time zone, sites and channels, or delete it.
8. **Backups.** Pulse's own tables are written as NDJSON to `pulse-backups` every Sunday. With `PULSE_OPS_TOKEN` and `ops-backups`, Settings → Backups chooses which D1 databases (by default `pulse`) are exported as SQL every Sunday, and which are restored in the monthly drill (needs `restore-drill`). For a copy outside Cloudflare, see [OPERATIONS.md](OPERATIONS.md#off-site-copy-github-actions).
9. **Export.** In a site view, Export downloads the current report as CSV or the raw events as CSV or NDJSON (owners and admins).

## 8. Deploy on every push (Workers Builds)

1. Push your fork to GitHub or GitLab.
2. Workers & Pages → `pulse` → Settings → Builds → **Connect** the repository, production branch `main`, preview builds off.
3. Build command:
   ```
   npm ci && npm run typecheck && npm run lint && npm test && npm run test:integration && npm run tracker:size && npm run build
   ```
4. Deploy command:
   ```
   npm run deploy && node scripts/smoke.mjs production && node scripts/annotate-deploy.mjs
   ```
5. Build variables and secrets (same page): your `PULSE_*` deploy variables from step 4 (plain variables; none of them is a secret). Optional: `SMOKE_KEY_PRODUCTION` and `PULSE_ANNOTATE_KEY` (secrets), `PULSE_SITE`, `PULSE_REPO`; see below.

Each push then runs the tests, applies new migrations and deploys. A failing step leaves the previous version live.

Once Pulse is deployed, the build variables are optional: inside Workers Builds `npm run build` runs `node scripts/deploy-config.mjs --ci`, which reads any missing value back from the deployed Worker's bindings (with the build's own API token) and writes the filled config into the build's checkout. So a plain deploy command such as `npx wrangler d1 migrations apply pulse --remote --env production && npx wrangler deploy --env production` also works. Variables you do set always win.

**Smoke key (optional).** The smoke test's API and MCP checks read a hidden site `pulse-smoke`. Create it and a key for it from your machine:
```sh
npm run admin -- site:create --id pulse-smoke --name "Pulse smoke" --domains smoke.pulse.test --env production
npm run admin -- key:create --name smoke --scopes stats:read --sites pulse-smoke --var SMOKE_KEY_PRODUCTION --env production
```
Mark the site as internal in its settings so it stays off the board and reports, and copy the key from `.data/keys.env` into the `SMOKE_KEY_PRODUCTION` build secret.

**Deploy annotations (optional).** `PULSE_ANNOTATE_KEY` (a key with `annotations:write`), `PULSE_SITE` (site ids, comma-separated, or `*`) and `PULSE_REPO` (`owner/name`, for the commit link) add a "deployed" note to your charts.

## 9. Updating

```sh
git pull upstream main     # or merge upstream changes into your fork
npm ci
npm run build && npm run deploy
```

With Workers Builds, pushing the merge is enough. New migrations are applied by `npm run deploy` before the new code goes live; migrations only add, so rolling back the Worker (`npx wrangler rollback -c wrangler.deploy.jsonc --env production`) is safe. Read the commit log for new optional variables or secrets.

## Troubleshooting

**`deploy-config: missing PULSE_D1_ID, …`** A required variable isn't set in the environment or `.env.deploy` (in Workers Builds: the build variables).

**The dashboard says "Sign-in isn't configured on this server."** `PULSE_ACCESS_TEAM_DOMAIN`, `PULSE_ACCESS_AUD` or the `ACCESS_EMAILS` secret is missing. Set them and redeploy (variables) or just set the secret.

**Access shows its own "That account does not have access" page.** The Access policy doesn't include that email. Edit the policy (step 3).

**`403 {"error":{"code":"forbidden","message":"Cloudflare Access sign-in not accepted"}}`** Access let the person through but Pulse refused the token: the email is neither in `ACCESS_EMAILS` nor an enabled person in Settings → People, or `PULSE_ACCESS_AUD` / `PULSE_ACCESS_TEAM_DOMAIN` don't match the application (copy them again, without `https://`). `"user disabled"` means an admin disabled that person.

**No emails arrive.**
- `ALERT_EMAIL` must be a **verified** destination in Email Routing, and the sender (`PULSE_ALERT_FROM`, or `alerts@<PULSE_DOMAIN>`) must be on a domain with Email Routing enabled. If the default sender on a subdomain fails, set `PULSE_ALERT_FROM` to an address on the domain itself.
- If `PULSE_ALERT_TO` is set, it must be the same address as `ALERT_EMAIL`.
- Testing the email channel answers "email is not configured (SEND_EMAIL / ALERT_EMAIL)" when the secret is missing. Worker logs show `email_not_configured` for the same reason, and `email_skipped_not_error` for notices skipped because only errors are emailed (Settings → Backups).
- Email alerts and backups run only in production (`ENVIRONMENT=production`, which `npm run deploy` sets).

**Settings → Backups says "PULSE_OPS_TOKEN is not configured, so database names can't be listed", or a backup failed with "PULSE_OPS_TOKEN not configured".** Set the `PULSE_OPS_TOKEN` secret (step 6).

**Backup errors mentioning the account.** "CF API /accounts: 403; set CF_ACCOUNT_ID or give PULSE_OPS_TOKEN Account Settings Read": add that permission to the token, or set `PULSE_ACCOUNT_ID` and redeploy. "PULSE_OPS_TOKEN can see several accounts": set `PULSE_ACCOUNT_ID`.

**"OPS_BACKUPS binding missing".** You deployed with `PULSE_OPS_BACKUPS=false` but a SQL backup ran. Create the `ops-backups` bucket and redeploy without that variable, or leave the SQL backup list empty.

**A database is listed as "missing" in backups.** It is in Settings → Backups but doesn't exist in the account (renamed or deleted). Remove it from the list. This is separate from failed backups.

**"scratch database restore-drill not found".** Create it (step 2) or empty the drill list.

**A site shows no data.** Open the site's installation check. Findings name the cause: `csp_script` ("…'s Content-Security-Policy blocks loading https://pulse.example.com/p.js": add your Pulse origin to `script-src`), `csp_connect` (add it to `connect-src`), the snippet missing or pointing at another site id, or hits dropped because they came from a hostname that isn't one of the site's domains (add it), from a hosting network, or from excluded paths. Your own visits aren't counted while the `pulse_ignore` flag is set (the `#pulse-unignore` link removes it).

**Notification channel errors "PULSE_SECRET_KEY is not configured" / "must be 32 bytes, base64".** Set it from `openssl rand -base64 32`. Changing it later makes the stored channel secrets unreadable: re-enter them.

**Migrations fail in Workers Builds with an authorization error.** The build's API token needs D1 edit permission; edit the token Workers Builds uses (Settings → Builds → API token) or create one with Workers, D1, and the other resources' edit permissions.

## Cost

Everything runs on Workers Paid ($5/month, which includes a monthly allowance of requests, CPU time, D1 reads, writes and storage, Queues operations and KV). R2 storage up to 10 GB and Access up to 50 people are free. At the time of writing, and as a rough guide:
- Each pageview is one request to `/e`, one queue message (about three Queues operations: write, read, delete) and a few D1 row writes; engagement and web-vitals beacons add one or two more hits per pageview. The Queues allowance is usually the first one a busy install leaves; beyond it Queues are billed per million operations.
- The dashboard reads mostly from daily rollups, so D1 reads stay small (see [PERFORMANCE.md](PERFORMANCE.md)).
- Backups: gzipped NDJSON and SQL exports, kept 12 weeks and 84 days.

A few small sites with up to a few hundred thousand pageviews a month typically stay within the $5 plan. Check Cloudflare's current pricing pages for Workers, D1, Queues and R2 before relying on these numbers. The per-site daily event cap (default 200,000 events a day) protects you from a flood running up the bill.

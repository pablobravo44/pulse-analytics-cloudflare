# Deploy and connect Pulse with an AI agent

This playbook is written for coding agents (Claude Code, Codex, Cursor, or any MCP/shell agent) asked to **"deploy Pulse to my Cloudflare account and connect my websites."** Follow the steps in order. Never echo secrets, API keys, or tokens into chat or commit `.env.deploy` or `.data/`.

## What the agent handles vs. what needs the human

| Step | Who | Notes |
|---|---|---|
| Clone repo, install deps, verify Node ≥ 22 | Agent | `npm ci` |
| Authenticate Wrangler with Cloudflare | Human (once) | `npx wrangler login` (or provide `CLOUDFLARE_API_TOKEN` in env) |
| Create D1, Queues, KV, and R2 resources | Agent | Idempotent — list existing resources first before creating |
| Write `.env.deploy`, render config, build & deploy | Agent | `npm run build && npm run deploy` |
| Verify `/healthz` and create scoped API key | Agent | `npm run admin -- key:create …` writes to git-ignored `.data/keys.env` |
| Configure Worker secrets (`ACCESS_EMAILS`, `ALERT_EMAIL`, `PULSE_SECRET_KEY`, `PULSE_OPS_TOKEN`) | Agent + Human | Agent generates `PULSE_SECRET_KEY` and pipes to `wrangler secret put`; human confirms emails / ops token |
| Set up Cloudflare Access (Zero Trust dashboard sign-in) | Human (1 min) | Optional to start: **the tracker, REST API, and MCP work immediately without Access** |
| Connect MCP server to the agent client | Agent | Claude Code, Codex, Cursor, or `.mcp.json` |
| Register sites, add `<script>` snippets, fix CSP, verify with `install_check`, add goals & uptime checks | Agent | 100% automated via MCP or REST |

## 1. Check prerequisites

Verify Node 22+, dependencies, and Cloudflare authentication:

```sh
node -v                      # must be >= 22
npm ci
npx wrangler whoami          # confirms login and prints account ID
```

If `wrangler whoami` fails, ask the user to run `npx wrangler login` in their terminal (or export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).

Ask the user for the minimum inputs once, up front:
1. **Pulse hostname** (e.g. `pulse.example.com`, on a domain whose DNS is already on Cloudflare)
2. **Jurisdiction** (`eu` default, `fedramp`, or `none`)
3. **Owner email** for `ACCESS_EMAILS` (and whether to use the same address for `ALERT_EMAIL`)
4. **Websites to connect** (domains, time zone, and local repo paths if the agent should install the tracker directly)

Requirements on Cloudflare: **Workers Paid** ($5/month, required for Queues and 5-minute backup CPU limit) and the target domain's DNS zone on Cloudflare.

## 2. Create Cloudflare resources (idempotent)

Check existing resources first so a re-run never fails with "already exists":

```sh
npx wrangler d1 list --json
npx wrangler queues list
npx wrangler kv namespace list
npx wrangler r2 bucket list
```

Create any missing resource (keep the exact names from `wrangler.jsonc`; drop `--jurisdiction eu` if `PULSE_JURISDICTION=none`):

```sh
npx wrangler d1 create pulse --jurisdiction eu               # capture uuid -> PULSE_D1_ID
npx wrangler queues create pulse-events
npx wrangler queues create pulse-events-dlq
npx wrangler kv namespace create OAUTH_KV                    # capture id   -> PULSE_KV_ID
npx wrangler r2 bucket create pulse-backups --jurisdiction eu
npx wrangler r2 bucket create ops-backups --jurisdiction eu  # optional; set PULSE_OPS_BACKUPS=false if skipped
```

## 3. Configure `.env.deploy`, build, and deploy

Create `.env.deploy` (git-ignored; see [.env.deploy.example](../.env.deploy.example)) with the captured IDs:

```sh
PULSE_DOMAIN=pulse.example.com
PULSE_D1_ID=<uuid from d1 create/list>
PULSE_KV_ID=<id from kv namespace create/list>
PULSE_JURISDICTION=eu
# Add PULSE_ACCOUNT_ID=<account_id> if `wrangler whoami` lists multiple accounts
# Add PULSE_ACCESS_TEAM_DOMAIN and PULSE_ACCESS_AUD once step 5 is done
```

Validate, build, apply D1 migrations, and deploy:

```sh
npm run deploy:config        # renders wrangler.deploy.jsonc; fails fast on missing vars
npm run build                # compiles dashboard + tracker (dist/public/p.js)
npm run deploy:custom        # applies remote D1 migrations + deploys Worker on $PULSE_DOMAIN
```
*(Or if the user wants a fast `*.workers.dev` install without a custom domain, skip `.env.deploy` and run `npm run build && npm run deploy` — Wrangler auto-provisions D1, Queues, KV and R2 from the top-level `wrangler.jsonc`.)*

Verify the live deployment:

```sh
curl -fsS "https://$PULSE_DOMAIN/healthz"
```

Expected: `{"ok":true,"version":"..."}`.

## 4. Set Worker secrets safely

Never print secrets into chat or save them in tracked files. Pipe values directly into `wrangler secret put`:

```sh
# 1. Encryption key for Slack/Discord/Telegram/ntfy/webhook channels (32 random bytes, base64)
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" \
  | npx wrangler secret put PULSE_SECRET_KEY -c wrangler.deploy.jsonc --env production

# 2. First owner email(s), comma-separated (for Cloudflare Access sign-in)
printf '%s' "you@example.com" \
  | npx wrangler secret put ACCESS_EMAILS -c wrangler.deploy.jsonc --env production

# 3. Alert & scheduled report email (must be a verified Cloudflare Email Routing destination)
printf '%s' "you@example.com" \
  | npx wrangler secret put ALERT_EMAIL -c wrangler.deploy.jsonc --env production
```

Optional: for weekly D1 SQL exports and `d1_query` checks, ask the user to create a Cloudflare API token with **Account → D1 → Edit** and **Account → Account Settings → Read**, and set `PULSE_OPS_TOKEN` via `npx wrangler secret put PULSE_OPS_TOKEN -c wrangler.deploy.jsonc --env production`.

## 5. Enable dashboard sign-in (Cloudflare Access)

The API, MCP server, and tracker already work at this point. To sign into the web dashboard, ask the user to complete these 30-second steps in Cloudflare Zero Trust (or see [SELF-HOSTING.md](SELF-HOSTING.md#3-sign-in-with-cloudflare-access)):

1. Zero Trust → Settings → Authentication: ensure **One-time PIN** is enabled; note the team domain (`<team>.cloudflareaccess.com`).
2. Access → Applications → **Add an application → Self-hosted**: domain `pulse.example.com`, path `auth/access`, Allow policy for the owner's email(s).
3. Copy the **Application Audience (AUD) Tag**.
4. Add `PULSE_ACCESS_TEAM_DOMAIN` and `PULSE_ACCESS_AUD` to `.env.deploy` and run `npm run deploy`.

## 6. Mint an agent API key and connect MCP

Create a scoped API key directly on production D1 — the CLI writes the secret to `.data/keys.env` (mode `0600`, git-ignored) without printing it:

```sh
npm run admin -- key:create \
  --name agent \
  --scopes stats:read,sites:write,ops:write,annotations:write \
  --env production
```

This key can create/edit sites, goals, funnels, alerts, annotations, notification channels, scheduled reports, and uptime checks, while staying unable to mint other keys or delete raw data (`admin`).

Connect your MCP client (export `PULSE_KEY` from `.data/keys.env` in the user's shell or secret store):

- **Claude Code:**
  ```sh
  claude mcp add --transport http pulse "https://$PULSE_DOMAIN/mcp" \
    --header "Authorization: Bearer $PULSE_KEY"
  ```
- **Codex CLI:**
  ```sh
  codex mcp add pulse --url "https://$PULSE_DOMAIN/mcp" --bearer-token-env-var PULSE_KEY
  ```
- **Cursor / project `.mcp.json`:**
  ```json
  {
    "mcpServers": {
      "pulse": {
        "type": "http",
        "url": "https://pulse.example.com/mcp",
        "headers": {
          "Authorization": "Bearer ${PULSE_KEY}"
        }
      }
    }
  }
  ```
- **claude.ai / Claude Desktop:** add a custom connector with URL `https://pulse.example.com/mcp` (OAuth 2.1; requires step 5).

Verify the connection by calling the MCP tool `whoami` (or `GET https://$PULSE_DOMAIN/api/v1/`). It returns your scopes, sites, and every tool available to this key.

## 7. Connect each website end to end

Repeat this loop for every website the user wants to track (all steps use MCP tools; the equivalent REST routes are in [API.md](API.md)):

1. **Register the site:**
   Call `save_site`:
   ```json
   {
     "name": "Example Shop",
     "domains": ["example.com", "www.example.com"],
     "timezone": "Europe/Madrid"
   }
   ```
   Include every hostname that serves the site (`www.` too, or `*.example.com` for all subdomains). `save_site` returns the site `id`, assigned `color` (12 distinct slots: `violet`, `teal`, `amber`, `magenta`, `blue`, `olive`, `coral`, `indigo`, `emerald`, `plum`, `cyan`, `slate`), and the exact `<script>` snippet.

2. **Install the tracker in the website's codebase:**
   Call `help { "topic": "tracker" }` if you need framework syntax:
   - **Plain HTML / Astro / Vite (`index.html` or base layout `<head>`):**
     ```html
     <script defer src="https://pulse.example.com/p.js" data-site="example-shop"></script>
     ```
   - **Next.js App Router (`app/layout.tsx`):**
     ```tsx
     import Script from "next/script";
     // inside <body> or <head>:
     <Script defer src="https://pulse.example.com/p.js" data-site="example-shop" strategy="afterInteractive" />
     ```
   - **WordPress:** header-scripts plugin or theme `header.php` before `</head>`.
   - **Content-Security-Policy:** search the site's headers/middleware/`_headers`/`next.config.*` for `Content-Security-Policy`. If present, add `https://pulse.example.com` to `script-src` (and `script-src-elem` if defined) and `connect-src`.
   - **Optional instrumentation:**
     - Add `pulse("404")` to the site's 404 page.
     - Tag conversion buttons/forms with `data-pulse-event="signup"` (no JS required) or call `pulse("purchase", { revenue: 49.9, currency: "EUR" })`.
     - If the user wants JS error tracking, enable `settings.features.errors: true` via `save_site` and add `data-errors="true"` on the script tag.

3. **Deploy the website and verify with `install_check`:**
   After the website is deployed (or live), call `install_check { "site": "example-shop" }`.
   - It fetches the home page, checks for the `<script>` tag and matching `data-site`, checks CSP headers (`csp_script`, `csp_connect`), and checks live hits / wrong-host drops.
   - Fix every finding with `level: "error"` or `"warn"` and re-run until `status` is `"installed"` or `"receiving"`.

4. **Set up goals, uptime checks, and alerts:**
   - **Primary conversion goal:** call `save_goal` (e.g. `{"site":"example-shop","name":"Signup","match":{"kind":"event","event":"signup"}}`), then optionally pin it to the home card with `save_site {"id":"example-shop","settings":{"primary_goal":"<goal_id>"}}`.
   - **Uptime check:** call `save_check` for the home page (and any critical API endpoint):
     ```json
     {
       "name": "Example Shop home",
       "kind": "http",
       "url": "https://example.com/",
       "site_id": "example-shop",
       "config": { "expect_status": "200-299" }
     }
     ```
     Use `run_check` to verify it immediately.
   - **Traffic alert (optional):** call `save_alert` with `kind: "no_data"` (e.g. `window_min: 180`) to catch a broken snippet or outage.
   - **Deploy annotation:** call `add_annotation` (`category: "deploy"`) after shipping changes, or wire `POST /api/v1/hooks/deploy` in CI.

5. **Report back concisely:**
   Summarize the Pulse URL, every connected site ID, `install_check` status, created goals and monitors, and any remaining human step (such as Cloudflare Access AUD setup if deferred).

## Copy-paste prompts for users

**English:**
> Follow `docs/AGENT-SETUP.md` in this repo to deploy Pulse to my Cloudflare account at `pulse.yourdomain.com` (EU jurisdiction), connect Pulse MCP, and install + verify tracking and an uptime check for my websites: `yourdomain.com` (repo at `../my-site`).

**Español:**
> Sigue `docs/AGENT-SETUP.md` en este repo para desplegar Pulse en mi cuenta de Cloudflare en `pulse.tudominio.com` (jurisdicción EU), conectar el servidor MCP de Pulse, e instalar y verificar el tracker y una comprobación de disponibilidad en mis webs: `tudominio.com` (repo en `../mi-web`).

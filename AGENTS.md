# AGENTS.md — Pulse

Pulse is a private, cookieless web analytics service you run on your own Cloudflare account. One Cloudflare Worker serves the tracker, ingest, REST API, MCP server, OAuth and the dashboard SPA. Storage is D1 (EU jurisdiction by default).

These rules apply to every contributor, human or agent.

## Rules (binding)

1. **Privacy invariants**
   - The client IP is used only to compute the daily visitor hash in `src/worker/ingest`. It is never stored, queued, logged or returned.
   - No cookies or web storage in the tracker. The one exception is the `pulse_ignore` opt-out flag, set only at the person's request: the site operator's `#pulse-ignore` link, or a site's own "don't count my visits" control.
   - Never log API keys, session ids, invite tokens or OAuth tokens. Store only SHA-256 hashes of them.
   - Daily salts (one per local day of a site's time zone) are deleted once that day is over, never later than 48 h, so visitor ids cannot be linked across days.
2. **Tenant isolation**: every query is filtered by a `site_id` that came from an authorized context (`requireSite`), never from raw input without an access check. SQL is always parameterized.
3. **Tests before deploy**: `npm run typecheck && npm run lint && npm test && npm run tracker:size && npm run build`. Integration tests (`npm run test:integration`) run in workerd, which doesn't run on every machine (some Windows setups can't run it); they always run in Workers Builds.
4. **Migrations**: add a new numbered file in `migrations/`. Never edit an applied migration. A migration must work on a fresh install as well as on an existing one.
5. **Secrets** never go into git, logs, commits or chat. Local keys live in `.data/keys.env`, deployment values in `.env.deploy` (both git-ignored).
6. **Tracker budget**: `dist/public/p.js` ≤ 2.5 KB gzipped (`npm run tracker:size`).
7. **Numbers agree**: every read endpoint is a preset over the query engine (`src/worker/query`). Don't compute metrics anywhere else.
8. Commits are small, one concern each.
9. **Agents can reach everything**: every capability ships with its REST route, its MCP tool (or a written `mcpExclusion` in `src/worker/catalog.ts`), a catalog entry, a line in `docs/MCP.md`/`docs/API.md` and tests, in the same change. `npm test` (`test/unit/catalog.test.ts`) enforces it. Deployment-specific values (site ids, database names, time zones, emails, domains, account ids) live in data, settings or `PULSE_*` deploy variables, never in code.

## Layout

- `src/worker/` — Hono app (`index.ts`) plus `queue()` and `scheduled()` handlers. `catalog.ts` lists every capability; `guide.ts` holds the agent guide (MCP `help`, `/llms.txt`, `/docs/agents`).
- `src/tracker/pulse.ts` — tracker, bundled with esbuild to `dist/public/p.js`.
- `src/dashboard/` — React SPA, built by Vite to `dist/public`.
- `scripts/` — deploy config, admin CLI, smoke, load test, tracker size, `restore-order.ts` (prepare a D1 export for a restore; see docs/OPERATIONS.md#disaster-recovery).
- `docs/` — self-hosting, agent setup, API, MCP, tracker, privacy, operations, architecture, performance, design, decisions.
- `site/` — static GitHub Pages showcase & documentation website.

## Commands

| Command | What |
|---|---|
| `npm test` | Unit tests (Node) |
| `npm run test:integration` | workerd integration tests (Linux / Workers Builds) |
| `npm run build` | Tracker + dashboard |
| `npm run deploy` | Apply D1 migrations + `wrangler deploy` using top-level `wrangler.jsonc` (1-click Deploy to Cloudflare / `workers.dev`) |
| `npm run deploy:config` | Fill the `${PULSE_*}` placeholders of `env.production` from the environment or `.env.deploy` → `wrangler.deploy.jsonc` (git-ignored) |
| `npm run deploy:custom` | `deploy:config`, apply D1 migrations, `wrangler deploy --env production` (custom domain + EU jurisdiction + Email Routing) |
| `npm run admin -- <cmd> [--env production]` | Sites, sessions, API keys via `wrangler d1 execute --remote` |
| `node scripts/smoke.mjs [production\|url]` | Post-deploy smoke test (`production` reads `PULSE_DOMAIN`) |
| `npx wrangler dev` | Local Worker on http://localhost:8787 with simulated bindings (top-level config); needs workerd; there is no staging |
| `npm run dev:seed && npm run dev` | The real Worker in Node (node:sqlite, `.data/dev.sqlite`) on :8787 + the Vite dashboard on :5173 with demo data; open `/__dev/login`. Works without workerd, including on Windows |
| `node scripts/dev/shoot.mjs <label> [paths…]` | Screenshots of the dev dashboard at 1440/390 px, light/dark, into `.data/qa/<label>/` (set `MSYS_NO_PATHCONV=1` in Git Bash) |

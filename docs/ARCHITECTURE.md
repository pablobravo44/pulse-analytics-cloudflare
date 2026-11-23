# Architecture

```
browser (site)                     dashboard / agents
   │  /p.js  POST /e                 │  /  /api/v1  /mcp  /oauth  /auth
   ▼                                 ▼
┌──────────────────────── Worker "pulse" (one hostname) ────────────────────────┐
│ index.ts  ── pulse_sk_ bearer → Hono app                                        │
│           └─ everything else → OAuthProvider (apiRoute /mcp) → Hono app         │
│ ingest/   validate → rate limit → bot filter → enrich (geo, UA, channel, tz)    │
│           → visitor_id = HMAC(daily salt, site|ip|ua)  (IP dropped here)        │
│           → Queue "pulse-events"                                                │
│ queue/    consumer: session window 30 min, INSERT OR IGNORE event + session     │
│ query/    one SQL builder: metrics × dimensions × filters (+ presets/analyses)  │
│ api/      REST v1 (zod-openapi), import, export, health, ops                    │
│ mcp/      stateless MCP server; tools filtered by the key's scopes              │
│ catalog   every capability → scope, REST ops, MCP tool, dashboard (tests check) │
│ guide     agent guide: MCP help, /llms.txt, /docs/agents                        │
│ oauth/    consent page for MCP connectors (workers-oauth-provider, KV)          │
│ auth/     Cloudflare Access sign-in, sessions, API keys (hashed)                │
│ cron/     */5 monitors, rollups · hourly salts, D1 sizes · 03:00 retention · Sun │
│ ops/      checks (8 kinds), channels, traffic alerts, reports, D1 export, drill │
│ settings  admin-editable instance settings (backups, size warning) in D1        │
│ static    dist/public via ASSETS (SPA + tracker), run_worker_first              │
└────────────────────────────────────────────────────────────────────────────────┘
   │ D1 "pulse" (EU)   │ Queues + DLQ   │ KV OAUTH_KV   │ R2 pulse-backups, ops-backups (EU by default)
```

## Data flow
1. The tracker sends a `text/plain` beacon to `/e` (no preflight).
2. Ingest answers `202` immediately for every input (valid or not) and counts drops by reason in isolate memory; each isolate writes them to `ingest_stats` (and the last rejected hostname to `kv_meta`) at most once a minute, so a flood of junk requests costs no D1 writes. Counts held by an isolate that is evicted before its next flush are lost, so drop counters are approximate; `accepted` is exact (the queue consumer writes it).
3. The enriched hit (no IP) goes to the queue. The consumer processes hits in timestamp order, one D1 `batch()` per hit so the event and its session stay consistent. A redelivered hit is skipped because its ULID already exists.
4. Every number shown anywhere comes from `src/worker/query/build.ts` (aggregate per session first, then per dimension), so summary, timeseries, breakdowns, MCP tools, alerts and reports always agree.

## Reading: rollups, merged statements, caches
- **Daily rollups** (`stat_days`, `src/worker/query/rollup.ts`): per site, local day and dimension value, the engine's own aggregates plus continuation columns, so a multi-day count over rollups equals the raw count exactly (no visitor-day overcount). Closed days are built once; today is rebuilt by the 5-minute cron; days newer than the last build are read raw. Goal rollups are keyed by goal id and a hash of its definition, so editing a goal rebuilds it. `ROLLUP_VERSION` invalidates every row when the shape changes. The planner uses rollups only when every metric, dimension and filter can be answered from them (vitals and session-level filters fall back to raw). `test/unit/rollup.test.ts` checks rollup = raw over 220+ query shapes.
- **One statement per view**: `planQuery` turns a query into SQL; `runMerged` joins many plans into one D1 statement (`json_group_array` per part, `UNION ALL`) and splits the result. `/overview` (the whole site view), `/sites/summary` (every site for the home and the rail, including what changed yesterday) and `insights` are each one statement.
- **Caches**: report responses go through the Cache API keyed by the sorted query (`edgeCached`, 60 s for live views, longer for closed ranges) with an ETag; the dashboard asks for one request per view and prefetches the next site on hover.
- **Live**: `query/live.ts` lists the visits of the last 30 minutes (no session or visitor ids) and counts the ones active in the last 5, from the same rows, so the count and the list agree.

## Agents
`src/worker/catalog.ts` lists every capability with its scope, REST operations, MCP tool (or the reason there is none) and dashboard page. The MCP server registers only the tools a key's scopes allow and writes its `instructions` for that key; `whoami` and `help` (texts in `src/worker/guide.ts`, also served as `/llms.txt`, `/docs/agents` and `pulse://guide`) explain the rest; `GET /api/v1/` is the REST equivalent. `test/unit/catalog.test.ts` fails when a route or tool is missing from the catalog or the docs, or answers a key without its scope.

## Configuration as data
Sites, goals, funnels, checks and ops settings (`settings` table, key `ops`) are rows edited in the dashboard, REST or MCP. The code holds no site ids, database names or time zones.

## Storage
See `migrations/`. Raw `events` and `sessions` are kept `retention_months` (default 25); older days are rolled up into `rollups_daily` (per dimension) and deleted by the 03:00 cron, which also deletes their `stat_days` rows. Daily salts are kept per local day of each site's time zone and deleted when that day ends (≤ 48 h).

## Environments
| | local (`wrangler dev`, integration tests) | production |
|---|---|---|
| Worker | `pulse-dev` (top-level config, never deployed) | `pulse` (your `PULSE_DOMAIN`, e.g. `pulse.example.com`) |
| D1 | `pulse-local` (Miniflare) | `pulse` |
| Ops jobs (monitors, alerts, reports, D1 backups) | off | on |
| Fixture page `/__e2e/fixture` | on | off |

There is no staging environment: changes are tested locally (`npm run dev`, unit tests) and deployed to production. `env.production` in `wrangler.jsonc` holds `${PULSE_*}` placeholders that `npm run deploy:config` fills from your build variables or `.env.deploy` (docs/SELF-HOSTING.md).

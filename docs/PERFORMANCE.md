# Performance

Why the dashboard was once slow, what was measured, and how reads stay cheap. Use the same tools to check a change that touches the query engine or the dashboard's request set.

## Root cause

Not the network, the bundle or React: the database. A production deployment answered `D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.` with only ~60k events. A D1 database runs one query at a time, so the ~20 requests a site view fires queue behind each other, and almost every metric re-read the raw `events` of the whole range joined to `sessions`.

## Baseline

### Production (a site with ~60k events, measured with `scripts/bench/burst.mjs` and `wrangler d1 insights`)

| What | Before |
|---|---|
| Requests when a site view opens | 17–20 |
| D1 queries they run | ~85 |
| Of those, full scans of `events` in the range | ~55 |
| Rows read per open | 2–3 M |
| Full overview in a burst (3 tries) | 5.8 s / 60 s / 5.8 s, 1–3 errors each |
| Insights | 3–4.6 s, sometimes 500 |
| `source_counts` query (unused by the dashboard) | 4,781 runs, 12.2 M rows in 7 days |
| Status board poll, every 60 s on every page | 159k rows per call |
| Cheap single requests | 60–340 ms |

Indexes were fine (`events_site_day`, `sessions` PK); no index was missing. `rollups_daily` existed but was only written at retention time and never read.

### Local (node:sqlite, `scripts/bench/overview.ts`, set `v1`, site demo-blog, 28 days)

`npm run dev:seed` data (41k pageviews over 120 days) and a 10x copy made with `scripts/bench/scale.mjs` (637k events, 148k sessions for demo-blog).

| Data | Requests | D1 statements per open | Panels ready p50 / p95 |
|---|---|---|---|
| 1x | 19 | 124 | 1,143 / 1,221 ms |
| 10x | 19 | 125 | 14,051 / 14,197 ms |

node:sqlite serializes statements like D1, so the burst queues the same way: the cheap requests wait behind the heavy ones.

## Target

Site overview with 10x that data: at most 8 D1 queries and 20k rows read, p95 under 400 ms with a warm cache and under 900 ms cold, and no "overloaded" errors with 5 dashboard tabs open plus the 5-minute cron.

## Tools

| Script | What |
|---|---|
| `node --import ./scripts/dev/register.mjs scripts/bench/overview.ts [db] [site] [--set v1\|v2] [--runs N]` | Local judge: the request set a site view fires, statements per open, p50/p95 |
| `node scripts/bench/scale.mjs <copy.sqlite> 10` | 10x copy of demo-blog for the local judge |
| `node scripts/bench/bench.mjs <db> [site] [from] [to] [--plan]` | Times each SQL statement the overview generates; `--plan` prints EXPLAIN QUERY PLAN |
| `PULSE_KEY=… node scripts/bench/burst.mjs [site] [burst\|serial]` | Burst against a deployment with a read-only key (read-only GETs; run it only against your own deployment) |

## After rollups (local)

Same judge, same data, with the daily rollups built (`scripts/bench/rollups.ts`) and the current dashboard request set (`--set v2`: sites, realtime, views, `/overview`, then insights after it).

| Data | Requests | D1 statements per open (all requests) | Panels ready p50 / p95 |
|---|---|---|---|
| 1x, v1 set on rollups | 19 | 79 | 27 / 58 ms |
| 10x, v1 set on rollups | 19 | 79 | 84 / 118 ms |
| 10x, v2 set | 5 | 14 (overview: 4, of which 1 merged report query) | 7 / 41 ms |

- The overview reads about 2,000 `stat_days` rows at 10x for 28 days with comparison (the same 56 days hold 330k raw events, which the old page scanned two or three times per panel).
- In the browser (`scripts/bench/capture.mjs`), opening a site went from 18 requests to 9 (four of them are shared and cached across pages in normal SPA navigation).
- In production, `/overview` returns `Server-Timing: d1;desc="N statements, R rows"` and `X-Pulse-Cache: hit|miss`, so rows read and cache hits can be checked from the browser's network panel.

## How reads stay cheap

- **Rollups** (`src/worker/query/rollup.ts`, table `stat_days`): per site × dimension × local day × value, the additive parts of every metric plus the part continuing from the day before, so multi-day sums are exact. The engine uses them whenever they answer a query exactly and reads raw events otherwise (filters, inline goals, 24h/last_minutes, UTC days, unstored dimensions). `test/unit/rollup.test.ts` checks rollup = raw for 220+ query shapes.
- **Cron** (every 5 minutes): closes finished days (90 minutes after local midnight; 14 days per run while catching up), rebuilds today, and rebuilds goal rows after a goal changes. A read computes days newer than the stored rows from raw events in the same statement, so a stalled cron costs speed, never correctness.
- **One query per report**: `runMerged` turns the statements of many queries into one D1 statement; `/overview`, `/summary`, `/insights`, `/changes` and `/sites/summary` (every site for the home and the rail, with what changed yesterday) use it.
- **Edge cache**: `/overview` and `/insights` through the Cache API, 60 s when the range includes today, 10 minutes otherwise; the key includes the rollup watermark.
- **Status board**: daily cells in `monitor_days`, kept as checks are recorded; the dashboard reads the board once per page load and only `/status` refreshes it (every 5 minutes).
- **Wasted queries removed**: `source_counts` is opt-in, queries without dimensions don't run their SQL twice, movers is one batch, realtime stays on the `(site_id, ts)` index.

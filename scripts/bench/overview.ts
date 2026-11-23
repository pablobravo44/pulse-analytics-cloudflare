// Local judge for the site overview: fires the request set the dashboard sends when a site opens, all at once,
// against the real Worker in Node with node:sqlite, and counts the D1 statements it runs.
//   node --import ./scripts/dev/register.mjs scripts/bench/overview.ts [db] [site] [--runs N] [--set v1|v2]
// db defaults to .data/dev.sqlite (npm run dev:seed); use scripts/bench/scale.mjs to make a 10x copy.
// node:sqlite runs one statement at a time, like a D1 database, so a burst queues the same way it does in production.
import worker from "../../src/worker/index.ts";
import { createSession, SESSION_COOKIE } from "../../src/worker/auth/session.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args.splice(i, 2)[1]! : d;
};
const runs = Number(opt("--runs", "5"));
const set = opt("--set", "v1");
const [dbPath = ".data/dev.sqlite", site = "demo-shop"] = args;
process.env.PULSE_DEV_DB = dbPath;
const { devEnv } = await import("../dev/env.ts");
const { env, db } = devEnv();

// Count every statement D1 would run (batched statements count one each, as D1 bills them) and time them by SQL shape.
let statements = 0;
let sqlMs = 0;
const bySql = new Map<string, { n: number; ms: number }>();
const shape = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 110);
const timed = <R>(sql: string, fn: () => R): R => {
  statements++;
  const t0 = performance.now();
  const done = () => {
    const ms = performance.now() - t0;
    sqlMs += ms;
    const k = shape(sql);
    const e = bySql.get(k) ?? { n: 0, ms: 0 };
    bySql.set(k, { n: e.n + 1, ms: e.ms + ms });
  };
  // BENCH_RAW=1 prints every statement that reads raw events instead of the rollups.
  if (process.env.BENCH_RAW && /^\s*WITH r AS/.test(sql)) console.log("RAW:", sql.replace(/\s+/g, " ").slice(-500));
  const out = fn();
  if (out instanceof Promise) return out.finally(done) as R;
  done();
  return out;
};
const wrap = <T extends object>(s: T, sql: string): T =>
  new Proxy(s, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r) as unknown;
      if (k === "bind") return (...p: unknown[]) => wrap((v as (...a: unknown[]) => object).apply(t, p), sql);
      if (k === "first" || k === "all" || k === "run" || k === "raw" || k === "runSync")
        return (...p: unknown[]) => timed(sql, () => (v as (...a: unknown[]) => unknown).apply(t, p));
      return v;
    },
  });
const rawPrepare = db.prepare.bind(db);
(db as { prepare: unknown }).prepare = (sql: string) => {
  if (process.env.BENCH_RAW && /^\s*WITH r AS/.test(sql))
    console.log("RAW from", new Error().stack?.split("\n").slice(2, 9).map((l) => l.trim().replace(/^at /, "").replace(/\(?file:\/\/\/.*\/src\//, "(")).join(" < "));
  return wrap(rawPrepare(sql), sql);
};

const user = await db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").first<{ id: string }>();
if (!user) throw new Error("no owner in this database: run npm run dev:seed and open /__dev/login once");
const { token } = await createSession(db, user.id, { label: "bench" });
const cookie = `${SESSION_COOKIE}=${token}`;
const sites = (await db.prepare("SELECT id FROM sites WHERE archived_at IS NULL").all<{ id: string }>()).results.map((r) => r.id);

const r = "date_range=28d&compare=previous_period";
const KPI = ["visitors", "sessions", "pageviews", "views_per_session", "bounce_rate", "avg_session_duration", "avg_engaged_time", "revenue"];
const body = (b: Record<string, unknown>) => ({ date_range: "28d", filters: [], compare: "previous_period", ...b });
type Req = [string, string, Record<string, unknown>?];
const SETS: Record<string, Req[]> = {
  // What the v1 dashboard fires when a site opens (captured with Playwright during the audit).
  v1: [
    ["sites", "/api/v1/sites"],
    ["ops/status", "/api/v1/ops/status"],
    ["realtime", `/api/v1/sites/${site}/realtime`],
    ["goals", `/api/v1/sites/${site}/goals`],
    ["views", `/api/v1/sites/${site}/views`],
    ...sites.map((s): Req => [`spark ${s}`, `/api/v1/sites/${s}/timeseries?date_range=7d&metrics=visitors&compare=none`]),
    ["insights", `/api/v1/sites/${site}/insights?${r}`],
    ["kpi", `/api/v1/sites/${site}/query`, body({ metrics: KPI })],
    ["timeseries", `/api/v1/sites/${site}/timeseries?${r}&metrics=visitors&interval=day`],
    ["annotations", `/api/v1/sites/${site}/annotations?date_range=28d&compare=previous_period`],
    ["pages", `/api/v1/sites/${site}/query`, body({ metrics: ["pageviews", "visitors"], dimensions: ["page"], compare: null, limit: 100 })],
    ["channel", `/api/v1/sites/${site}/query`, body({ metrics: ["visitors"], dimensions: ["channel"], compare: null, limit: 100 })],
    ["country", `/api/v1/sites/${site}/query`, body({ metrics: ["visitors"], dimensions: ["country"], compare: null, limit: 100 })],
    ["device", `/api/v1/sites/${site}/query`, body({ metrics: ["visitors"], dimensions: ["device"], compare: null, limit: 100 })],
    ["event_name", `/api/v1/sites/${site}/query`, body({ metrics: ["events", "visitors"], dimensions: ["event_name"], compare: null, limit: 100 })],
    ["outbound", `/api/v1/sites/${site}/query`, body({ metrics: ["sessions"], dimensions: ["outbound_url"], compare: null, limit: 100 })],
    ["weekday x hour", `/api/v1/sites/${site}/query`, body({ metrics: ["visitors"], dimensions: ["weekday", "hour"], compare: null, limit: 200 })],
  ],
  // v2: one overview call for the panels, insights after it (deferred), realtime and views beside it.
  v2: [
    ["sites", "/api/v1/sites"],
    ["realtime", `/api/v1/sites/${site}/realtime`],
    ["views", `/api/v1/sites/${site}/views`],
    ["overview", `/api/v1/sites/${site}/overview?${r}`],
  ],
};
const reqs = SETS[set];
if (!reqs) throw new Error(`unknown set ${set}`);
const deferred: Req[] = set === "v2" ? [["insights", `/api/v1/sites/${site}/insights?${r}`]] : [];

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
async function fire([label, path, b]: Req): Promise<[string, number, number]> {
  const t0 = performance.now();
  const res = await worker.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: b ? "POST" : "GET",
      headers: { cookie, "content-type": "application/json", "x-pulse-client": "dashboard", "sec-fetch-site": "same-origin", origin: "http://localhost:8787" },
      body: b ? JSON.stringify(b) : undefined,
    }),
    env,
    ctx,
  );
  await res.arrayBuffer();
  return [label, res.status, performance.now() - t0];
}

const walls: number[] = [];
const counts: number[] = [];
let last: [string, number, number][] = [];
for (let i = 0; i < runs; i++) {
  if (i === 0) bySql.clear();
  statements = 0;
  sqlMs = 0;
  const t0 = performance.now();
  last = await Promise.all(reqs.map(fire));
  const firstPaint = performance.now() - t0;
  for (const d of deferred) last.push(await fire(d));
  walls.push(firstPaint);
  counts.push(statements);
}
const sorted = [...walls].sort((a, b) => a - b);
const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
if (args.includes("--top") || process.env.BENCH_TOP)
  for (const [k, v] of [...bySql].sort((x, y) => y[1].ms - x[1].ms).slice(0, 15)) console.log(`${(v.ms / runs).toFixed(0).padStart(6)} ms ${String(v.n / runs).padStart(4)}x  ${k}`);
for (const [l, st, ms] of last) console.log(`${l.padEnd(24)} ${st} ${ms.toFixed(0).padStart(6)} ms`);
const bad = last.filter(([, st]) => st >= 400);
console.log(`db=${dbPath} site=${site} set=${set} runs=${runs}`);
console.log(`requests=${reqs.length + deferred.length} statements/open=${counts[counts.length - 1]} sql=${sqlMs.toFixed(0)} ms panels p50=${p(0.5).toFixed(0)} ms p95=${p(0.95).toFixed(0)} ms (first run ${walls[0]!.toFixed(0)} ms)`);
if (bad.length) {
  console.log(`errors: ${bad.map(([l, st]) => `${l}=${st}`).join(", ")}`);
  process.exitCode = 1;
}

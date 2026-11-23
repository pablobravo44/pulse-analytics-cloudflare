// Usage: node scripts/bench/bench.mjs <db> [site] [from] [to] [--plan]
// Times the SQL the overview page generates (real buildAggregate from the repo), per statement.
import { DatabaseSync } from "node:sqlite";
import { buildAggregate, buildVitalsP75 } from "../../src/worker/query/build.ts";
import { compareRange } from "../../src/worker/query/range.ts";

const [, , dbPath, site = "demo-blog", from = "2026-09-24", to = "2026-10-21", ...rest] = process.argv;
const plan = rest.includes("--plan");
const db = new DatabaseSync(dbPath);
const range = { from, to };
const cr = compareRange(range, "previous_period");
const ctx = (r) => ({ siteId: site, timeZone: "Europe/Madrid", tzMode: "site", range: r, goals: {} });

const KPI = ["visitors", "sessions", "pageviews", "views_per_session", "bounce_rate", "avg_session_duration", "avg_engaged_time", "revenue"];
// [label, metrics, dims, filters, compare, limit]
const overview = [
  ["kpi", KPI, [], [], true, 100],
  ["timeseries day", ["visitors"], ["day"], [], true, 1000],
  ["pages", ["pageviews", "visitors"], ["page"], [], false, 101],
  ["channel", ["visitors"], ["channel"], [], false, 101],
  ["country", ["visitors"], ["country"], [], false, 101],
  ["device", ["visitors"], ["device"], [], false, 101],
  ["event_name", ["events", "visitors"], ["event_name"], [], false, 101],
  ["outbound_url", ["sessions"], ["outbound_url"], [], false, 101],
  ["weekday x hour", ["visitors"], ["weekday", "hour"], [], false, 201],
  ["insights movers page (x2 periods)", ["visitors"], ["page"], [], true, 1001],
  ["insights movers referrer (x2)", ["visitors"], ["referrer_host"], [], true, 1001],
  ["kpi filtered country=ES", KPI, [], [["is", "country", ["ES"]]], true, 100],
  ["pages filtered event_name (subquery)", ["pageviews", "visitors"], ["page"], [["is", "event_name", ["signup"]]], false, 101],
];

function time(sql, params) {
  const st = db.prepare(sql);
  st.all(...params); // warm
  const n = 3;
  const t0 = performance.now();
  let rows = 0;
  for (let i = 0; i < n; i++) rows = st.all(...params).length;
  return { ms: (performance.now() - t0) / n, rows };
}

let total = 0;
const out = [];
for (const [label, metrics, dimensions, filters, compare, limit] of overview) {
  const stmts = [];
  for (const r of compare ? [range, cr] : [range]) {
    const spec = { metrics, dimensions, filters, goal: null, limit, offset: 0 };
    stmts.push(["main", buildAggregate(ctx(r), spec)]);
    stmts.push(["totals", buildAggregate(ctx(r), { ...spec, dimensions: [] })]);
  }
  stmts.push(["source_counts", { sql: "SELECT source, COUNT(*) AS n FROM events WHERE site_id = ? AND local_day BETWEEN ? AND ? GROUP BY source", params: [site, from, to] }]);
  let sum = 0;
  const parts = [];
  for (const [k, s] of stmts) {
    const t = time(s.sql, s.params);
    sum += t.ms;
    parts.push(`${k}=${t.ms.toFixed(1)}`);
  }
  total += sum;
  out.push(`${label.padEnd(40)} ${sum.toFixed(1).padStart(7)} ms  (${parts.join(" ")})`);
  if (plan && (label === "pages" || label === "kpi")) {
    const s = stmts[0][1];
    console.log(`--- plan ${label}\n` + db.prepare("EXPLAIN QUERY PLAN " + s.sql).all(...s.params).map((r) => `${r.id}/${r.parent} ${r.detail}`).join("\n"));
  }
}
// vitals p75 (insights)
for (const col of ["lcp", "inp"]) {
  const s = buildVitalsP75(ctx(range), col, { dimensions: [], filters: [] });
  const t = time(s.sql, s.params);
  total += t.ms;
  out.push(`${("vitals p75 " + col).padEnd(40)} ${t.ms.toFixed(1).padStart(7)} ms`);
}
const ev = db.prepare("SELECT COUNT(*) n FROM events WHERE site_id = ? AND local_day BETWEEN ? AND ?").get(site, from, to).n;
console.log(`db=${dbPath} site=${site} range=${from}..${to} events_in_range=${ev}`);
console.log(out.join("\n"));
console.log(`SUM of all statements: ${total.toFixed(1)} ms`);

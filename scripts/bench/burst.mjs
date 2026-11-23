// Production burst: the v1 overview request set fired at once against the live API (read-only GETs).
//   PULSE_ORIGIN=https://pulse.example.com PULSE_KEY=… node scripts/bench/burst.mjs <site> [burst|serial]
//   (the key is read from env, never printed)
const B = `${process.env.PULSE_ORIGIN ?? "http://localhost:8787"}/api/v1`;
const s = process.argv[2] ?? "demo-shop";
const mode = process.argv[3] ?? "burst";
const r = "date_range=28d";
const paths = [
  ["sites", "/sites"],
  ["kpi(timeseries totals,cmp)", `/sites/${s}/timeseries?${r}&metrics=visitors,sessions,pageviews,views_per_session,bounce_rate,avg_session_duration,avg_engaged_time,revenue&interval=month&compare=previous_period`],
  ["timeseries day cmp", `/sites/${s}/timeseries?${r}&metrics=visitors&interval=day&compare=previous_period`],
  ["annotations", `/sites/${s}/annotations?${r}`],
  ["realtime", `/sites/${s}/realtime`],
  ["views", `/sites/${s}/views`],
  ["insights", `/sites/${s}/insights?${r}`],
  ["bd page", `/sites/${s}/breakdown/page?${r}&metrics=pageviews,visitors&limit=100`],
  ["bd channel", `/sites/${s}/breakdown/channel?${r}&metrics=visitors&limit=100`],
  ["bd country", `/sites/${s}/breakdown/country?${r}&metrics=visitors&limit=100`],
  ["bd device", `/sites/${s}/breakdown/device?${r}&metrics=visitors&limit=100`],
  ["bd event_name", `/sites/${s}/breakdown/event_name?${r}&metrics=events,visitors&limit=100`],
  ["bd outbound_url", `/sites/${s}/breakdown/outbound_url?${r}&metrics=sessions&limit=100`],
  ["bd weekday", `/sites/${s}/breakdown/weekday?${r}&metrics=visitors&limit=200`],
  ["sites summary", `/sites/summary?date_range=7d`],
];
const h = { Authorization: `Bearer ${process.env.PULSE_KEY}` };
const one = async ([label, p]) => {
  const t0 = performance.now();
  const res = await fetch(B + p, { headers: h });
  await res.arrayBuffer();
  return [label, res.status, Math.round(performance.now() - t0)];
};
const t0 = performance.now();
let out;
if (mode === "burst") out = await Promise.all(paths.map(one));
else { out = []; for (const p of paths) out.push(await one(p)); }
const wall = Math.round(performance.now() - t0);
for (const [l, st, ms] of out) console.log(`${l.padEnd(28)} ${st} ${String(ms).padStart(6)} ms`);
console.log(`${mode}: wall ${wall} ms, sum ${out.reduce((a, x) => a + x[2], 0)} ms`);

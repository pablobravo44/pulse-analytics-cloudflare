// Build the daily rollups of a local database the way the 5-minute cron does, until every site has caught up.
export {};
//   node --import ./scripts/dev/register.mjs scripts/bench/rollups.ts [db]
const [dbPath = ".data/dev.sqlite"] = process.argv.slice(2);
process.env.PULSE_DEV_DB = dbPath;
const { devEnv } = await import("../dev/env.ts");
const { refreshRollups } = await import("../../src/worker/query/rollup.ts");
const { listSitesCached } = await import("../../src/worker/lib/sites.ts");
const { db } = devEnv();
const sites = await listSitesCached(db);
const t0 = performance.now();
for (let run = 1; run <= 60; run++) {
  const r = await refreshRollups(db, sites, Date.now());
  if (r.every((x) => !x.closed)) {
    console.log(`caught up after ${run} runs, ${(performance.now() - t0).toFixed(0)} ms`, JSON.stringify(r));
    break;
  }
}
const rows = await db.prepare("SELECT dim, COUNT(*) AS n FROM stat_days GROUP BY dim ORDER BY n DESC").all<{ dim: string; n: number }>();
console.log("stat_days rows:", rows.results.map((x) => `${x.dim || "(site)"}=${x.n}`).join(" "));
// One open-day rebuild, timed: what every cron run costs once caught up.
const t1 = performance.now();
await refreshRollups(db, sites, Date.now());
console.log(`open-day rebuild for ${sites.length} sites: ${(performance.now() - t1).toFixed(0)} ms`);

// Rule 7: the daily rollups must give exactly the numbers the raw engine gives, for every query shape they answer.
import { beforeAll, describe, expect, it } from "vitest";
import { enrich } from "../../src/worker/ingest/enrich.ts";
import type { TrackerPayload } from "../../src/worker/ingest/types.ts";
import { invalidateSiteCache } from "../../src/worker/lib/sites.ts";
import { addDays, utcDay } from "../../src/worker/lib/time.ts";
import { buildRollupAggregate, invalidateRollupState, refreshRollups, rollupState } from "../../src/worker/query/rollup.ts";
import { overview, OVERVIEW_KPIS, OVERVIEW_PANELS } from "../../src/worker/query/overview.ts";
import { planQuery, resolveGoal, runMerged, runQuery } from "../../src/worker/query/run.ts";
import { querySchema, type QueryInput } from "../../src/worker/query/schema.ts";
import { processHit } from "../../src/worker/queue/consumer.ts";
import { createD1, migrate } from "./d1-shim.ts";
import { CHROME, IPHONE, SITE, insertSite, meta } from "./fixtures.ts";

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const DAY0 = "2026-10-01";
const DAYS = 12;
// Local noon of the last day, Madrid (UTC+2 until 25 Oct, +1 after).
const NOW = Date.UTC(2026, 9, 12, 10, 30);
const MIN = 60_000;

let db: ReturnType<typeof createD1>;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;

async function send(p: Partial<TrackerPayload> & { u: string }, ts: number, ip: string, ua: string, country: string) {
  // Salts rotate per UTC day, as in production: a visitor id lives one UTC day (it can cross local midnight).
  const h = await enrich({ s: SITE.id, t: "pageview", ...p } as TrackerPayload, SITE, meta(ts, { ip, ua, country }), `salt-${utcDay(ts)}`);
  if (typeof h !== "string") await processHit(db, h);
}

const PAGES = ["/", "/pricing", "/blog/a", "/blog/b", "/docs", "/about"];
const REFS = ["", "", "https://www.google.com/", "https://chatgpt.com/", "https://news.ycombinator.com/item?id=1", "https://t.co/x"];

async function generate() {
  type Hit = { p: Partial<TrackerPayload> & { u: string }; ts: number; ip: string; ua: string; country: string };
  const hits: Hit[] = [];
  for (let d = 0; d < DAYS; d++) {
    const dayStart = Date.parse(`${addDays(DAY0, d)}T00:00:00+02:00`);
    const visitors = 6 + Math.floor(rnd() * 8);
    for (let v = 0; v < visitors; v++) {
      // A small pool of IPs so the same person comes back on later days and within the day.
      const ip = `198.51.100.${1 + Math.floor(rnd() * 12)}`;
      const ua = pick([CHROME, IPHONE, ANDROID]);
      const country = pick(["ES", "ES", "MX", "US", "FR"]);
      // Late-evening visits cross local midnight; some cross into the next UTC day too.
      let t = dayStart + (rnd() < 0.25 ? 23 * 60 + 30 + Math.floor(rnd() * 25) : 8 * 60 + Math.floor(rnd() * 14 * 60)) * MIN;
      const views = 1 + Math.floor(rnd() * 4);
      let ref = pick(REFS);
      for (let i = 0; i < views; i++) {
        const u = `https://example.com${pick(PAGES)}${i === 0 && rnd() < 0.2 ? "?utm_source=news&utm_medium=email&utm_campaign=oct" : ""}`;
        const pv = `pv${d}-${v}-${i}`;
        hits.push({ p: { u, r: ref || undefined, pv }, ts: t, ip, ua, country });
        ref = "https://example.com/";
        if (rnd() < 0.6) hits.push({ p: { t: "engagement", u, pv, e: Math.floor(rnd() * 40_000), sc: Math.floor(rnd() * 100) }, ts: t + 2 * MIN, ip, ua, country });
        if (rnd() < 0.2) hits.push({ p: { t: "event", n: pick(["signup", "purchase", "share"]), u, p: rnd() < 0.5 ? { revenue: 10 + Math.floor(rnd() * 30) } : { plan: "pro" } }, ts: t + 3 * MIN, ip, ua, country });
        if (rnd() < 0.1) hits.push({ p: { t: "outbound", u, x: pick(["https://github.com/x", "https://shop.example.org/y"]) }, ts: t + 4 * MIN, ip, ua, country });
        t += (5 + Math.floor(rnd() * 20)) * MIN;
      }
      // A late engagement beacon after the session ended: an inactive group.
      if (rnd() < 0.1) hits.push({ p: { t: "engagement", u: "https://example.com/", pv: `late${d}-${v}`, e: 5000 }, ts: t + 45 * MIN, ip, ua, country });
    }
  }
  hits.sort((a, b) => a.ts - b.ts);
  for (const h of hits) await send(h.p, h.ts, h.ip, h.ua, h.country);
}

const shapes: QueryInput[] = [];
const ALL = ["visitors", "sessions", "pageviews", "views_per_session", "bounce_rate", "avg_session_duration", "avg_engaged_time", "events", "revenue", "average_revenue", "revenue_per_visitor"] as const;
const PAGE = ["visitors", "sessions", "pageviews", "entries", "exits", "exit_rate", "scroll_depth", "avg_engaged_time"] as const;
for (const date_range of [{ from: DAY0, to: addDays(DAY0, DAYS - 1) }, { from: addDays(DAY0, 3), to: addDays(DAY0, 9) }, { from: addDays(DAY0, 5), to: addDays(DAY0, 5) }, "today", "7d", "mtd"] as QueryInput["date_range"][]) {
  shapes.push({ metrics: [...ALL], date_range, compare: "previous_period" });
  for (const d of ["day", "week", "month", "weekday", "hour", "datehour"]) shapes.push({ metrics: [...ALL], dimensions: [d], date_range, limit: 1000 });
  shapes.push({ metrics: ["visitors", "sessions"], dimensions: ["weekday", "hour"], date_range, limit: 200 });
  for (const d of ["page", "entry_page", "exit_page", "hostname"]) shapes.push({ metrics: [...PAGE], dimensions: [d], date_range, limit: 100 });
  for (const d of ["channel", "referrer_host", "source_name", "utm_source", "utm_medium", "utm_campaign", "country", "region", "city", "device", "browser", "os", "language"])
    shapes.push({ metrics: [...ALL], dimensions: [d], date_range, limit: 100 });
  shapes.push({ metrics: ["events", "visitors", "sessions"], dimensions: ["event_name"], date_range, limit: 100 });
  shapes.push({ metrics: ["sessions", "visitors"], dimensions: ["outbound_url"], date_range, limit: 100 });
  shapes.push({ metrics: ["pageviews"], dimensions: ["page"], date_range, limit: 3, order_by: ["pageviews", "asc"] });
  for (const goal of ["g_pricing", "g_signup", "g_out"]) {
    shapes.push({ metrics: ["conversions", "conversion_rate", "sessions", "visitors"], date_range, compare: "previous_period", goal });
    shapes.push({ metrics: ["conversions", "conversion_rate"], dimensions: ["day"], date_range, goal, limit: 1000 });
    shapes.push({ metrics: ["conversions"], dimensions: ["week"], date_range, goal, limit: 1000 });
  }
}

async function compareAll(now: number) {
  let viaRollup = 0;
  const state = await rollupState(db, SITE.id, now);
  for (const s of shapes) {
    const q = querySchema.parse(s);
    const raw = await runQuery(db, SITE, q, now, { raw: true });
    const rolled = await runQuery(db, SITE, q, now);
    // The same query merged into one statement (how overview and summary run) gives the same answer.
    const merged = (await runMerged(db, [await planQuery(db, SITE, q, now)])).results[0]!;
    expect({ rows: merged.rows, totals: merged.totals, comparison: merged.comparison }, `merged ${JSON.stringify(s.dimensions)}`).toEqual({ rows: rolled.rows, totals: rolled.totals, comparison: rolled.comparison });
    const label = JSON.stringify({ d: s.dimensions, r: s.date_range, g: s.goal });
    expect(rolled.rows, label).toEqual(raw.rows);
    expect(rolled.totals, label).toEqual(raw.totals);
    expect(rolled.comparison, label).toEqual(raw.comparison);
    const goal = await resolveGoal(db, SITE.id, q.goal);
    const spec = { metrics: q.metrics, dimensions: q.dimensions, filters: [], goal };
    if (buildRollupAggregate({ siteId: SITE.id, timeZone: SITE.timezone, tzMode: "site", range: raw.meta.date_range }, spec, state, SITE.timezone, now, typeof q.goal === "string" ? q.goal : null)) viaRollup++;
  }
  return viaRollup;
}

describe("daily rollups = raw engine", () => {
  beforeAll(async () => {
    invalidateSiteCache();
    invalidateRollupState();
    db = createD1();
    migrate(db);
    await insertSite(db, SITE);
    await generate();
    const goal = db.sqlite.prepare("INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES (?, ?, ?, ?, ?, 0)");
    goal.run("g_pricing", SITE.id, "Pricing", "pageview", JSON.stringify({ path: "/pricing" }));
    goal.run("g_signup", SITE.id, "Signup", "event", JSON.stringify({ event: "signup" }));
    goal.run("g_out", SITE.id, "Out", "outbound", JSON.stringify({ host: "github.com" }));
  }, 60_000);

  it("generated data has sessions and visitors that cross local midnight", () => {
    const crossing = db.sqlite.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IN (SELECT session_id FROM events GROUP BY session_id HAVING COUNT(DISTINCT local_day) > 1)").get() as { n: number };
    const visitors = db.sqlite.prepare("SELECT COUNT(*) AS n FROM (SELECT visitor_id FROM events GROUP BY visitor_id HAVING COUNT(DISTINCT local_day) > 1)").get() as { n: number };
    expect(crossing.n).toBeGreaterThan(0);
    expect(visitors.n).toBeGreaterThan(0);
  });

  it("before any build every query reads raw events", async () => {
    expect(await compareAll(NOW)).toBe(0);
  });

  it("closed and open days from stat_days", async () => {
    // Catch up (14 days per run), then the open days.
    for (let i = 0; i < 3; i++) await refreshRollups(db, [SITE], NOW);
    const st = await rollupState(db, SITE.id, NOW);
    expect(st?.built_through).toBe(addDays("2026-10-12", -1));
    expect(st?.open_to).toBe("2026-10-12");
    expect(await compareAll(NOW)).toBe(shapes.length);
    // The equality above is not vacuous: a changed stored row shows up in the answer.
    const q = querySchema.parse({ metrics: ["pageviews"], date_range: { from: DAY0, to: addDays(DAY0, 3) } });
    const before = (await runQuery(db, SITE, q, NOW)).totals.pageviews as number;
    db.sqlite.prepare("UPDATE stat_days SET pv = pv + 1000 WHERE dim = '' AND day = ?").run(addDays(DAY0, 2));
    expect((await runQuery(db, SITE, q, NOW)).totals.pageviews).toBe(before + 1000);
    await refreshRollups(db, [SITE], NOW);
    db.sqlite.prepare("UPDATE stat_state SET built_through = ?").run(addDays(DAY0, 1));
    await refreshRollups(db, [SITE], NOW);
    invalidateRollupState();
    expect((await runQuery(db, SITE, q, NOW)).totals.pageviews).toBe(before);
  }, 60_000);

  it("days newer than the stored rows are computed from raw events in the same statement", async () => {
    // As if the cron stalled: closed only through day 6, open rows stale.
    db.sqlite.prepare("UPDATE stat_state SET built_through = ?, goals_through = ?, open_built_at = ?").run(addDays(DAY0, 6), addDays(DAY0, 6), NOW - 3600_000);
    invalidateRollupState();
    expect(await compareAll(NOW)).toBe(shapes.length);
    invalidateRollupState();
  }, 60_000);
});

describe("goal rollups follow goal edits", () => {
  it("an edited goal reads raw until its rows are rebuilt, then the rollup again", async () => {
    await refreshRollups(db, [SITE], NOW);
    db.sqlite.prepare("UPDATE goals SET definition_json = ? WHERE id = 'g_signup'").run(JSON.stringify({ event: "share" }));
    invalidateRollupState();
    const q = querySchema.parse({ metrics: ["conversions", "conversion_rate"], date_range: { from: DAY0, to: "2026-10-12" }, goal: "g_signup" });
    const raw = await runQuery(db, SITE, q, NOW, { raw: true });
    expect((await runQuery(db, SITE, q, NOW)).totals).toEqual(raw.totals);
    // Rebuild the goal rows (they catch up separately), then every shape again.
    for (let i = 0; i < 2; i++) await refreshRollups(db, [SITE], NOW);
    expect(await compareAll(NOW)).toBe(shapes.length);
  }, 60_000);
});

describe("overview: the whole site view in one D1 batch", () => {
  it("matches the engine panel by panel and stays within the statement budget", async () => {
    await refreshRollups(db, [SITE], NOW);
    const range = { from: addDays(DAY0, 4), to: "2026-10-12" };
    // Count the D1 statements the overview runs (batched ones count one each).
    let statements = 0;
    const counted = new Proxy(db, {
      get(t, k) {
        if (k === "prepare") return (sql: string) => { statements++; return t.prepare(sql); };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const o = await overview(counted, SITE, { date_range: range }, NOW);
    // Target (docs/PERFORMANCE.md): at most 8 statements; merged statements stay within D1's 100 parameters.
    expect(statements).toBeLessThanOrEqual(8);
    expect(o.meta.d1.statements).toBeLessThanOrEqual(statements);
    const kpi = await runQuery(db, SITE, querySchema.parse({ metrics: [...OVERVIEW_KPIS], date_range: range, compare: "previous_period" }), NOW, { raw: true });
    for (const m of OVERVIEW_KPIS) expect(o.kpis[m], m).toEqual(expect.objectContaining({ value: kpi.totals[m], previous: kpi.comparison!.totals[m] }));
    for (const [p, spec] of Object.entries(OVERVIEW_PANELS)) {
      const r = await runQuery(db, SITE, querySchema.parse({ metrics: spec.metrics, dimensions: spec.dimensions, date_range: range, limit: p === "weekday_hour" ? 200 : 10 }), NOW, { raw: true });
      expect(o.breakdowns[p], p).toEqual(r.rows);
    }
    const series = await runQuery(db, SITE, querySchema.parse({ metrics: [...OVERVIEW_KPIS], dimensions: ["day"], date_range: range, limit: 1000 }), NOW, { raw: true });
    expect(o.timeseries.series.filter((r) => Number(r.sessions) > 0)).toEqual(series.rows);
    for (const g of o.goals) {
      const r = await runQuery(db, SITE, querySchema.parse({ metrics: ["conversions", "conversion_rate"], date_range: range, goal: g.id, compare: "previous_period" }), NOW, { raw: true });
      expect([g.conversions, g.conversion_rate, g.previous?.conversions], g.id).toEqual([r.totals.conversions, r.totals.conversion_rate, r.comparison!.totals.conversions]);
    }
  }, 60_000);
});

describe("sites summary: every site's card in one D1 batch", () => {
  it("matches the engine and merges every site's queries into one statement", async () => {
    const { sitesSummary } = await import("../../src/worker/query/home.ts");
    await refreshRollups(db, [SITE], NOW);
    const site = { ...SITE, settings: { ...SITE.settings, primary_goal: "g_pricing" } };
    let batches = 0;
    const counted = new Proxy(db, {
      get(t, k) {
        if (k === "batch") return (s: D1PreparedStatement[]) => { batches++; return t.batch(s as never); };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const r = await sitesSummary({ DB: counted } as never, [site], [site], "7d", NOW);
    const card = r.sites[0]!;
    const raw = (input: QueryInput) => runQuery(db, site, querySchema.parse(input), NOW, { raw: true });
    const kpi = await raw({ metrics: ["visitors", "pageviews"], date_range: "7d", compare: "previous_period" });
    expect(card.visitors).toMatchObject({ value: kpi.totals.visitors, previous: kpi.comparison!.totals.visitors });
    const today = await raw({ metrics: ["visitors"], date_range: "today", compare: "previous_period" });
    expect(card.today).toMatchObject({ visitors: today.totals.visitors, same_time_yesterday: today.comparison!.totals.visitors });
    const goal = await raw({ metrics: ["conversions"], date_range: "7d", goal: "g_pricing" });
    expect(card.goal?.conversions).toBe(goal.totals.conversions);
    const top = await raw({ metrics: ["visitors"], dimensions: ["page"], date_range: "7d", limit: 1 });
    expect(card.top_page?.page).toBe(top.rows[0]!.page);
    expect(card.series).toHaveLength(7);
    expect(card.hours.today).toHaveLength(24);
    expect(r.totals.visitors.value).toBe(card.visitors.value);
    expect(batches).toBe(1); // one round trip: the merged report query plus the last-event lookups
  });
});

describe("merged statements and D1's parameter limit", () => {
  it("packs parts in order into statements of at most 100 parameters", async () => {
    const { packParts } = await import("../../src/worker/query/run.ts");
    const part = (n: number) => ({ sql: "SELECT 1", params: Array.from({ length: n }, () => 0), cols: ["x"] });
    const groups = packParts([part(40), part(40), part(30), part(100), part(1)] as never);
    expect(groups.map((g) => g.map((p) => p.params.length))).toEqual([[40, 40], [30], [100], [1]]);
    expect(() => packParts([part(101)] as never)).toThrow(/101 parameters/);
  });
});

describe("merged statements and D1's compound SELECT limit", () => {
  it("nests UNION ALL so no compound has more than 5 terms, keeping the order", async () => {
    const { unionAll } = await import("../../src/worker/query/run.ts");
    const { maxCompoundTerms, createD1: make } = await import("./d1-shim.ts");
    for (const n of [1, 5, 6, 25, 26, 40]) {
      const sql = unionAll(Array.from({ length: n }, (_, i) => `SELECT ${i} AS x`));
      expect(maxCompoundTerms(sql), `n=${n}`).toBeLessThanOrEqual(5);
      const d = make();
      const { results } = await d.prepare(sql).all<{ x: number }>();
      expect(results.map((r) => r.x)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
    const six = Array.from({ length: 6 }, (_, i) => `SELECT ${i}`).join(" UNION ALL ");
    await expect(make().prepare(six).all()).rejects.toThrow(/too many terms in compound SELECT/);
    expect(maxCompoundTerms("SELECT 'a UNION b' UNION ALL SELECT (SELECT 1 UNION SELECT 2)")).toBe(2);
  });
});

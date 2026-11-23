import { beforeEach, describe, expect, it } from "vitest";
import { invalidateSiteCache } from "../../src/worker/lib/sites.ts";
import { funnel } from "../../src/worker/query/analyses.ts";
import { breakdown, summary, timeseries } from "../../src/worker/query/presets.ts";
import { overview } from "../../src/worker/query/overview.ts";
import { importBatch } from "../../src/worker/api/import.ts";
import { runQuery } from "../../src/worker/query/run.ts";
import { querySchema, type QueryInput } from "../../src/worker/query/schema.ts";
import { compareRange } from "../../src/worker/query/range.ts";
import { createD1, migrate } from "./d1-shim.ts";
import { CHROME, IPHONE, OTHER, SITE, hit, insertSite } from "./fixtures.ts";

const T0 = Date.UTC(2026, 9, 12, 10, 0, 0); // 12:00 Madrid
const MIN = 60_000;
let db: ReturnType<typeof createD1>;

const q = (input: QueryInput, site = SITE) => runQuery(db, site, querySchema.parse(input), T0 + 3 * 3600_000);

beforeEach(async () => {
  invalidateSiteCache();
  db = createD1();
  migrate(db);
  await insertSite(db, SITE);
  await insertSite(db, OTHER);
  // Visitor A (desktop, from Google): 3 pageviews in one session + engagement + event + outbound.
  await hit(db, { u: "https://example.com/?utm_source=x&secret=1", r: "https://www.google.com/search?q=a", pv: "p1" }, T0);
  await hit(db, { t: "engagement", u: "https://example.com/", pv: "p1", e: 20_000, sc: 80 }, T0 + 1 * MIN);
  await hit(db, { u: "https://example.com/pricing", r: "https://example.com/", pv: "p2" }, T0 + 2 * MIN);
  await hit(db, { t: "event", n: "start_free", p: { place: "hero" }, u: "https://example.com/pricing" }, T0 + 3 * MIN);
  await hit(db, { t: "outbound", x: "https://reservaentradas.com/x?y=1", u: "https://example.com/pricing" }, T0 + 4 * MIN);
  await hit(db, { u: "https://example.com/about", pv: "p3" }, T0 + 5 * MIN);
  // Visitor B (iPhone, ChatGPT): one bounced pageview.
  await hit(db, { u: "https://example.com/pricing", r: "https://chatgpt.com/" }, T0 + 10 * MIN, { ip: "198.51.100.1", ua: IPHONE });
  // Visitor A again after 40 min: new session.
  await hit(db, { u: "https://example.com/", pv: "p4" }, T0 + 50 * MIN);
  // Vitals
  for (const [i, lcp] of [1000, 2000, 3000, 4000].entries())
    await hit(db, { t: "vitals", u: "https://example.com/", v: { lcp } }, T0 + (60 + i) * MIN, { ip: `192.0.2.${i}` });
  // Other site's data must never leak.
  await hit(db, { u: "https://other.com/" }, T0, {}, OTHER);
});

describe("query engine", () => {
  it("rolling windows: 24h, last_minutes, datehour and weekday", async () => {
    const day = await q({ metrics: ["pageviews", "visitors"], date_range: "today" });
    const h24 = await q({ metrics: ["pageviews", "visitors"], date_range: "24h" });
    expect(h24.totals).toEqual(day.totals);
    expect(h24.meta.date_range.ts).toBeTruthy();
    // now = T0 + 3 h; the last 2 hours hold only vitals hits, no pageviews.
    const recent = await q({ metrics: ["pageviews"], date_range: { last_minutes: 120 } });
    expect(recent.totals.pageviews).toBe(0);
    const hours = await q({ metrics: ["pageviews"], dimensions: ["datehour"], date_range: "24h" });
    expect(hours.rows.map((r) => r.datehour)).toEqual(["2026-10-12 12"]);
    const wd = await q({ metrics: ["pageviews"], dimensions: ["weekday"], date_range: "today" });
    expect(wd.rows).toEqual([{ weekday: 1, pageviews: day.totals.pageviews }]);
    const cmp = await q({ metrics: ["pageviews"], date_range: "24h", compare: "previous_period" });
    expect(cmp.comparison?.date_range.ts?.to).toBe(h24.meta.date_range.ts?.from);
  });

  it("totals", async () => {
    const r = await q({ metrics: ["visitors", "sessions", "pageviews", "events", "bounce_rate", "views_per_session"], date_range: "today" });
    expect(r.totals).toMatchObject({ visitors: 2, sessions: 3, pageviews: 5, events: 1 });
    // sessions: A1 (3 pv, engaged 20s, not bounce), B (1 pv bounce), A2 (1 pv bounce)
    expect(r.totals.bounce_rate).toBeCloseTo(66.7, 1);
    expect(r.meta.source_counts).toBeUndefined();
    expect((await q({ metrics: ["pageviews"], date_range: "today", source_counts: true })).meta.source_counts?.pulse).toBeGreaterThan(0);
  });

  it("vitals-only sessions are not counted as sessions", async () => {
    const r = await q({ metrics: ["sessions"], date_range: "today" });
    expect(r.totals.sessions).toBe(3);
  });

  it("tenant isolation", async () => {
    const r = await q({ metrics: ["pageviews"], date_range: "today" }, OTHER);
    expect(r.totals.pageviews).toBe(1);
  });

  it("page breakdown with entries/exits", async () => {
    const r = await q({ metrics: ["pageviews", "visitors", "entries", "exits"], dimensions: ["page"], date_range: "today" });
    const byPage = Object.fromEntries(r.rows.map((x) => [x.page, x]));
    expect(byPage["/"]).toMatchObject({ pageviews: 2, entries: 2 });
    expect(byPage["/pricing"]).toMatchObject({ pageviews: 2, visitors: 2, entries: 1 });
    expect(byPage["/about"]).toMatchObject({ pageviews: 1, exits: 1 });
    expect(r.rows[0]!.pageviews).toBeGreaterThanOrEqual(r.rows[1]!.pageviews as number);
  });

  it("sum of page breakdown pageviews = total", async () => {
    const r = await q({ metrics: ["pageviews"], dimensions: ["page"], date_range: "today" });
    expect(r.rows.reduce((a, x) => a + (x.pageviews as number), 0)).toBe(r.totals.pageviews);
  });

  it("channels", async () => {
    const r = await q({ metrics: ["sessions"], dimensions: ["channel"], date_range: "today" });
    const m = Object.fromEntries(r.rows.map((x) => [x.channel, x.sessions]));
    expect(m).toEqual({ "Organic Search": 1, "AI Assistants": 1, Direct: 1 });
  });

  it("source_name splits channels into named engines and networks", async () => {
    const r = await q({ metrics: ["sessions"], dimensions: ["source_name"], date_range: "today" });
    const m = Object.fromEntries(r.rows.map((x) => [String(x.source_name), x.sessions]));
    expect(m).toEqual({ Google: 1, ChatGPT: 1, null: 1 });
    const search = await q({ metrics: ["sessions"], dimensions: ["source_name"], filters: [["is", "channel", ["Organic Search"]]], date_range: "today" });
    expect(search.rows).toEqual([{ source_name: "Google", sessions: 1 }]);
    expect((await q({ metrics: ["pageviews"], filters: [["is", "source_name", ["Google"]]], date_range: "today" })).totals.pageviews).toBe(3);
  });

  it("filters: is / is_not / contains / starts_with", async () => {
    expect((await q({ metrics: ["pageviews"], filters: [["is", "page", ["/pricing"]]], date_range: "today" })).totals.pageviews).toBe(2);
    expect((await q({ metrics: ["pageviews"], filters: [["is_not", "page", ["/pricing"]]], date_range: "today" })).totals.pageviews).toBe(3);
    expect((await q({ metrics: ["pageviews"], filters: [["contains", "page", ["ric"]]], date_range: "today" })).totals.pageviews).toBe(2);
    expect((await q({ metrics: ["pageviews"], filters: [["starts_with", "page", ["/a"]]], date_range: "today" })).totals.pageviews).toBe(1);
    expect((await q({ metrics: ["visitors"], filters: [["is", "device", ["mobile"]]], date_range: "today" })).totals.visitors).toBe(1);
    expect((await q({ metrics: ["pageviews"], filters: [["is", "referrer_host", ["(none)"]]], date_range: "today" })).totals.pageviews).toBe(1);
  });

  it("LIKE wildcards in values are literal", async () => {
    expect((await q({ metrics: ["pageviews"], filters: [["contains", "page", ["%"]]], date_range: "today" })).totals.pageviews).toBe(0);
  });

  it("event filters are session-level", async () => {
    const r = await q({ metrics: ["pageviews", "sessions"], filters: [["is", "event_name", ["start_free"]]], date_range: "today" });
    expect(r.totals).toMatchObject({ sessions: 1, pageviews: 3 });
  });

  it("event name and props dimensions", async () => {
    const r = await q({ metrics: ["events"], dimensions: ["event_name"], date_range: "today" });
    expect(r.rows).toEqual([{ event_name: "start_free", events: 1 }]);
    const p = await q({ metrics: ["events"], dimensions: ["event_prop:place"], date_range: "today" });
    expect(p.rows).toEqual([{ "event_prop:place": "hero", events: 1 }]);
  });

  it("outbound url dimension strips query", async () => {
    const r = await q({ metrics: ["sessions"], dimensions: ["outbound_url"], date_range: "today" });
    expect(r.rows[0]!.outbound_url).toBe("https://reservaentradas.com/x");
  });

  it("goals and conversions", async () => {
    const r = await q({ metrics: ["conversions", "conversion_rate"], goal: { kind: "event", event: "start_free" }, date_range: "today" });
    expect(r.totals.conversions).toBe(1);
    expect(r.totals.conversion_rate).toBeCloseTo(33.33, 1);
    const g = await q({ metrics: ["conversions"], goal: { kind: "pageview", path: "/pric*" }, date_range: "today" });
    expect(g.totals.conversions).toBe(2);
    const o = await q({ metrics: ["conversions"], goal: { kind: "outbound", host: "reservaentradas,ocine" }, date_range: "today" });
    expect(o.totals.conversions).toBe(1);
    await expect(q({ metrics: ["conversions"], date_range: "today" })).rejects.toThrow(/goal/);
  });

  it("engagement and scroll", async () => {
    const r = await q({ metrics: ["avg_engaged_time", "scroll_depth"], date_range: "today" });
    expect(r.totals.avg_engaged_time).toBe(4); // 20 s / 5 pageviews
    expect(r.totals.scroll_depth).toBe(80);
  });

  it("vitals p75", async () => {
    const r = await q({ metrics: ["lcp_p75"], date_range: "today" });
    expect(r.totals.lcp_p75).toBe(3000);
    const b = await q({ metrics: ["lcp_p75", "pageviews"], dimensions: ["page"], date_range: "today" });
    expect(b.rows.find((x) => x.page === "/")!.lcp_p75).toBe(3000);
  });

  it("time series by hour and day", async () => {
    const r = await q({ metrics: ["pageviews"], dimensions: ["hour"], date_range: "today" });
    expect(r.rows.map((x) => [x.hour, x.pageviews])).toEqual([[12, 5]]);
    const u = await q({ metrics: ["pageviews"], dimensions: ["hour"], date_range: "today", timezone: "UTC" });
    expect(u.rows[0]!.hour).toBe(10);
  });

  it("comparison and pagination", async () => {
    const r = await q({ metrics: ["pageviews"], dimensions: ["page"], date_range: "today", compare: "previous_period", limit: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.next_cursor).toBeTruthy();
    expect(r.comparison?.totals.pageviews ?? 0).toBe(0);
    const r2 = await q({ metrics: ["pageviews"], dimensions: ["page"], date_range: "today", limit: 2, cursor: r.next_cursor! });
    expect(r2.rows).toHaveLength(1);
    expect(r2.next_cursor).toBeNull();
  });

  it("devices and browsers come from the session", async () => {
    const r = await q({ metrics: ["visitors"], dimensions: ["device", "browser"], date_range: "today" });
    expect(r.rows).toContainEqual({ device: "desktop", browser: "Chrome", visitors: 1 });
    expect(r.rows).toContainEqual({ device: "mobile", browser: "Mobile Safari", visitors: 1 });
  });

  it("chrome UA constant is desktop", () => {
    expect(CHROME).toContain("Windows");
  });

  it("wildcard matches, is_one_of, and LIKE characters stay literal", async () => {
    const pv = async (filters: QueryInput["filters"]) => (await q({ metrics: ["pageviews"], date_range: "today", filters })).totals.pageviews;
    expect(await pv([["matches", "page", ["/pri*"]]])).toBe(2);
    expect(await pv([["not_matches", "page", ["/pri*"]]])).toBe(3);
    expect(await pv([["matches", "page", ["/pric_ng"]]])).toBe(0);
    expect(await pv([["matches", "page", ["%"]]])).toBe(0);
    expect(await pv([["is_one_of", "page", ["/", "/about"]]])).toBe(3);
    // Session-level: sessions with a matching event, and without.
    expect((await q({ metrics: ["sessions"], date_range: "today", filters: [["matches", "event_name", ["start_*"]]] })).totals.sessions).toBe(1);
    expect((await q({ metrics: ["sessions"], date_range: "today", filters: [["not_matches", "event_name", ["start_*"]]] })).totals.sessions).toBe(2);
  });

  it("goal filters keep sessions that converted (or didn't), scoped to the site", async () => {
    db.sqlite.prepare("INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES ('g1', 'test', 'Start', 'event', '{\"event\":\"start_free\"}', 0)").run();
    db.sqlite.prepare("INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES ('g2', 'other', 'Theirs', 'pageview', '{\"path\":\"/\"}', 0)").run();
    expect((await q({ metrics: ["sessions"], date_range: "today", filters: [["is", "goal", ["g1"]]] })).totals.sessions).toBe(1);
    expect((await q({ metrics: ["sessions"], date_range: "today", filters: [["is_not", "goal", ["g1"]]] })).totals.sessions).toBe(2);
    await expect(q({ metrics: ["sessions"], date_range: "today", filters: [["is", "goal", ["g2"]]] })).rejects.toThrow(/goal not found/);
    expect(() => querySchema.parse({ metrics: ["sessions"], filters: [["contains", "goal", ["g1"]]] })).toThrow();
  });

  it("hour and weekday comparisons align by value, not position", async () => {
    // The comparison day has a single hit at a different hour; it must not be paired with the main day's hour.
    await hit(db, { u: "https://example.com/" }, T0 - 86_400_000 + 5 * 3600_000, { ip: "192.0.2.200" });
    const r = await q({ metrics: ["pageviews"], dimensions: ["hour"], date_range: "today", compare: "previous_period" });
    expect(r.rows.map((x) => x.hour)).toEqual([12]);
    expect(r.comparison?.rows).toEqual([{ hour: 12 }]);
  });

  it("compares with explicit days", async () => {
    const r = await q({ metrics: ["pageviews"], date_range: "today", compare: { from: "2026-10-05", to: "2026-10-05" } });
    expect(r.comparison?.date_range).toEqual({ from: "2026-10-05", to: "2026-10-05" });
    expect(r.comparison?.totals.pageviews ?? 0).toBe(0);
    expect(() => querySchema.parse({ metrics: ["pageviews"], compare: { from: "2026-10-06", to: "2026-10-05" } })).toThrow();
  });

  it("breakdown search narrows the values", async () => {
    const r = await breakdown(db, SITE, { date_range: "today", timezone: "site", filters: [], compare: null, dimension: "page", metrics: ["pageviews"], search: "pri" }, T0 + 3 * 3600_000);
    expect(r.rows.map((x) => x.page)).toEqual(["/pricing"]);
  });

  it("funnels: strict order, comparison and a breakdown by device", async () => {
    const now = T0 + 3 * 3600_000;
    const base = { date_range: "today" as const, timezone: "site" as const, filters: [], window_minutes: 30 };
    const homeToAbout = [{ match: { kind: "pageview" as const, path: "/" } }, { match: { kind: "pageview" as const, path: "/about" } }];
    const flex = await funnel(db, SITE, { ...base, steps: homeToAbout }, now);
    expect(flex.steps.map((s) => s.sessions)).toEqual([2, 1]);
    const strict = await funnel(db, SITE, { ...base, steps: homeToAbout, step_order: "strict" }, now);
    expect(strict.steps.map((s) => s.sessions)).toEqual([2, 0]);
    const homeToPricing = [{ match: { kind: "pageview" as const, path: "/" } }, { match: { kind: "pageview" as const, path: "/pricing" } }];
    expect((await funnel(db, SITE, { ...base, steps: homeToPricing, step_order: "strict" }, now)).steps.map((s) => s.sessions)).toEqual([2, 1]);
    const cmp = await funnel(db, SITE, { ...base, steps: homeToPricing, compare: "previous_period", breakdown: "device" }, now);
    expect(cmp.comparison?.steps.map((s) => s.sessions)).toEqual([0, 0]);
    expect(cmp.breakdown?.rows).toEqual([{ value: "desktop", sessions: [2, 1], conversion_pct: 50 }]);
    // Campaign tags beyond source and campaign (cold email: email 3 vs reply links) split a funnel too.
    for (const dimension of ["utm_medium", "utm_content"] as const) {
      const byTag = await funnel(db, SITE, { ...base, steps: homeToPricing, breakdown: dimension }, now);
      expect(byTag.breakdown?.dimension).toBe(dimension);
      expect(byTag.breakdown?.rows.reduce((n, row) => n + row.sessions[0]!, 0)).toBe(2);
    }
  });
});

// Comparison periods.
describe("comparison periods", () => {
  it("2.15 whole months compare with the calendar month before; a month to date with the same days of last month", () => {
    expect(compareRange({ from: "2026-10-01", to: "2026-10-31" }, "previous_period")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(compareRange({ from: "2026-03-01", to: "2026-03-31" }, "previous_period")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(compareRange({ from: "2026-08-01", to: "2026-10-31" }, "previous_period")).toEqual({ from: "2026-05-01", to: "2026-07-31" });
    expect(compareRange({ from: "2026-10-01", to: "2026-10-12" }, "previous_period")).toEqual({ from: "2026-09-01", to: "2026-09-12" });
    expect(compareRange({ from: "2026-03-01", to: "2026-03-31" }, "previous_period").to).toBe("2026-02-28");
    expect(compareRange({ from: "2026-05-01", to: "2026-05-31" }, "previous_period")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
    // Other ranges keep the same number of days just before.
    expect(compareRange({ from: "2026-10-05", to: "2026-10-11" }, "previous_period")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
  });

  it("2.14 a range that ends today compares with the same time of day, not whole days", async () => {
    // now = 15:00 Madrid on 12 Oct; yesterday had a pageview at 12:00 and one at 20:00.
    const now = T0 + 3 * 3600_000;
    const r = compareRange({ from: "2026-10-12", to: "2026-10-12" }, "previous_period", "Europe/Madrid", now);
    expect(r).toMatchObject({ from: "2026-10-11", to: "2026-10-11", until: now - 86_400_000 });
    await hit(db, { u: "https://example.com/y1" }, T0 - 86_400_000, { ip: "192.0.2.50" });
    await hit(db, { u: "https://example.com/y2" }, T0 - 86_400_000 + 8 * 3600_000, { ip: "192.0.2.51" });
    const today = await q({ metrics: ["pageviews", "visitors"], date_range: "today", compare: "previous_period" });
    expect(today.comparison?.totals).toMatchObject({ pageviews: 1, visitors: 1 });
    // A closed range compares whole days.
    const y = await q({ metrics: ["pageviews"], date_range: { from: "2026-10-12", to: "2026-10-12" }, compare: { from: "2026-10-11", to: "2026-10-11" } });
    expect(y.comparison?.totals.pageviews).toBe(2);
  });
});

describe("time series", () => {
  const now = T0 + 3 * 3600_000; // 15:00 Madrid, 12 Oct
  const ts = (date_range: QueryInput["date_range"], interval: "hour" | "day" | "week" | "month", compare: "previous_period" | null = null) =>
    timeseries(db, SITE, { date_range, timezone: "site", filters: [], compare, metrics: ["pageviews", "bounce_rate"], interval }, now);

  it("2.13 the comparison is filled and aligned by date, so a gap in the previous period doesn't shift it", async () => {
    // Previous period of 6–12 Oct is 29 Sep–5 Oct; its only traffic is on 1 Oct (the third day).
    await hit(db, { u: "https://example.com/old" }, Date.UTC(2026, 9, 1, 10), { ip: "192.0.2.60" });
    const r = await ts({ from: "2026-10-06", to: "2026-10-12" }, "day", "previous_period");
    expect(r.series).toHaveLength(7);
    expect(r.comparison!.series.map((x) => x.day)).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(r.comparison!.series.map((x) => x.pageviews)).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });

  it("2.16 hours, weeks and months are filled; an empty interval has no bounce rate (null), not 0", async () => {
    const hours = await ts("today", "hour");
    expect(hours.series.map((x) => x.hour)).toEqual(Array.from({ length: 16 }, (_, h) => h)); // up to the current hour
    expect(hours.series[3]).toEqual({ hour: 3, pageviews: 0, bounce_rate: null });
    expect(hours.series[12]!.pageviews).toBe(5);
    const weeks = await ts({ from: "2026-09-01", to: "2026-10-12" }, "week");
    expect(weeks.series.map((x) => x.week)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
    const months = await ts({ from: "2026-08-15", to: "2026-10-12" }, "month");
    expect(months.series.map((x) => x.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(months.series[0]).toEqual({ month: "2026-08", pageviews: 0, bounce_rate: null });
    const empty = await q({ metrics: ["pageviews", "bounce_rate"], date_range: { from: "2026-08-01", to: "2026-08-02" } });
    expect(empty.totals).toEqual({ pageviews: 0, bounce_rate: null });
  });
});

describe("scroll depth", () => {
  it("2.6 is the deepest scroll of each pageview, averaged over pageviews (not over beacons)", async () => {
    const t = Date.UTC(2026, 9, 20, 10);
    const ip = { ip: "192.0.2.70" };
    await hit(db, { u: "https://example.com/long", pv: "s1" }, t, ip);
    // The tab was hidden three times: three beacons, each with the deepest scroll so far.
    for (const [i, sc] of [10, 20, 90].entries()) await hit(db, { t: "engagement", u: "https://example.com/long", pv: "s1", e: 2000, sc }, t + (i + 1) * MIN, ip);
    await hit(db, { u: "https://example.com/short", pv: "s2" }, t + 5 * MIN, ip);
    await hit(db, { t: "engagement", u: "https://example.com/short", pv: "s2", e: 2000, sc: 50 }, t + 6 * MIN, ip);
    const r = await q({ metrics: ["scroll_depth"], dimensions: ["page"], date_range: { from: "2026-10-20", to: "2026-10-20" } });
    expect(r.totals.scroll_depth).toBe(70);
    expect(Object.fromEntries(r.rows.map((x) => [x.page, x.scroll_depth]))).toEqual({ "/long": 90, "/short": 50 });
  });
});

describe("sessions", () => {
  it("2.9 a beacon after the session window joins the visitor's session instead of opening an empty one", async () => {
    const t = Date.UTC(2026, 9, 21, 9);
    const ip = { ip: "192.0.2.80" };
    await hit(db, { u: "https://example.com/read", r: "https://www.google.com/", pv: "b1" }, t, ip);
    // The tab stays hidden 45 minutes, then closes: engagement and vitals arrive after the 30-minute window.
    await hit(db, { t: "engagement", u: "https://example.com/read", pv: "b1", e: 25_000, sc: 60 }, t + 45 * MIN, ip);
    await hit(db, { t: "vitals", u: "https://example.com/read", v: { lcp: 900 } }, t + 45 * MIN + 1000, ip);
    const day = { from: "2026-10-21", to: "2026-10-21" };
    const r = await q({ metrics: ["sessions", "visitors", "bounce_rate", "avg_engaged_time"], date_range: day });
    expect(r.totals).toMatchObject({ sessions: 1, visitors: 1, bounce_rate: 0, avg_engaged_time: 25 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE local_day = '2026-10-21'").get()).toEqual({ n: 1 });
    const ch = await q({ metrics: ["sessions"], dimensions: ["channel"], date_range: day });
    expect(ch.rows).toEqual([{ channel: "Organic Search", sessions: 1 }]);
  });
});

describe("data-quality annotations", () => {
  it("2.17 a metric changed by a marker between the periods shows no change; others do", async () => {
    const now = T0 + 3 * 3600_000;
    await hit(db, { u: "https://example.com/y" }, T0 - 86_400_000, { ip: "192.0.2.90" });
    db.sqlite
      .prepare("INSERT INTO annotations (id, site_id, ts, title, category, affects, created_by, created_at) VALUES ('dq', 'test', ?, 'Tracking switched', 'data', '[\"bounce_rate\",\"avg_engaged_time\"]', 'test', 0)")
      .run(T0 - 12 * 3600_000);
    const c = { date_range: "today" as const, timezone: "site" as const, filters: [], compare: "previous_period" as const };
    for (const r of [await summary(db, SITE, c, now), await overview(db, SITE, c, now)]) {
      const k = r.kpis as Record<string, { change_pct: number | null; not_comparable?: string }>;
      expect(k.bounce_rate).toMatchObject({ change_pct: null, not_comparable: "Tracking switched" });
      expect(k.pageviews!.not_comparable).toBeUndefined();
      expect(k.pageviews!.change_pct).toBe(400);
    }
    // Outside the two periods it changes nothing.
    db.sqlite.prepare("UPDATE annotations SET ts = ? WHERE id = 'dq'").run(T0 - 10 * 86_400_000);
    const k = (await summary(db, SITE, c, now)).kpis as Record<string, { not_comparable?: string }>;
    expect(k.bounce_rate!.not_comparable).toBeUndefined();
  });
});

describe("imports", () => {
  it("2.17 a finished import marks where its data ends (bounce and time measures change there)", async () => {
    const base = { site_id: "test", source: "rybbit" as const, import_id: "imp1", sessions: [], events: [] };
    await importBatch(db, { ...base, range_from: "2026-06-01", range_to: "2026-10-11" }, "test");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM annotations").get()).toEqual({ n: 0 });
    await importBatch(db, { ...base, final: true }, "test");
    const a = db.sqlite.prepare("SELECT ts, category, affects FROM annotations").get() as { ts: number; category: string; affects: string };
    expect(a).toMatchObject({ ts: Date.UTC(2026, 9, 12), category: "data" });
    expect(JSON.parse(a.affects)).toContain("bounce_rate");
  });
});

describe("site data range", () => {
  it("2.18 the last event is fresh and reading it writes nothing", async () => {
    const { dataRange, dataCounts } = await import("../../src/worker/api/sites.ts");
    const before = db.sqlite.prepare("SELECT COUNT(*) AS n FROM kv_meta").get();
    const t = Date.UTC(2026, 9, 22, 9);
    await hit(db, { u: "https://example.com/new" }, t, { ip: "192.0.2.95" });
    expect((await dataRange(db, "test")).last_event).toBe(new Date(t).toISOString());
    await hit(db, { u: "https://example.com/newer" }, t + 60_000, { ip: "192.0.2.95" });
    expect((await dataRange(db, "test")).last_event).toBe(new Date(t + 60_000).toISOString());
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM kv_meta").get()).toEqual(before);
    await dataCounts(db, ["test"], t);
    expect((await dataRange(db, "test")).live_events).toBeGreaterThan(0);
  });
});

describe("live", () => {
  it("the realtime count and its visit list share one window; visits carry no ids", async () => {
    const { realtime } = await import("../../src/worker/query/presets.ts");
    const { liveVisits } = await import("../../src/worker/query/live.ts");
    const now = T0 + 12 * MIN; // visitor B's hit (T0+10 min) is active; A's last session (T0+50) hasn't happened yet
    const r = await realtime(db, SITE, now);
    expect(r.visitors).toBe(r.visits.filter((v) => v.active).length > 0 ? new Set(r.visits.filter((v) => v.active).map((v) => v.device)).size : 0);
    expect(r.visits.length).toBeGreaterThan(0);
    expect(r.visits[0]).not.toHaveProperty("session_id");
    expect(JSON.stringify(r.visits)).not.toMatch(/visitor/);
    const all = await liveVisits(db, [SITE, OTHER], now);
    expect(all.per_site.map((s) => s.site)).toEqual(["test", "other"]);
    expect(all.visits.every((v) => v.site === "test" || v.site === "other")).toBe(true);
  });
});

describe("what changed", () => {
  it("compares a day with the same weekday a week before and names what drove it", async () => {
    const { planChanges } = await import("../../src/worker/query/changes.ts");
    const { runMerged } = await import("../../src/worker/query/run.ts");
    const now = T0 + 8 * 86_400_000; // 2026-10-20: yesterday is 2026-10-19, compared with 2026-10-12
    const p = await planChanges(db, SITE, now);
    const c = p.finish((await runMerged(db, p.plans)).results);
    const before = await q({ date_range: { from: "2026-10-12", to: "2026-10-12" }, metrics: ["visitors"] });
    expect(c).toMatchObject({ date: "2026-10-19", compared_with: "2026-10-12", visitors: { value: 0, previous: before.totals.visitors, change_pct: -100 } });
    expect(c.drivers.length).toBeGreaterThan(0);
    expect(c.drivers.every((d) => d.change < 0)).toBe(true);
    expect(c.sentence).toMatch(/^0 visitors on 2026-10-19, -100% against 2026-10-12 \(/);
    const same = await planChanges(db, SITE, now, "2026-10-12");
    expect(same.finish((await runMerged(db, same.plans)).results).visitors.value).toBe(before.totals.visitors);
  });
});

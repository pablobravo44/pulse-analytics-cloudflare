// Raw event export (REST stream and MCP pages) and CSV of query results.
import { beforeEach, describe, expect, it } from "vitest";
import { EXPORT_PAGE_SQL, exportRows } from "../../src/worker/api/export.ts";
import { createApiKey } from "../../src/worker/auth/apikeys.ts";
import { hit, insertSite, OTHER, SITE } from "./fixtures.ts";
import { makeEnv } from "./harness.ts";

let h: ReturnType<typeof makeEnv>;
let exporter: string;
let reader: string;

const get = (path: string, k: string) => h.call(path, { headers: { Authorization: `Bearer ${k}` } });

beforeEach(async () => {
  h = makeEnv();
  await insertSite(h.db, SITE);
  await insertSite(h.db, OTHER);
  exporter = (await createApiKey(h.db, { name: "x", scopes: ["stats:read", "events:export"], siteIds: null, createdBy: "test" })).key;
  reader = (await createApiKey(h.db, { name: "r", scopes: ["stats:read"], siteIds: null, createdBy: "test" })).key;
});

describe("raw export", () => {
  it("streams every row of the range in order, as NDJSON or CSV, past one page", async () => {
    const day = Date.UTC(2026, 9, 14, 8);
    for (let i = 0; i < 1203; i++) await hit(h.db, { u: `https://example.com/p${i % 7}` }, day + i * 1000);
    await hit(h.db, { u: "https://example.com/next-day" }, Date.UTC(2026, 9, 15, 8));
    await hit(h.db, { u: "https://other.com/x" }, day, {}, OTHER);
    const nd = await get("/api/v1/sites/test/export?from=2026-10-14&to=2026-10-14", exporter);
    expect(nd.status).toBe(200);
    expect(nd.headers.get("content-type")).toContain("ndjson");
    const rows = (await nd.text()).trim().split("\n").map((l) => JSON.parse(l) as { ts: number; pathname: string });
    expect(rows).toHaveLength(1203);
    expect(rows.every((r, i) => i === 0 || r.ts >= rows[i - 1]!.ts)).toBe(true);
    expect(rows.some((r) => r.pathname === "/next-day")).toBe(false);
    const csv = await (await get("/api/v1/sites/test/export?from=2026-10-14&to=2026-10-15&format=csv", exporter)).text();
    const lines = csv.trim().split("\n");
    expect(lines[0]).toMatch(/^id,ts,local_day,type,/);
    expect(lines).toHaveLength(1 + 1204);
  });

  it("needs events:export, and a site-scoped key only exports its site", async () => {
    expect((await get("/api/v1/sites/test/export?from=2026-10-14&to=2026-10-14", reader)).status).toBe(403);
    const scoped = (await createApiKey(h.db, { name: "s", scopes: ["events:export", "stats:read"], siteIds: ["other"], createdBy: "test" })).key;
    expect((await get("/api/v1/sites/test/export?from=2026-10-14&to=2026-10-14", scoped)).status).toBe(404);
  });

  it("keeps the local day of a site far from UTC, and pages by (ts, id)", async () => {
    // 23:30 UTC on Oct 13 is Oct 14 in Madrid.
    await hit(h.db, { u: "https://example.com/late" }, Date.UTC(2026, 9, 13, 23, 30));
    const page = await exportRows(h.env.DB, "test", { from: "2026-10-14", to: "2026-10-14", limit: 10 });
    expect(page.map((r) => r.pathname)).toEqual(["/late"]);
    const after = await exportRows(h.env.DB, "test", { from: "2026-10-14", to: "2026-10-14", limit: 10, after: { ts: page[0]!.ts as number, id: page[0]!.id as string } });
    expect(after).toEqual([]);
  });

  it("query results download as CSV with the dimensions then the metrics", async () => {
    const day = Date.UTC(2026, 9, 14, 8);
    await hit(h.db, { u: "https://example.com/a" }, day);
    await hit(h.db, { u: "https://example.com/b,c" }, day + 1000);
    const res = await h.call("/api/v1/sites/test/query?format=csv", {
      method: "POST",
      headers: { Authorization: `Bearer ${reader}`, "Content-Type": "application/json" },
      body: JSON.stringify({ metrics: ["pageviews", "visitors"], dimensions: ["page"], date_range: { from: "2026-10-14", to: "2026-10-14" } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("test-2026-10-14-2026-10-14-page.csv");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe("page,pageviews,visitors");
    expect(lines.slice(1).sort()).toEqual(['"/b,c",1,1', "/a,1,1"].sort());
  });

  it("seeks on the (site_id, ts) index instead of sorting the whole range for each page", () => {
    const plan = (h.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${EXPORT_PAGE_SQL(false)}`).all("test", 0, 1, "a", "b", 0, 0, "", 10) as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan).toContain("events_site_ts");
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });
});

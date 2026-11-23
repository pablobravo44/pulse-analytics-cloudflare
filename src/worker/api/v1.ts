import { z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { canAccessSite, hasScope } from "../auth/principal.ts";
import { audit } from "../lib/audit.ts";
import { ulid } from "../lib/ids.ts";
import { listSitesCached } from "../lib/sites.ts";
import { errors, funnel, FUNNEL_BREAKDOWNS, pageReport, paths, retention, vitals } from "../query/analyses.ts";
import { aiSources, breakdown, movers, realtime, summary, timeseries } from "../query/presets.ts";
import { overview, OVERVIEW_PANELS, type Interval } from "../query/overview.ts";
import { sitesSummary, type HomeRange } from "../query/home.ts";
import { resolveRange } from "../query/range.ts";
import { runQuery } from "../query/run.ts";
import { dimensionSchema, METRICS, querySchema } from "../query/schema.ts";
import { ANNOTATION_CATEGORIES, annotationView, type AnnotationRow } from "../lib/annotations.ts";
import { ApiError, authenticate, cachedReport, errorResponse, jsonWithEtag, newApi, requireSite, type AppEnv, type Ctx } from "./common.ts";
import { r } from "./route.ts";
import { commonQuery, metricsParam, parseMetrics, siteParam, toCommon } from "./params.ts";
import { importBatch, importSchema } from "./import.ts";
import { deleteBody, deleteData } from "./deletedata.ts";
import { exportEvents, toCsv } from "./export.ts";
import { health, VERSION } from "./health.ts";
import { capabilitiesFor } from "../catalog.ts";
import { ingestDays, registerSites } from "./sites.ts";
import { deleteAnnotation, updateAnnotation, deleteFunnel, deleteGoal, funnelBody, getFunnel, goalBody, listFunnels, listGoals, saveFunnel, saveGoal } from "../lib/definitions.ts";
import { registerAdmin } from "./admin.ts";
import { registerOps } from "./ops.ts";
import { registerFeatures } from "./features.ts";

export const api = newApi();
api.onError((err, c) => errorResponse(c as Ctx, err));

api.use("*", authenticate);

// Before registerSites: /sites/summary must win over /sites/{site} ("summary" is a reserved site id).
api.openapi(
  r({
    method: "get",
    path: "/sites/summary",
    operationId: "getAllSitesSummary",
    tags: ["Stats"],
    description: "Every site you can access at a glance (the home page): visitors with change and series, today against the same time yesterday, live now, top page and source, main goal, errors in 24 h, LCP/CLS p75, uptime, last event; today's visitors per hour per site. One D1 query for all sites, cached 60 s.",
    request: { query: z.object({ date_range: z.enum(["today", "7d", "30d"]).optional().openapi({ description: "Default 7d" }), include_hidden: z.enum(["true", "false"]).optional() }) },
    scope: "stats:read",
  }),
  async (c) => {
    const p = c.get("principal");
    const all = await listSitesCached(c.env.DB);
    const hidden = c.req.query("include_hidden") === "true";
    const sites = all.filter((s) => canAccessSite(p, s.id) && (hidden || !s.settings.hidden));
    const range = (c.req.query("date_range") ?? "7d") as HomeRange;
    const { edgeCached } = await import("../lib/cache.ts");
    const key = ["sites-summary", range, sites.map((s) => s.id).join(","), p.siteIds === null ? "all" : "some", Math.floor(Date.now() / 60_000)].join("|");
    const { value, hit } = await edgeCached(key, 60, () => sitesSummary(c.env, sites, all, range, Date.now(), p.siteIds === null), c.executionCtx);
    c.header("X-Pulse-Cache", hit ? "hit" : "miss");
    return jsonWithEtag(c, value) as never;
  },
);

registerSites(api);

// ---------- Query core ----------
api.openapi(
  r({
    method: "post",
    path: "/sites/{site}/query",
    tags: ["Stats"],
    description: "Composable metrics × dimensions × filters. Every other read endpoint is a preset over this. ?format=csv returns the rows as a CSV download.",
    request: { params: siteParam, query: z.object({ format: z.enum(["json", "csv"]).optional() }), body: { content: { "application/json": { schema: querySchema } } } },
    scope: "stats:read",
    middleware: [requireSite],
  }),
  async (c) => {
    const body = querySchema.parse(await c.req.json());
    const res = await runQuery(c.env.DB, c.get("site"), body);
    if (c.req.query("format") === "csv") {
      const cols = [...(body.dimensions ?? []), ...body.metrics];
      const name = `${c.get("site").id}-${res.meta.date_range.from}-${res.meta.date_range.to}${body.dimensions?.length ? `-${body.dimensions.join("-")}` : ""}.csv`.replace(/[^\w.-]/g, "_");
      return new Response(toCsv(res.rows as Record<string, unknown>[], cols.length ? cols : undefined), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
      }) as never;
    }
    return jsonWithEtag(c, { meta: res.meta, rows: res.rows, totals: res.totals, comparison: res.comparison, next_cursor: res.next_cursor }) as never;
  },
);

const statsRoute = (path: string, description: string, query: z.ZodObject = commonQuery) =>
  r({ method: "get", path, tags: ["Stats"], description, request: { params: siteParam, query }, scope: "stats:read", middleware: [requireSite] });

api.openapi(
  statsRoute(
    "/sites/{site}/overview",
    "The whole site view in one call: KPIs with comparison, the series of every KPI, top rows of each panel (pages, entry pages, referrers, channels, campaigns, countries, devices, browsers, systems, events, outbound links, weekday × hour), goal conversions and annotations",
    commonQuery.extend({
      interval: z.enum(["hour", "day", "week", "month"]).optional().openapi({ description: "Chart interval; default hour for one day, week past 120 days, day otherwise" }),
      panels: z.string().optional().openapi({ description: `Comma-separated panels (default all): ${Object.keys(OVERVIEW_PANELS).join(", ")}` }),
      limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: "Rows per panel (default 10)" }),
    }),
  ),
  async (c) => {
    const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery> & { interval?: Interval; panels?: string; limit?: number };
    const body = await cachedReport(c, "overview", () =>
      overview(c.env.DB, c.get("site"), { ...toCommon(qy), interval: qy.interval, panels: qy.panels?.split(",").map((s) => s.trim()).filter(Boolean), limit: qy.limit }),
    );
    c.header("Server-Timing", `d1;desc="${body.meta.d1.statements} statements, ${body.meta.d1.rows_read} rows"`);
    return jsonWithEtag(c, body) as never;
  },
);

api.openapi(statsRoute("/sites/{site}/summary", "Start here: KPIs with comparison and top 5 pages, channels, referrers, countries, devices, goals"), async (c) =>
  jsonWithEtag(c, await summary(c.env.DB, c.get("site"), toCommon(c.req.valid("query" as never)))) as never,
);

api.openapi(
  statsRoute("/sites/{site}/timeseries", "Metrics over time with comparison series", commonQuery.extend({ metrics: metricsParam, interval: z.enum(["hour", "day", "week", "month"]).default("day") })),
  async (c) => {
    const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery> & { metrics?: string; interval: "hour" | "day" | "week" | "month" };
    return jsonWithEtag(c, await timeseries(c.env.DB, c.get("site"), { ...toCommon(qy), metrics: parseMetrics(qy.metrics, ["visitors", "pageviews"]), interval: qy.interval ?? "day" })) as never;
  },
);

api.openapi(
  r({ method: "get", path: "/sites/{site}/breakdown/{dimension}", tags: ["Stats"], description: "Top values of one dimension", request: { params: siteParam.extend({ dimension: dimensionSchema.openapi({ param: { name: "dimension", in: "path" } }) }), query: commonQuery.extend({ metrics: metricsParam, limit: z.coerce.number().int().min(1).max(1000).optional(), cursor: z.string().optional(), search: z.string().max(100).optional().openapi({ description: "Only values containing this text (for value suggestions)" }) }) }, scope: "stats:read", middleware: [requireSite] }),
  async (c) => {
    const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery> & { metrics?: string; limit?: number; cursor?: string; search?: string };
    const dimension = dimensionSchema.parse(c.req.param("dimension"));
    return jsonWithEtag(c, await breakdown(c.env.DB, c.get("site"), { ...toCommon(qy), dimension, metrics: parseMetrics(qy.metrics, ["visitors", "pageviews"]), limit: qy.limit, cursor: qy.cursor, search: qy.search })) as never;
  },
);

api.openapi(
  r({
    method: "get",
    path: "/live",
    tags: ["Stats"],
    description: "Who is on your sites now, all at once: visitors in the last 5 minutes per site, hits per minute (30 min) per site, the visits of the last 30 minutes (newest first, each with its site, pages, source, country, device and whether it is active now) and visitors by country",
    scope: "stats:read",
  }),
  async (c) => {
    const p = c.get("principal");
    const sites = (await listSitesCached(c.env.DB)).filter((s) => canAccessSite(p, s.id) && !s.settings.hidden);
    const { liveVisits } = await import("../query/live.ts");
    return c.json({ meta: { generated_at: new Date().toISOString(), window_minutes: 5, feed_minutes: 30 }, ...(await liveVisits(c.env.DB, sites)) });
  },
);

api.openapi(
  r({
    method: "get",
    path: "/sites/{site}/ingest",
    tags: ["Sites"],
    description: "Hits accepted and dropped per UTC day, by reason: bots, hosting networks, Do Not Track, wrong host, excluded paths/hosts/countries, rate limited, over the daily cap, invalid",
    request: { params: siteParam, query: z.object({ days: z.coerce.number().int().min(1).max(90).optional().openapi({ description: "Default 30" }) }) },
    scope: "stats:read",
    middleware: [requireSite],
  }),
  async (c) => c.json(await ingestDays(c.env.DB, c.get("site").id, Number(c.req.query("days") ?? 30))),
);

api.openapi(
  r({
    method: "get",
    path: "/sites/{site}/changes",
    tags: ["Stats"],
    description: "What changed on one day (default yesterday) against the same weekday a week before: visitors with the change, the channel, page and country that drove it, and one sentence",
    request: { params: siteParam, query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) },
    scope: "stats:read",
    middleware: [requireSite],
  }),
  async (c) => {
    const { planChanges } = await import("../query/changes.ts");
    const { runMerged } = await import("../query/run.ts");
    const p = await planChanges(c.env.DB, c.get("site"), Date.now(), c.req.query("date"));
    return jsonWithEtag(c, p.finish((await runMerged(c.env.DB, p.plans)).results)) as never;
  },
);

api.openapi(r({ method: "get", path: "/sites/{site}/realtime", tags: ["Stats"], description: "Visitors in the last 5 minutes, the visits of the last 30 minutes (each marked active or not, grouped by visit), top pages and sources, hits per minute (30 min)", request: { params: siteParam }, scope: "stats:read", middleware: [requireSite] }), async (c) =>
  c.json(await realtime(c.env.DB, c.get("site"))),
);

api.openapi(statsRoute("/sites/{site}/sources/ai", "AI-assistant visits by assistant, landing pages and trend"), async (c) =>
  jsonWithEtag(c, await aiSources(c.env.DB, c.get("site"), toCommon(c.req.valid("query" as never)))) as never,
);

api.openapi(
  statsRoute("/sites/{site}/movers", "Biggest absolute and relative changes against the comparison period", commonQuery.extend({ dimension: dimensionSchema.default("page"), metric: z.enum(METRICS).default("visitors"), limit: z.coerce.number().int().min(1).max(50).optional() })),
  async (c) => {
    const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery> & { dimension: string; metric: (typeof METRICS)[number]; limit?: number };
    return jsonWithEtag(c, await movers(c.env.DB, c.get("site"), { ...toCommon(qy), dimension: qy.dimension ?? "page", metric: qy.metric ?? "visitors", limit: qy.limit })) as never;
  },
);

api.openapi(statsRoute("/sites/{site}/retention", "Weekly cohorts; session-based return within the same day (visitor ids rotate daily)", commonQuery.extend({ cohort: z.enum(["week"]).default("week") })), async (c) =>
  jsonWithEtag(c, await retention(c.env.DB, c.get("site"), toCommon(c.req.valid("query" as never)))) as never,
);

const pathsQuery = commonQuery.omit({ from: true, to: true }).extend({
  from: z.string().min(1).max(500).openapi({ description: "The page to start from (not a date)", example: "/pricing" }),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  direction: z.enum(["next", "previous"]).default("next"),
  depth: z.coerce.number().int().min(1).max(5).default(3),
});
api.openapi(statsRoute("/sites/{site}/paths", "Journeys before or after a page", pathsQuery), async (c) => {
  const qy = c.req.valid("query" as never) as z.infer<typeof pathsQuery>;
  const cm = toCommon({ ...qy, from: qy.date_from, to: qy.date_to });
  return jsonWithEtag(c, await paths(c.env.DB, c.get("site"), { ...cm, from: qy.from, direction: qy.direction, depth: qy.depth })) as never;
});

api.openapi(statsRoute("/sites/{site}/vitals", "Core Web Vitals p75 per page and device with good / needs-improvement / poor shares", commonQuery.extend({ dimension: z.enum(["page", "device", "page,device"]).default("page") })), async (c) => {
  const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery> & { dimension: "page" | "device" | "page,device" };
  return jsonWithEtag(c, await vitals(c.env.DB, c.get("site"), { ...toCommon(qy), dimension: qy.dimension })) as never;
});

api.openapi(statsRoute("/sites/{site}/errors", "Grouped JavaScript errors (when enabled for the site)"), async (c) =>
  jsonWithEtag(c, await errors(c.env.DB, c.get("site"), toCommon(c.req.valid("query" as never)))) as never,
);

api.openapi(statsRoute("/sites/{site}/pages/report", "Everything about one path", commonQuery.extend({ path: z.string().min(1).max(500) })), async (c) => {
  const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery> & { path: string };
  return jsonWithEtag(c, await pageReport(c.env.DB, c.get("site"), { ...toCommon(qy), path: qy.path })) as never;
});

// ---------- Goals ----------
api.openapi(r({ method: "get", path: "/sites/{site}/goals", tags: ["Goals"], description: "List goals", request: { params: siteParam }, scope: "stats:read", middleware: [requireSite] }), async (c) =>
  c.json({ data: await listGoals(c.env.DB, c.get("site").id) }),
);

api.openapi(r({ method: "post", path: "/sites/{site}/goals", tags: ["Goals"], description: "Create a goal", request: { params: siteParam, body: { content: { "application/json": { schema: goalBody } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
  const { id: _ignored, ...b } = (await c.req.json()) as Record<string, unknown>;
  return c.json({ data: await saveGoal(c.env.DB, c.get("site").id, c.get("principal").label, b) }, 201 as 200);
});

const idParam = siteParam.extend({ id: z.string().min(1).max(64).openapi({ param: { name: "id", in: "path" } }) });

api.openapi(r({ method: "patch", path: "/sites/{site}/goals/{id}", tags: ["Goals"], description: "Update a goal", request: { params: idParam, body: { content: { "application/json": { schema: goalBody.partial() } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) =>
  c.json({ data: await saveGoal(c.env.DB, c.get("site").id, c.get("principal").label, { ...((await c.req.json()) as object), id: c.req.param("id") }) }),
);

api.openapi(r({ method: "delete", path: "/sites/{site}/goals/{id}", tags: ["Goals"], description: "Delete a goal", request: { params: idParam }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
  await deleteGoal(c.env.DB, c.get("site").id, c.get("principal").label, c.req.param("id") ?? "");
  return c.json({ data: { deleted: true } });
});

api.openapi(r({ method: "get", path: "/sites/{site}/goals/{id}/conversions", tags: ["Goals"], description: "Conversions for a goal, with daily series", request: { params: idParam, query: commonQuery }, scope: "stats:read", middleware: [requireSite] }), async (c) => {
  const cm = toCommon(c.req.valid("query" as never));
  const site = c.get("site");
  const base = { date_range: cm.date_range, timezone: cm.timezone, filters: cm.filters, goal: c.req.param("id") };
  const [tot, series, byChannel] = await Promise.all([
    runQuery(c.env.DB, site, querySchema.parse({ ...base, metrics: ["conversions", "conversion_rate", "sessions"], compare: cm.compare === undefined ? "previous_period" : cm.compare })),
    runQuery(c.env.DB, site, querySchema.parse({ ...base, metrics: ["conversions"], dimensions: ["day"], limit: 1000 })),
    runQuery(c.env.DB, site, querySchema.parse({ ...base, metrics: ["conversions", "conversion_rate"], dimensions: ["channel"], limit: 20 })),
  ]);
  return jsonWithEtag(c, { meta: tot.meta, totals: tot.totals, comparison: tot.comparison ? { date_range: tot.comparison.date_range, totals: tot.comparison.totals } : null, series: series.rows, by_channel: byChannel.rows }) as never;
});

// ---------- Funnels ----------
api.openapi(r({ method: "get", path: "/sites/{site}/funnels", tags: ["Funnels"], description: "List funnels", request: { params: siteParam }, scope: "stats:read", middleware: [requireSite] }), async (c) =>
  c.json({ data: await listFunnels(c.env.DB, c.get("site").id) }),
);

api.openapi(r({ method: "post", path: "/sites/{site}/funnels", tags: ["Funnels"], description: "Create a funnel", request: { params: siteParam, body: { content: { "application/json": { schema: funnelBody } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
  const { id: _ignored, ...b } = (await c.req.json()) as Record<string, unknown>;
  return c.json({ data: await saveFunnel(c.env.DB, c.get("site").id, c.get("principal").label, b) }, 201 as 200);
});

api.openapi(r({ method: "patch", path: "/sites/{site}/funnels/{id}", tags: ["Funnels"], description: "Update a funnel", request: { params: idParam, body: { content: { "application/json": { schema: funnelBody.partial() } } } }, scope: "sites:write", middleware: [requireSite] }), async (c) =>
  c.json({ data: await saveFunnel(c.env.DB, c.get("site").id, c.get("principal").label, { ...((await c.req.json()) as object), id: c.req.param("id") }) }),
);

api.openapi(r({ method: "delete", path: "/sites/{site}/funnels/{id}", tags: ["Funnels"], description: "Delete a funnel", request: { params: idParam }, scope: "sites:write", middleware: [requireSite] }), async (c) => {
  await deleteFunnel(c.env.DB, c.get("site").id, c.get("principal").label, c.req.param("id") ?? "");
  return c.json({ data: { deleted: true } });
});

const funnelQuery = commonQuery.extend({ breakdown: z.enum(FUNNEL_BREAKDOWNS).optional().openapi({ description: "Sessions per step for each value of this session dimension" }) });
api.openapi(r({ method: "get", path: "/sites/{site}/funnels/{id}", tags: ["Funnels"], description: "Analyze a saved funnel (with compare: the same steps in the comparison period; with breakdown: steps per channel, device…)", request: { params: idParam, query: funnelQuery }, scope: "stats:read", middleware: [requireSite] }), async (c) => {
  const f = await getFunnel(c.env.DB, c.get("site").id, c.req.param("id") ?? "");
  if (!f) throw new ApiError(404, "not_found", "funnel not found");
  const qy = c.req.valid("query" as never) as z.infer<typeof funnelQuery>;
  const res = await funnel(c.env.DB, c.get("site"), { ...toCommon(qy), steps: f.steps, window_minutes: f.window_minutes, step_order: f.step_order, breakdown: qy.breakdown });
  return jsonWithEtag(c, { ...res, funnel: { id: f.id, name: f.name } }) as never;
});

api.openapi(r({ method: "post", path: "/sites/{site}/funnels/analyze", tags: ["Funnels"], description: "Ad-hoc funnel analysis", request: { params: siteParam, query: funnelQuery, body: { content: { "application/json": { schema: funnelBody.omit({ name: true }) } } } }, scope: "stats:read", middleware: [requireSite] }), async (c) => {
  const b = funnelBody.omit({ name: true }).parse(await c.req.json());
  const qy = c.req.valid("query" as never) as z.infer<typeof funnelQuery>;
  return c.json(await funnel(c.env.DB, c.get("site"), { ...toCommon(qy), ...b, breakdown: qy.breakdown }));
});

// ---------- Annotations ----------
const annotationBody = z.object({
  ts: z.string().datetime({ offset: true }).optional(),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  url: z.string().url().max(500).optional(),
  category: z.enum(ANNOTATION_CATEGORIES).optional(),
  affects: z.array(z.enum(METRICS)).max(20).optional().openapi({ description: "Data-quality marker: metrics whose definition or source changed here; reports don't show their change across it" }),
});
const annotationPatch = annotationBody.partial().extend({ body: z.string().max(2000).nullable().optional(), url: z.string().url().max(500).nullable().optional() });
const annSiteParam = z.object({ site: z.string().min(1).max(64).openapi({ param: { name: "site", in: "path" }, description: "Site id, or * for all sites" }) });

async function annotationSite(c: Ctx): Promise<string | null> {
  const id = c.req.param("site");
  if (id === "*") {
    if (c.get("principal").siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys cannot use site=*");
    return null;
  }
  if (!id || !canAccessSite(c.get("principal"), id)) throw new ApiError(404, "site_not_found", "site not found");
  const s = (await listSitesCached(c.env.DB)).find((x) => x.id === id);
  if (!s) throw new ApiError(404, "site_not_found", "site not found");
  return id;
}

/** Access check before body validation, so another site's routes answer 404 whatever the body. */
const annotationAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  await annotationSite(c as Ctx);
  return next();
};

api.openapi(r({ method: "get", path: "/sites/{site}/annotations", tags: ["Annotations"], description: "List annotations (site-specific plus all-site ones)", request: { params: annSiteParam, query: commonQuery }, scope: "stats:read", middleware: [annotationAccess] }), async (c) => {
  const siteId = await annotationSite(c);
  const qy = c.req.valid("query" as never) as z.infer<typeof commonQuery>;
  const cm = toCommon(qy);
  const tz = siteId ? ((await listSitesCached(c.env.DB)).find((s) => s.id === siteId)?.timezone ?? "UTC") : "UTC";
  const range = resolveRange(cm.date_range ?? "90d", tz, Date.now(), "2000-01-01");
  const from = Date.parse(`${range.from}T00:00:00Z`) - 86_400_000;
  const to = Date.parse(`${range.to}T00:00:00Z`) + 2 * 86_400_000;
  const { results } = await c.env.DB.prepare(
    siteId ? "SELECT * FROM annotations WHERE (site_id = ? OR site_id IS NULL) AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 500" : "SELECT * FROM annotations WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 500",
  )
    .bind(...(siteId ? [siteId, from, to] : [from, to]))
    .all<AnnotationRow & { created_by: string }>();
  return c.json({ data: results.map(annotationView) });
});

api.openapi(r({ method: "post", path: "/sites/{site}/annotations", tags: ["Annotations"], description: "Add an annotation (deploys, SEO changes, campaigns)", request: { params: annSiteParam, body: { content: { "application/json": { schema: annotationBody } } } }, scope: "annotations:write", middleware: [annotationAccess] }), async (c) => {
  const siteId = await annotationSite(c);
  const b = annotationBody.parse(await c.req.json());
  const id = ulid();
  const ts = b.ts ? Date.parse(b.ts) : Date.now();
  const affects = b.affects?.length ? JSON.stringify(b.affects) : null;
  await c.env.DB.prepare("INSERT INTO annotations (id, site_id, ts, title, body, url, category, affects, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, siteId, ts, b.title, b.body ?? null, b.url ?? null, b.category ?? null, affects, c.get("principal").label, Date.now()).run();
  c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "annotation.create", `${siteId ?? "*"}/${id}`));
  return c.json({ data: { id, site_id: siteId, ts: new Date(ts).toISOString(), title: b.title, body: b.body ?? null, url: b.url ?? null, category: b.category ?? null, affects: b.affects ?? [] } }, 201 as 200);
});

api.openapi(r({ method: "patch", path: "/sites/{site}/annotations/{id}", tags: ["Annotations"], description: "Edit an annotation (title, note, link, time, category)", request: { params: annSiteParam.extend({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }), body: { content: { "application/json": { schema: annotationPatch } } } }, scope: "annotations:write", middleware: [annotationAccess] }), async (c) =>
  c.json({ data: await updateAnnotation(c.env.DB, await annotationSite(c), c.get("principal").label, c.req.param("id") ?? "", annotationPatch.parse(await c.req.json())) }),
);

api.openapi(r({ method: "delete", path: "/sites/{site}/annotations/{id}", tags: ["Annotations"], description: "Delete an annotation", request: { params: annSiteParam.extend({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }) }, scope: "annotations:write", middleware: [annotationAccess] }), async (c) => {
  const siteId = await annotationSite(c);
  await deleteAnnotation(c.env.DB, siteId, c.get("principal").label, c.req.param("id") ?? "");
  return c.json({ data: { deleted: true } });
});

// ---------- CI deploy hook ----------
const deployHookBody = z
  .object({
    sites: z.union([z.literal("*"), z.array(z.string().max(64)).min(1).max(50)]).openapi({ description: 'Site ids the deploy affects, or "*" for one all-site marker' }),
    repo: z.string().min(1).max(100),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/i).openapi({ description: "Commit; a repeated call for the same commit and site updates nothing" }),
    message: z.string().max(500).optional(),
    url: z.string().url().max(500).optional().openapi({ description: "Link to the commit or the build" }),
    environment: z.string().max(40).optional(),
  })
  .openapi("DeployHook");

api.openapi(
  r({
    method: "post",
    path: "/hooks/deploy",
    tags: ["Annotations"],
    description: "From CI after a deploy: one deploy marker per site (or one all-site marker), idempotent per commit, so retried builds don't duplicate it",
    request: { body: { content: { "application/json": { schema: deployHookBody } } } },
    scope: "annotations:write",
  }),
  async (c) => {
    const b = deployHookBody.parse(await c.req.json());
    const p = c.get("principal");
    if (b.sites === "*" && p.siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys cannot use sites=*");
    const known = new Set((await listSitesCached(c.env.DB)).map((s) => s.id));
    const targets: (string | null)[] = b.sites === "*" ? [null] : b.sites;
    for (const s of targets) if (s !== null && (!known.has(s) || !canAccessSite(p, s))) throw new ApiError(404, "site_not_found", `site not found: ${s}`);
    const sha = b.sha.toLowerCase();
    const title = `Deploy ${b.repo} ${sha.slice(0, 7)}${b.environment ? ` (${b.environment})` : ""}`;
    const now = Date.now();
    const res = await c.env.DB.batch(
      targets.map((s) =>
        c.env.DB.prepare("INSERT OR IGNORE INTO annotations (id, site_id, ts, title, body, url, category, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'deploy', ?, ?)").bind(
          `deploy-${s ?? "all"}-${b.repo.replace(/[^\w.-]/g, "_").slice(0, 40)}-${sha.slice(0, 12)}`,
          s,
          now,
          title,
          b.message ?? null,
          b.url ?? null,
          p.label,
          now,
        ),
      ),
    );
    const created = res.reduce((a, r) => a + (r.meta.changes ?? 0), 0);
    if (created) c.executionCtx.waitUntil(audit(c.env.DB, p.label, "annotation.deploy_hook", `${b.repo}@${sha.slice(0, 7)}`));
    return c.json({ data: { created, skipped: targets.length - created, title } });
  },
);

// ---------- Export ----------
api.openapi(
  r({ method: "get", path: "/sites/{site}/export", tags: ["Export"], description: "Raw events, streamed as NDJSON or CSV", request: { params: siteParam, query: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), format: z.enum(["ndjson", "csv"]).default("ndjson"), type: z.string().optional() }) }, scope: "events:export", middleware: [requireSite], responses: { 200: { description: "Stream", content: { "application/x-ndjson": { schema: z.string() }, "text/csv": { schema: z.string() } } } } }),
  async (c) => {
    const qy = c.req.valid("query" as never) as { from: string; to: string; format: "ndjson" | "csv"; type?: string };
    return exportEvents(c.env.DB, c.get("site").id, qy) as never;
  },
);

registerAdmin(api);

api.openapi(r({ method: "post", path: "/admin/import", tags: ["Admin"], description: "Batch upsert of events and sessions, idempotent by id", request: { body: { content: { "application/json": { schema: importSchema } } } }, scope: "admin" }), async (c) => {
  const b = importSchema.parse(await c.req.json());
  if (!canAccessSite(c.get("principal"), b.site_id)) throw new ApiError(404, "site_not_found", "site not found");
  return c.json({ data: await importBatch(c.env.DB, b, c.get("principal").label) });
});

api.openapi(r({ method: "post", path: "/sites/{site}/delete-data", tags: ["Admin"], description: "Delete a site's raw data in a date range, or only the sessions matching filters (remove unwanted visits). dry_run counts first and returns confirm_token; D1 Time Travel (30 days) is the undo.", request: { params: siteParam, body: { content: { "application/json": { schema: deleteBody } } } }, scope: "admin", middleware: [requireSite] }), async (c) =>
  c.json({ data: await deleteData(c.env.DB, c.get("site"), c.get("principal").label, await c.req.json()) }),
);

api.openapi(r({ method: "get", path: "/health", tags: ["System"], description: "Ingest lag, queue/DLQ, last event per site, D1 size, backups, version", scope: "stats:read" }), async (c) => c.json(await health(c.env)));

api.openapi(r({ method: "get", path: "/me", tags: ["System"], description: "The authenticated principal", scope: null }), async (c) => {
  const p = c.get("principal");
  return c.json({ data: { kind: p.kind, label: p.label, role: p.role ?? null, scopes: p.scopes, site_ids: p.siteIds, can_admin: hasScope(p, "admin") } });
});


registerOps(api);
registerFeatures(api);

api.openapi(
  r({
    method: "get",
    path: "/",
    operationId: "getIndex",
    tags: ["System"],
    description: "Start here (agents): who you are, every capability this key can use with its REST operations and MCP tool, what is locked and which scope unlocks it, and where the docs are",
    scope: null,
  }),
  async (c) => {
    const p = c.get("principal");
    const sites = (await listSitesCached(c.env.DB)).filter((s) => canAccessSite(p, s.id));
    const o = c.env.PUBLIC_ORIGIN;
    return c.json({
      name: "Pulse",
      version: VERSION,
      you: { kind: p.kind, label: p.label, role: p.role ?? null, scopes: p.scopes, site_ids: p.siteIds },
      sites: sites.map((s) => ({ id: s.id, name: s.name, domains: s.domains })),
      ...capabilitiesFor(p),
      how_to_get_more: "Ask an admin to edit this key in the dashboard (Settings → API keys).",
      docs: { agent_guide: `${o}/docs/agents`, llms_txt: `${o}/llms.txt`, openapi: `${o}/api/v1/openapi.json`, reference: `${o}/docs/api`, mcp: `${o}/mcp` },
    });
  },
);

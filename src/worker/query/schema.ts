import { z } from "@hono/zod-openapi";

export const METRICS = [
  "visitors",
  "sessions",
  "pageviews",
  "views_per_session",
  "bounce_rate",
  "avg_session_duration",
  "avg_engaged_time",
  "events",
  "conversions",
  "conversion_rate",
  "entries",
  "exits",
  "exit_rate",
  "scroll_depth",
  "lcp_p75",
  "inp_p75",
  "cls_p75",
  "revenue",
  "average_revenue",
  "revenue_per_visitor",
] as const;
export type Metric = (typeof METRICS)[number];

export const VITAL_METRICS = ["lcp_p75", "inp_p75", "cls_p75"] as const;

export const BASE_DIMENSIONS = [
  "page",
  "entry_page",
  "exit_page",
  "hostname",
  "title",
  "referrer",
  "referrer_host",
  "channel",
  "source_name",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "country",
  "region",
  "city",
  "continent",
  "device",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "screen",
  "language",
  "event_name",
  "outbound_url",
  "download_url",
  "type",
  "source",
  "search_term",
  "day",
  "hour",
  "datehour",
  "weekday",
  "week",
  "month",
] as const;
export type BaseDimension = (typeof BASE_DIMENSIONS)[number];

/** Either a base dimension or `event_prop:<key>`. */
export const dimensionSchema = z
  .string()
  .refine((d) => (BASE_DIMENSIONS as readonly string[]).includes(d) || /^event_prop:[A-Za-z0-9_.\-]{1,80}$/.test(d), {
    message: "unknown dimension",
  })
  .openapi({ example: "page" });
export type Dimension = string;

export const FILTER_OPS = ["is", "is_one_of", "is_not", "contains", "not_contains", "starts_with", "matches", "not_matches"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Filters accept every dimension plus `goal` (values are goal ids: sessions that converted on any of them). */
export const filterDimensionSchema = z
  .string()
  .refine((d) => d === "goal" || dimensionSchema.safeParse(d).success, { message: "unknown dimension" });

export const filterSchema = z
  .tuple([z.enum(FILTER_OPS), filterDimensionSchema, z.array(z.union([z.string(), z.number()])).min(1).max(50)])
  .refine(([op, dim]) => dim !== "goal" || op === "is" || op === "is_one_of" || op === "is_not", { message: "goal filters use is, is_one_of or is_not" })
  .openapi({ example: ["is", "country", ["ES"]] });
export type Filter = [FilterOp, Dimension, (string | number)[]];

/** Comparison: the period just before, the same period a year earlier, or explicit days. */
export const compareSchema = z
  .union([
    z.enum(["previous_period", "previous_year"]),
    z
      .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .refine((r) => r.from <= r.to, { message: "compare.from must not be after compare.to" }),
  ])
  .openapi({ example: "previous_period" });
export type Compare = z.infer<typeof compareSchema>;

export const DATE_PRESETS = ["today", "yesterday", "24h", "7d", "28d", "30d", "90d", "mtd", "last_month", "ytd", "12mo", "all"] as const;

export const dateRangeSchema = z
  .union([
    z.enum(DATE_PRESETS),
    z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    z.object({ last_minutes: z.number().int().min(5).max(10_080) }).openapi({ description: "A rolling window ending now, e.g. {\"last_minutes\": 180}" }),
  ])
  .openapi({ example: "28d" });

export const goalMatchSchema = z.object({
  kind: z.enum(["pageview", "event", "outbound"]),
  path: z.string().max(300).optional(),
  event: z.string().max(80).optional(),
  prop: z.object({ key: z.string().max(80), value: z.union([z.string(), z.number(), z.boolean()]) }).optional(),
  host: z.string().max(200).optional(),
});
export type GoalMatch = z.infer<typeof goalMatchSchema>;

export const orderBySchema = z.tuple([z.string(), z.enum(["asc", "desc"])]);

export const querySchema = z
  .object({
    metrics: z.array(z.enum(METRICS)).min(1).max(METRICS.length),
    dimensions: z.array(dimensionSchema).max(3).default([]),
    filters: z.array(filterSchema).max(20).default([]),
    date_range: dateRangeSchema.default("28d"),
    timezone: z.enum(["site", "UTC"]).default("site"),
    compare: compareSchema.nullable().optional(),
    order_by: orderBySchema.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    cursor: z.string().max(200).optional(),
    goal: z.union([z.string().max(64), goalMatchSchema]).optional(),
    source_counts: z.boolean().default(false).openapi({ description: "Add meta.source_counts (imported vs live rows in the range). Costs a scan of the range." }),
  })
  .openapi("Query");
export type QueryInput = z.input<typeof querySchema>;
export type Query = z.output<typeof querySchema>;

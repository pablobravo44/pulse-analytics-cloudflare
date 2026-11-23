import { z } from "@hono/zod-openapi";
import { compareSchema, DATE_PRESETS, filterSchema, METRICS } from "../query/schema.ts";
import type { Common } from "../query/presets.ts";
import { ApiError } from "./common.ts";

export const commonQuery = z.object({
  date_range: z.enum(DATE_PRESETS).optional().openapi({ description: "Preset range. Ignored when from/to are set.", example: "28d" }),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ example: "2026-09-01" }),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ example: "2026-09-30" }),
  timezone: z.enum(["site", "UTC"]).optional(),
  compare: z.enum(["previous_period", "previous_year", "none"]).optional(),
  compare_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: "Custom comparison start (with compare_to); overrides compare", example: "2026-08-01" }),
  compare_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ example: "2026-08-31" }),
  filters: z
    .string()
    .optional()
    .openapi({ description: 'JSON array of [operator, dimension, values[]], e.g. [["is","country",["ES"]]]' }),
});
export type CommonQuery = z.infer<typeof commonQuery>;

export const metricsParam = z
  .string()
  .optional()
  .openapi({ description: `Comma-separated metrics: ${METRICS.join(", ")}`, example: "visitors,pageviews" });

export const siteParam = z.object({ site: z.string().min(1).max(64).openapi({ param: { name: "site", in: "path" }, example: "example-site" }) });

export function parseFilters(raw: string | undefined) {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_request", "filters must be a JSON array");
  }
  return z.array(filterSchema).max(20).parse(parsed);
}

export function toCommon(q: CommonQuery): Common {
  return {
    date_range: q.from && q.to ? { from: q.from, to: q.to } : (q.date_range ?? "28d"),
    timezone: q.timezone ?? "site",
    compare: q.compare_from && q.compare_to ? compareSchema.parse({ from: q.compare_from, to: q.compare_to }) : q.compare === "none" ? null : q.compare,
    filters: parseFilters(q.filters),
  };
}

export function parseMetrics(raw: string | undefined, fallback: (typeof METRICS)[number][]) {
  if (!raw) return fallback;
  return z.array(z.enum(METRICS)).min(1).max(METRICS.length).parse(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export const anyJson = z.record(z.string(), z.unknown()).openapi("JsonObject");

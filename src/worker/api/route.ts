import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { Scope } from "../auth/principal.ts";
import { anyJson } from "./params.ts";
import { errorSchema, requireScope, type AppEnv } from "./common.ts";

const bearer: Record<string, string[]>[] = [{ bearerAuth: [] }, { cookieAuth: [] }];
const okJson = (description: string, schema: z.ZodTypeAny = anyJson) => ({
  200: { description, content: { "application/json": { schema } } },
  400: { description: "Invalid request", content: { "application/json": { schema: errorSchema } } },
  401: { description: "Unauthorized", content: { "application/json": { schema: errorSchema } } },
  403: { description: "Forbidden", content: { "application/json": { schema: errorSchema } } },
  404: { description: "Not found", content: { "application/json": { schema: errorSchema } } },
});

/** e.g. GET /sites/{site}/breakdown/{dimension} → getSitesBreakdownByDimension */
export function operationId(method: string, path: string): string {
  const words = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") ? `by ${seg.slice(1, -1)}` : seg))
    // "{site}" is implied mid-path, but /sites/{site} itself must not collide with /sites.
    .filter((seg, i, all) => seg !== "by site" || i === all.length - 1)
    .join(" ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return method.toLowerCase() + words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
}

/**
 * One API route. `scope` is enforced before any other middleware and published in the OpenAPI document as
 * `x-required-scope` (null = any authenticated caller), so the capability catalog can be checked against it.
 */
export function r<P extends string>(
  cfg: Omit<RouteConfig, "responses" | "path" | "middleware"> & {
    path: P;
    description: string;
    scope: Scope | null;
    middleware?: MiddlewareHandler<AppEnv>[];
    responses?: RouteConfig["responses"];
  },
) {
  const { scope, middleware = [], ...rest } = cfg;
  const summary = cfg.description.split(/[.:;(]/)[0]!.trim().slice(0, 80);
  return createRoute({
    security: bearer,
    summary,
    operationId: operationId(cfg.method, cfg.path),
    ...rest,
    "x-required-scope": scope,
    middleware: [...(scope ? [requireScope(scope)] : []), ...middleware],
    responses: { ...okJson(cfg.description), ...(cfg.responses ?? {}) },
  } as RouteConfig) as unknown as RouteConfig & { path: P };
}

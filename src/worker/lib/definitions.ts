// Goals, funnels and annotations: one implementation shared by the REST API and the MCP tools.
import { z } from "@hono/zod-openapi";
import { ApiError } from "../api/common.ts";
import { goalMatchSchema } from "../query/schema.ts";
import { audit } from "./audit.ts";
import { parseAffects } from "./annotations.ts";
import { ulid } from "./ids.ts";
import { onlyGiven } from "./patch.ts";

export const goalBody = z.object({ name: z.string().min(1).max(120), match: goalMatchSchema });
export const stepSchema = z.object({ name: z.string().max(120).optional(), match: goalMatchSchema });
export const funnelBody = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(stepSchema).min(2).max(8),
  window_minutes: z.number().int().min(1).max(1440).default(30),
  step_order: z.enum(["flexible", "strict"]).default("flexible").openapi({ description: "flexible: other pages may come between steps; strict: the next pageview must be the next step" }),
});
type FunnelRow = { id: string; name: string; steps_json: string; window_minutes: number; step_order: "flexible" | "strict" };
const funnelOut = (f: FunnelRow) => ({ id: f.id, name: f.name, steps: JSON.parse(f.steps_json) as z.infer<typeof stepSchema>[], window_minutes: f.window_minutes, step_order: f.step_order ?? "flexible" });

export async function listGoals(db: D1Database, siteId: string) {
  const { results } = await db.prepare("SELECT id, name, kind, definition_json FROM goals WHERE site_id = ? ORDER BY name").bind(siteId).all<{ id: string; name: string; kind: string; definition_json: string }>();
  return results.map((g) => ({ id: g.id, name: g.name, match: { kind: g.kind, ...JSON.parse(g.definition_json) } as z.infer<typeof goalMatchSchema> }));
}

/** Create (no id) or update (id) a goal. */
export async function saveGoal(db: D1Database, siteId: string, actor: string, input: { id?: string; name?: string; match?: unknown }) {
  if (!input.id) {
    const b = goalBody.parse(input);
    const id = ulid();
    const { kind, ...def } = b.match;
    await db.prepare("INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, siteId, b.name, kind, JSON.stringify(def), Date.now()).run();
    await audit(db, actor, "goal.create", `${siteId}/${id}`);
    return { id, ...b };
  }
  const b = onlyGiven(goalBody.partial().parse(input), input);
  const cur = await db.prepare("SELECT * FROM goals WHERE id = ? AND site_id = ?").bind(input.id, siteId).first<{ name: string; kind: string; definition_json: string }>();
  if (!cur) throw new ApiError(404, "not_found", "goal not found");
  const match = b.match ?? { kind: cur.kind, ...JSON.parse(cur.definition_json) };
  const { kind, ...def } = match;
  await db.prepare("UPDATE goals SET name = ?, kind = ?, definition_json = ? WHERE id = ? AND site_id = ?").bind(b.name ?? cur.name, kind, JSON.stringify(def), input.id, siteId).run();
  await audit(db, actor, "goal.update", `${siteId}/${input.id}`);
  return { id: input.id, name: b.name ?? cur.name, match };
}

export async function deleteGoal(db: D1Database, siteId: string, actor: string, id: string) {
  const res = await db.prepare("DELETE FROM goals WHERE id = ? AND site_id = ?").bind(id, siteId).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "goal not found");
  await audit(db, actor, "goal.delete", `${siteId}/${id}`);
}

export async function listFunnels(db: D1Database, siteId: string) {
  const { results } = await db.prepare("SELECT id, name, steps_json, window_minutes, step_order FROM funnels WHERE site_id = ? ORDER BY name").bind(siteId).all<FunnelRow>();
  return results.map(funnelOut);
}

export async function getFunnel(db: D1Database, siteId: string, id: string) {
  const f = await db.prepare("SELECT id, name, steps_json, window_minutes, step_order FROM funnels WHERE id = ? AND site_id = ?").bind(id, siteId).first<FunnelRow>();
  return f ? funnelOut(f) : null;
}

/** Create (no id) or update (id) a funnel. */
export async function saveFunnel(db: D1Database, siteId: string, actor: string, input: { id?: string; name?: string; steps?: unknown; window_minutes?: number; step_order?: string }) {
  if (!input.id) {
    const b = funnelBody.parse(input);
    const id = ulid();
    await db.prepare("INSERT INTO funnels (id, site_id, name, steps_json, window_minutes, step_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, siteId, b.name, JSON.stringify(b.steps), b.window_minutes, b.step_order, Date.now()).run();
    await audit(db, actor, "funnel.create", `${siteId}/${id}`);
    return { id, ...b };
  }
  const b = onlyGiven(funnelBody.partial().parse(input), input);
  const cur = await db.prepare("SELECT * FROM funnels WHERE id = ? AND site_id = ?").bind(input.id, siteId).first<FunnelRow>();
  if (!cur) throw new ApiError(404, "not_found", "funnel not found");
  const next = { name: b.name ?? cur.name, steps: b.steps ?? JSON.parse(cur.steps_json), window_minutes: b.window_minutes ?? cur.window_minutes, step_order: b.step_order ?? cur.step_order ?? "flexible" };
  await db.prepare("UPDATE funnels SET name = ?, steps_json = ?, window_minutes = ?, step_order = ? WHERE id = ? AND site_id = ?").bind(next.name, JSON.stringify(next.steps), next.window_minutes, next.step_order, input.id, siteId).run();
  await audit(db, actor, "funnel.update", `${siteId}/${input.id}`);
  return { id: input.id, ...next };
}

export async function deleteFunnel(db: D1Database, siteId: string, actor: string, id: string) {
  const res = await db.prepare("DELETE FROM funnels WHERE id = ? AND site_id = ?").bind(id, siteId).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "funnel not found");
  await audit(db, actor, "funnel.delete", `${siteId}/${id}`);
}

/** Edit an annotation. siteId null = an all-sites annotation. */
export async function updateAnnotation(db: D1Database, siteId: string | null, actor: string, id: string, b: { ts?: string; title?: string; body?: string | null; url?: string | null; category?: string; affects?: string[] | null }) {
  const cur = await (siteId ? db.prepare("SELECT * FROM annotations WHERE id = ? AND site_id = ?").bind(id, siteId) : db.prepare("SELECT * FROM annotations WHERE id = ? AND site_id IS NULL").bind(id)).first<{ ts: number; title: string; body: string | null; url: string | null; category: string | null; affects: string | null }>();
  if (!cur) throw new ApiError(404, "not_found", "annotation not found");
  // null clears the note, the link or the affected metrics; undefined keeps them.
  const affects = b.affects === undefined ? cur.affects : b.affects?.length ? JSON.stringify(b.affects) : null;
  const parsedTs = b.ts ? Date.parse(b.ts) : cur.ts;
  if (Number.isNaN(parsedTs)) throw new ApiError(400, "invalid_ts", "ts must be ISO-8601");
  const next = { ts: parsedTs, title: b.title ?? cur.title, body: b.body === undefined ? cur.body : b.body || null, url: b.url === undefined ? cur.url : b.url || null, category: b.category ?? cur.category };
  await db.prepare("UPDATE annotations SET ts = ?, title = ?, body = ?, url = ?, category = ?, affects = ? WHERE id = ?").bind(next.ts, next.title, next.body, next.url, next.category, affects, id).run();
  await audit(db, actor, "annotation.update", `${siteId ?? "*"}/${id}`);
  return { id, site_id: siteId, ...next, ts: new Date(next.ts).toISOString(), affects: parseAffects(affects) };
}

/** Delete an annotation. siteId null = an all-sites annotation. */
export async function deleteAnnotation(db: D1Database, siteId: string | null, actor: string, id: string) {
  const res = await (siteId ? db.prepare("DELETE FROM annotations WHERE id = ? AND site_id = ?").bind(id, siteId) : db.prepare("DELETE FROM annotations WHERE id = ? AND site_id IS NULL").bind(id)).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "annotation not found");
  await audit(db, actor, "annotation.delete", `${siteId ?? "*"}/${id}`);
}

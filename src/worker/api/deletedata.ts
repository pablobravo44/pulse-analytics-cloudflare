// Deleting a site's raw data: a date range, or only the sessions matching filters (spam, test visits). A dry run
// counts first and returns a confirmation token bound to exactly that selection and its counts, so a deletion
// can't run on a selection nobody looked at (the dashboard and MCP both go through it). D1 Time Travel (30 days)
// is the undo.
import { z } from "@hono/zod-openapi";
import { audit } from "../lib/audit.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { Site } from "../lib/sites.ts";
import { filterClauses } from "../query/build.ts";
import { invalidateRollups } from "../query/rollup.ts";
import { resolveFilterGoals } from "../query/run.ts";
import { filterSchema } from "../query/schema.ts";
import { ApiError } from "./common.ts";

export const deleteBody = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  filters: z.array(filterSchema).max(10).optional().openapi({ description: "Only delete sessions matching these filters (e.g. a spam referrer); omit to delete everything in the range" }),
  dry_run: z.boolean().optional().openapi({ description: "Count what would be deleted, delete nothing; returns confirm_token" }),
  confirm: z.literal(true).optional(),
  confirm_token: z.string().max(64).optional().openapi({ description: "From the dry run of the same selection; required by MCP, optional over REST with confirm: true" }),
});
export type DeleteInput = z.input<typeof deleteBody>;

async function tokenFor(siteId: string, b: z.output<typeof deleteBody>, counts: { sessions: number; events: number }) {
  return (await sha256Hex(JSON.stringify([siteId, b.from, b.to, b.filters ?? [], counts.sessions, counts.events]))).slice(0, 24);
}

export async function deleteData(db: D1Database, site: Site, actor: string, input: DeleteInput, opts: { requireToken?: boolean } = {}) {
  const b = deleteBody.parse(input);
  if (b.from > b.to) throw new ApiError(400, "invalid_request", "from must be on or before to");
  const ctx = { siteId: site.id, timeZone: site.timezone, tzMode: "site" as const, range: { from: b.from, to: b.to }, goals: await resolveFilterGoals(db, site.id, b.filters as never) };
  const f = b.filters?.length ? filterClauses(ctx, b.filters as never) : null;
  const matching = f ? `SELECT DISTINCT e.session_id FROM events e LEFT JOIN sessions s ON s.id = e.session_id WHERE e.site_id = ? AND e.local_day BETWEEN ? AND ? AND ${f.sql}` : "";
  const params = f ? [site.id, b.from, b.to, ...f.params] : [];
  const [ss, ev] = await db.batch<{ n: number }>(
    f
      ? [db.prepare(`SELECT COUNT(*) AS n FROM (${matching})`).bind(...params), db.prepare(`SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND session_id IN (${matching})`).bind(site.id, ...params)]
      : [
          db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE site_id = ? AND local_day BETWEEN ? AND ?").bind(site.id, b.from, b.to),
          db.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND local_day BETWEEN ? AND ?").bind(site.id, b.from, b.to),
        ],
  );
  const counts = { sessions: ss!.results[0]?.n ?? 0, events: ev!.results[0]?.n ?? 0 };
  const token = await tokenFor(site.id, b, counts);
  if (b.dry_run) return { dry_run: true as const, ...counts, confirm_token: token };
  if (b.confirm !== true && !b.confirm_token) throw new ApiError(400, "confirm_required", "run a dry_run first, then pass its confirm_token (or confirm: true over REST)");
  if ((b.confirm_token || opts.requireToken) && b.confirm_token !== token)
    throw new ApiError(409, "confirm_mismatch", "the selection or its counts changed since the dry run (or the token is wrong): run the dry run again");
  if (f) {
    const res = await db.batch([
      db.prepare(`DELETE FROM sessions WHERE site_id = ? AND id IN (${matching})`).bind(site.id, ...params),
      db.prepare("DELETE FROM events WHERE site_id = ? AND session_id NOT IN (SELECT id FROM sessions WHERE site_id = ?) AND local_day BETWEEN ? AND ?").bind(site.id, site.id, b.from, b.to),
    ]);
    await invalidateRollups(db, site.id, b.from);
    await audit(db, actor, "data.delete", site.id, { from: b.from, to: b.to, filters: b.filters });
    return { sessions_deleted: res[0]!.meta.changes ?? 0, events_deleted: res[1]!.meta.changes ?? 0 };
  }
  const res = await db.batch([
    db.prepare("DELETE FROM events WHERE site_id = ? AND local_day BETWEEN ? AND ?").bind(site.id, b.from, b.to),
    db.prepare("DELETE FROM sessions WHERE site_id = ? AND local_day BETWEEN ? AND ?").bind(site.id, b.from, b.to),
    db.prepare("DELETE FROM rollups_daily WHERE site_id = ? AND day BETWEEN ? AND ?").bind(site.id, b.from, b.to),
  ]);
  await invalidateRollups(db, site.id, b.from);
  await audit(db, actor, "data.delete", site.id, { from: b.from, to: b.to });
  return { events_deleted: res[0]!.meta.changes ?? 0, sessions_deleted: res[1]!.meta.changes ?? 0 };
}

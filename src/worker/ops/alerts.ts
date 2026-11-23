// Traffic alerts: rules per site, evaluated by the 5-minute cron through the query engine (rule 7), sent
// through notification channels with a cooldown.
import { z } from "zod";
import { ApiError } from "../api/common.ts";
import type { Env } from "../env.ts";
import { audit } from "../lib/audit.ts";
import { ulid } from "../lib/ids.ts";
import { getSite, type Site } from "../lib/sites.ts";
import { errors as errorGroups } from "../query/analyses.ts";
import { runQuery } from "../query/run.ts";
import { filterSchema, METRICS, querySchema, type Filter, type Metric } from "../query/schema.ts";
import { notify } from "./notify.ts";

export const ALERT_KINDS = ["above", "below", "change_pct", "no_data", "event", "new_error"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_INFO: Record<AlertKind, string> = {
  above: "The metric over the window is above the threshold",
  below: "The metric over the window is below the threshold",
  change_pct: "The metric changed by more than threshold % against the same window a week earlier (negative = a drop)",
  no_data: "No pageviews at all during the window (tracking broken or site down)",
  event: "A named event happened at least threshold times in the window (e.g. every purchase)",
  new_error: "A JavaScript error that wasn't seen in the previous 30 days",
};

export interface AlertRow {
  id: string;
  site_id: string;
  name: string;
  kind: AlertKind;
  metric: Metric;
  event_name: string | null;
  filters_json: string;
  window_min: number;
  threshold: number;
  cooldown_min: number;
  channel_ids_json: string | null;
  enabled: number;
  last_value: number | null;
  last_checked_at: number | null;
  last_fired_at: number | null;
  created_at: number;
}

export const alertInput = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(ALERT_KINDS),
  metric: z.enum(METRICS).default("visitors"),
  event_name: z.string().max(80).nullable().optional(),
  filters: z.array(filterSchema).max(10).default([]),
  window_min: z.number().int().min(15).max(2880).default(60),
  threshold: z.number().default(0),
  cooldown_min: z.number().int().min(5).max(10_080).default(60),
  channel_ids: z.array(z.string().max(64)).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type AlertInput = z.input<typeof alertInput>;

export function alertView(r: AlertRow) {
  return {
    id: r.id,
    site_id: r.site_id,
    name: r.name,
    kind: r.kind,
    metric: r.metric,
    event_name: r.event_name,
    filters: JSON.parse(r.filters_json) as Filter[],
    window_min: r.window_min,
    threshold: r.threshold,
    cooldown_min: r.cooldown_min,
    channel_ids: r.channel_ids_json ? (JSON.parse(r.channel_ids_json) as string[]) : null,
    enabled: !!r.enabled,
    last_value: r.last_value,
    last_checked_at: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
    last_fired_at: r.last_fired_at ? new Date(r.last_fired_at).toISOString() : null,
  };
}

export async function listAlerts(db: D1Database, siteId: string) {
  const { results } = await db.prepare("SELECT * FROM alert_rules WHERE site_id = ? ORDER BY name").bind(siteId).all<AlertRow>();
  return results.map(alertView);
}

export async function alertHistory(db: D1Database, siteId: string, limit = 100) {
  const { results } = await db.prepare("SELECT * FROM alert_events WHERE site_id = ? ORDER BY ts DESC LIMIT ?").bind(siteId, limit).all<{ id: string; rule_id: string; ts: number; value: number | null; message: string }>();
  return results.map((e) => ({ ...e, ts: new Date(e.ts).toISOString() }));
}

function validate(b: z.output<typeof alertInput>) {
  if (b.kind === "event" && !b.event_name) throw new ApiError(400, "invalid_request", "event alerts need event_name");
  if (b.kind === "change_pct" && b.threshold === 0) throw new ApiError(400, "invalid_request", "change_pct alerts need a threshold: e.g. 50 for a 50 % rise, -30 for a 30 % drop");
  if (b.channel_ids && b.channel_ids.length === 0) throw new ApiError(400, "invalid_request", "channel_ids can't be empty: list channels, or null for every channel");
  if (b.metric === "conversions" || b.metric === "conversion_rate") throw new ApiError(400, "invalid_request", "use an event alert or a filter instead of conversions");
}

/** Create (no id) or update (id) an alert rule. */
export async function saveAlert(db: D1Database, siteId: string, actor: string, input: AlertInput & { id?: string }) {
  if (input.id) {
    const cur = await db.prepare("SELECT * FROM alert_rules WHERE id = ? AND site_id = ?").bind(input.id, siteId).first<AlertRow>();
    if (!cur) throw new ApiError(404, "not_found", "alert not found");
    const v = alertView(cur);
    const b = alertInput.parse({ ...v, ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) });
    validate(b);
    await db
      .prepare("UPDATE alert_rules SET name = ?, kind = ?, metric = ?, event_name = ?, filters_json = ?, window_min = ?, threshold = ?, cooldown_min = ?, channel_ids_json = ?, enabled = ? WHERE id = ?")
      .bind(b.name, b.kind, b.metric, b.event_name ?? null, JSON.stringify(b.filters), b.window_min, b.threshold, b.cooldown_min, b.channel_ids ? JSON.stringify(b.channel_ids) : null, b.enabled === false ? 0 : 1, input.id)
      .run();
    await audit(db, actor, "alert.update", `${siteId}/${input.id}`);
    return alertView((await db.prepare("SELECT * FROM alert_rules WHERE id = ?").bind(input.id).first<AlertRow>())!);
  }
  const b = alertInput.parse(input);
  validate(b);
  const id = ulid();
  await db
    .prepare("INSERT INTO alert_rules (id, site_id, name, kind, metric, event_name, filters_json, window_min, threshold, cooldown_min, channel_ids_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, siteId, b.name, b.kind, b.metric, b.event_name ?? null, JSON.stringify(b.filters), b.window_min, b.threshold, b.cooldown_min, b.channel_ids ? JSON.stringify(b.channel_ids) : null, b.enabled === false ? 0 : 1, Date.now())
    .run();
  await audit(db, actor, "alert.create", `${siteId}/${id}`);
  return alertView((await db.prepare("SELECT * FROM alert_rules WHERE id = ?").bind(id).first<AlertRow>())!);
}

export async function deleteAlert(db: D1Database, siteId: string, actor: string, id: string) {
  const res = await db.prepare("DELETE FROM alert_rules WHERE id = ? AND site_id = ?").bind(id, siteId).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "alert not found");
  await db.prepare("DELETE FROM alert_events WHERE rule_id = ?").bind(id).run();
  await audit(db, actor, "alert.delete", `${siteId}/${id}`);
}

const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const COUNT_METRICS = new Set<Metric>(["visitors", "sessions", "pageviews", "events", "entries", "exits", "revenue"]);

/**
 * The window an occurrence rule (event, new_error) counts: since its last firing when that is recent, so nothing
 * that happened during a cooldown is skipped and nothing already sent is sent again; otherwise the rule's window.
 */
export function occurrenceWindow(r: Pick<AlertRow, "window_min" | "cooldown_min" | "last_fired_at">, now: number): number {
  const recent = r.last_fired_at !== null && now - r.last_fired_at < (r.window_min + r.cooldown_min) * 60_000;
  return recent ? Math.min(10_080, Math.max(5, Math.ceil((now - r.last_fired_at!) / 60_000))) : r.window_min;
}

/** Evaluate one rule now: the value, whether it fires, and the message it would send. */
export async function evaluateRule(db: D1Database, site: Site, r: AlertRow, now = Date.now()): Promise<{ value: number; fire: boolean; message: string }> {
  const filters = JSON.parse(r.filters_json) as Filter[];
  const occurrences = r.kind === "event" || r.kind === "new_error";
  const minutes = occurrences ? occurrenceWindow(r, now) : r.window_min;
  const window = { last_minutes: minutes };
  const span = minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
  const metricRaw = async (metric: Metric, extra: Filter[] = [], at = now) => {
    const res = await runQuery(db, site, querySchema.parse({ metrics: [metric], date_range: window, filters: [...filters, ...extra] }), at);
    const v = res.totals[metric];
    return v === null || v === undefined ? null : Number(v);
  };
  const metricValue = async (metric: Metric, extra: Filter[] = [], at = now) => (await metricRaw(metric, extra, at)) ?? 0;
  switch (r.kind) {
    case "above":
    case "below": {
      const raw = await metricRaw(r.metric);
      // A rate or average with no data (no sessions at night) is unknown, not 0: it never fires.
      if (raw === null && !COUNT_METRICS.has(r.metric)) return { value: 0, fire: false, message: `${site.name}: no data for ${r.metric.replace(/_/g, " ")} in the last ${span}.` };
      const v = raw ?? 0;
      const fire = r.kind === "above" ? v > r.threshold : v < r.threshold;
      return { value: v, fire, message: `${site.name}: ${r.metric.replace(/_/g, " ")} in the last ${span} is ${fmtN(v)}, ${r.kind} your threshold of ${fmtN(r.threshold)}.` };
    }
    case "change_pct": {
      const [v, prev] = await Promise.all([metricValue(r.metric), metricValue(r.metric, [], now - 7 * 86_400_000)]);
      const pct = prev ? ((v - prev) / prev) * 100 : v ? 100 : 0;
      const fire = r.threshold < 0 ? pct <= r.threshold : pct >= r.threshold;
      return { value: Math.round(pct * 10) / 10, fire: fire && (prev > 0 || v > 0), message: `${site.name}: ${r.metric.replace(/_/g, " ")} in the last ${span} is ${fmtN(v)}, ${pct >= 0 ? "+" : ""}${Math.round(pct)}% vs the same time last week (${fmtN(prev)}).` };
    }
    case "no_data": {
      const v = await metricValue("pageviews");
      return { value: v, fire: v === 0, message: `${site.name}: no pageviews in the last ${span}. Tracking may be broken or the site may be down.` };
    }
    case "event": {
      const v = await metricValue("events", [["is", "event_name", [r.event_name ?? ""]]]);
      const min = Math.max(1, r.threshold);
      return { value: v, fire: v >= min, message: `${site.name}: “${r.event_name}” happened ${fmtN(v)} time(s) in the last ${span}.` };
    }
    case "new_error": {
      const recent = await errorGroups(db, site, { date_range: window, filters }, now);
      // Nearly every check, every 5 minutes: no errors in the window means no new ones, so no 30-day lookup. The
      // lookup isn't capped at the top groups, so a rare old error on a busy site isn't mistaken for a new one.
      const before = recent.groups.length ? await errorGroups(db, site, { date_range: { last_minutes: 43_200 }, filters, limit: 10_000 }, now - minutes * 60_000) : null;
      const seen = new Set((before?.groups ?? []).map((g) => String(g.message)));
      const fresh = recent.groups.filter((g) => !seen.has(String(g.message)));
      return { value: fresh.length, fire: fresh.length > 0, message: `${site.name}: ${fresh.length} new JavaScript error(s) in the last ${span}: ${fresh.slice(0, 3).map((g) => `“${String(g.message).slice(0, 80)}”`).join(", ")}.` };
    }
  }
}

/** Run every enabled rule; fire through its channels when the condition holds and the cooldown has passed. */
export async function evaluateAlerts(env: Env, now = Date.now()): Promise<{ checked: number; fired: number }> {
  const { results } = await env.DB.prepare("SELECT * FROM alert_rules WHERE enabled = 1").all<AlertRow>();
  let fired = 0;
  for (const r of results) {
    const site = await getSite(env.DB, r.site_id);
    if (!site) continue;
    try {
      const e = await evaluateRule(env.DB, site, r, now);
      const cooled = !r.last_fired_at || now - r.last_fired_at >= r.cooldown_min * 60_000;
      if (e.fire && cooled) {
        const sent = await notify(env, { title: `${r.name}`, text: e.message, url: `${env.PUBLIC_ORIGIN}/sites/${site.id}`, severity: "alert", data: { site: site.id, rule: r.id, value: e.value }, ...(r.kind === "new_error" ? { category: "error" as const } : {}) }, r.channel_ids_json ? (JSON.parse(r.channel_ids_json) as string[]) : null);
        if (!sent) {
          // Nobody heard it (channel down, deleted or email-only with email off): not fired, so the next run retries
          // and occurrence rules keep counting from the last delivered alert.
          await env.DB.prepare("UPDATE alert_rules SET last_value = ?, last_checked_at = ? WHERE id = ?").bind(e.value, now, r.id).run();
          console.warn(JSON.stringify({ msg: "alert_not_delivered", rule: r.id }));
          continue;
        }
        await env.DB.batch([
          env.DB.prepare("INSERT INTO alert_events (id, rule_id, site_id, ts, value, message) VALUES (?, ?, ?, ?, ?, ?)").bind(ulid(now), r.id, site.id, now, e.value, e.message),
          env.DB.prepare("UPDATE alert_rules SET last_value = ?, last_checked_at = ?, last_fired_at = ? WHERE id = ?").bind(e.value, now, now, r.id),
        ]);
        fired++;
      } else {
        await env.DB.prepare("UPDATE alert_rules SET last_value = ?, last_checked_at = ? WHERE id = ?").bind(e.value, now, r.id).run();
      }
    } catch (err) {
      console.error(JSON.stringify({ msg: "alert_eval_failed", rule: r.id, error: String((err as Error).message ?? err).slice(0, 200) }));
    }
  }
  await env.DB.prepare("DELETE FROM alert_events WHERE ts < ?").bind(now - 180 * 86_400_000).run();
  return { checked: results.length, fired };
}

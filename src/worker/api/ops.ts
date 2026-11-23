// Ops hub: status board, editable checks, incidents, ops settings (backups, size warning), ops jobs.
import { isValidTimeZone } from "../lib/time.ts";
import { z, type OpenAPIHono } from "@hono/zod-openapi";
import { hasScope, type Principal } from "../auth/principal.ts";
import type { Env } from "../env.ts";
import { audit } from "../lib/audit.ts";
import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { getOpsSettings, opsSettingsSchema, putSetting, type OpsSettings } from "../lib/settings.ts";
import { onlyGiven } from "../lib/patch.ts";
import { siteSlug } from "../lib/sites.ts";
import { configSchemas, displayTarget, INTERVALS, KIND_INFO, MONITOR_KINDS, recordCheck, runCheck, statusReport, updateIncident, type Monitor, type MonitorKind } from "../ops/monitor.ts";
import { ApiError, type AppEnv } from "./common.ts";
import { r } from "./route.ts";

const idParam = z.object({ id: z.string().min(1).max(64).openapi({ param: { name: "id", in: "path" } }) });

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
export const quietHours = z.object({ from: HHMM, to: HHMM, tz: z.string().max(64).default("UTC") }).openapi("QuietHours");

export const monitorInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/).optional().openapi({ description: "Optional; derived from the name" }),
  name: z.string().min(1).max(80),
  kind: z.enum(MONITOR_KINDS).default("http").openapi({ description: Object.entries(KIND_INFO).map(([k, v]) => `${k}: ${v}`).join(". ") }),
  url: z.string().max(500).optional().openapi({ description: "http/json kinds: an https URL, or self:/path for a Pulse URL" }),
  site_id: z.string().max(64).nullable().optional().openapi({ description: "Group the check under a site on the status page" }),
  interval_min: z.number().int().refine((v) => (INTERVALS as readonly number[]).includes(v), `one of ${INTERVALS.join(", ")}`).optional(),
  timeout_ms: z.number().int().min(1000).max(30_000).optional(),
  failures_to_alert: z.number().int().min(1).max(10).optional().openapi({ description: "Consecutive failures before an incident opens and you're notified" }),
  degraded_ms: z.number().int().min(50).max(60_000).nullable().optional().openapi({ description: "Slower than this counts as degraded (no incident)" }),
  notify: z.boolean().optional().openapi({ description: "Send alerts when it goes down and recovers" }),
  channel_ids: z.array(z.string().max(64)).nullable().optional().openapi({ description: "Notification channels for this check; null = all enabled channels" }),
  config: z.record(z.string(), z.unknown()).optional().openapi({ description: "Kind-specific settings; see the help topic status_checks" }),
  quiet_hours: quietHours.nullable().optional().openapi({ description: "Daily window (local time) when failures are recorded but open no incident and send nothing, e.g. a nightly lull or a job's run; null removes it" }),
});
export type MonitorInput = z.input<typeof monitorInput>;

type Row = Omit<Monitor, "created_at" | "enabled" | "temporary" | "last_ping_at" | "updated_at" | "sort" | "paused_until" | "channel_ids_json"> & { channel_ids_json: string | null };

/** Validate input (merged over an existing check when editing) into a row. A new heartbeat gets a token. */
export function prepareMonitor(input: MonitorInput, existing?: Monitor): { row: Row; token: string | null } {
  const b = onlyGiven(monitorInput.partial().parse(input), input);
  const kind = (b.kind ?? existing?.kind ?? "http") as MonitorKind;
  const prevConfig = existing && existing.kind === kind ? (JSON.parse(existing.config_json || "{}") as Record<string, unknown>) : {};
  const merged = { ...prevConfig, ...(b.config ?? {}) };
  delete (merged as { token_hash?: unknown }).token_hash;
  delete (merged as { quiet_hours?: unknown }).quiet_hours;
  const config = configSchemas[kind].parse(merged) as Record<string, unknown>;
  if (prevConfig.token_hash) config.token_hash = prevConfig.token_hash;
  // Quiet hours apply to every kind, so they live beside the kind's settings.
  const quiet = b.quiet_hours === undefined ? (prevConfig.quiet_hours as unknown) : b.quiet_hours;
  if (quiet) {
    const q = quietHours.parse(quiet);
    if (!isValidTimeZone(q.tz)) throw new ApiError(400, "invalid_timezone", "quiet_hours.tz is not a time zone");
    config.quiet_hours = q;
  }
  let url = b.url ?? (existing && existing.kind === kind ? existing.url : "");
  if (kind === "http" || kind === "json" || kind === "json_nonempty") {
    if (!/^(https?:\/\/[^\s]+|self:\/[^\s]*)$/.test(url)) throw new ApiError(400, "invalid_url", "url must be an http(s) URL or self:/path");
  } else {
    url = kind === "d1_query" ? `d1:${String(config.database)}` : kind === "dns" ? `dns:${String(config.name)}` : kind === "domain_expiry" ? `rdap:${String(config.domain)}` : kind === "pulse_ingest" ? "self:ingest" : "heartbeat";
  }
  let token: string | null = null;
  if (kind === "heartbeat" && !config.token_hash) token = randomToken(24);
  const name = b.name ?? existing?.name;
  if (!name) throw new ApiError(400, "invalid_request", "name required");
  return {
    row: {
      id: existing?.id ?? b.id ?? siteSlug(name).slice(0, 40),
      name,
      kind,
      url,
      expect_status: existing?.expect_status ?? 200,
      site_id: b.site_id === undefined ? (existing?.site_id ?? null) : b.site_id,
      config_json: JSON.stringify(config),
      interval_min: b.interval_min ?? existing?.interval_min ?? (kind === "domain_expiry" ? 1440 : 5),
      timeout_ms: b.timeout_ms ?? existing?.timeout_ms ?? 10_000,
      failures_to_alert: b.failures_to_alert ?? existing?.failures_to_alert ?? 2,
      degraded_ms: b.degraded_ms === undefined ? (existing?.degraded_ms ?? null) : b.degraded_ms,
      notify: b.notify === undefined ? (existing?.notify ?? 1) : b.notify ? 1 : 0,
      channel_ids_json: b.channel_ids === undefined ? (existing?.channel_ids_json ?? null) : b.channel_ids ? JSON.stringify(b.channel_ids) : null,
    },
    token,
  };
}

async function withToken(row: Row, token: string | null): Promise<Row> {
  if (!token) return row;
  const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
  cfg.token_hash = await sha256Hex(token);
  return { ...row, config_json: JSON.stringify(cfg) };
}

/** Public view of a check: config without secrets, plus a readable target. */
export function monitorView(env: Pick<Env, "PUBLIC_ORIGIN">, m: Monitor) {
  const config = JSON.parse(m.config_json || "{}") as Record<string, unknown>;
  delete config.token_hash;
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    url: m.kind === "http" || m.kind === "json" || m.kind === "json_nonempty" ? m.url : null,
    target: displayTarget(env, m),
    site_id: m.site_id,
    interval_min: m.interval_min,
    timeout_ms: m.timeout_ms,
    failures_to_alert: m.failures_to_alert,
    degraded_ms: m.degraded_ms,
    notify: !!m.notify,
    channel_ids: m.channel_ids_json ? (JSON.parse(m.channel_ids_json) as string[]) : null,
    paused_until: m.paused_until && m.paused_until > Date.now() ? new Date(m.paused_until).toISOString() : null,
    last_ping_at: m.last_ping_at ? new Date(m.last_ping_at).toISOString() : null,
    config,
    created_at: new Date(m.created_at).toISOString(),
  };
}

/** Site-scoped principals only see and change checks grouped under their sites. */
export function canTouchMonitor(p: Principal, siteId: string | null): boolean {
  return p.siteIds === null || (siteId !== null && p.siteIds.includes(siteId));
}

/** d1_query checks run SQL with the account-wide ops token, which can read every D1 database: admin only. */
function requireKindAllowed(p: Principal, kind: string | undefined) {
  if (kind === "d1_query" && !hasScope(p, "admin")) throw new ApiError(403, "insufficient_scope", "database query checks require scope admin (they can read any D1 database in the account)");
}

/** A site-scoped principal's Pulse-ingest check must watch one of its own sites, not another or the whole instance. */
function requireConfigAllowed(p: Principal, row: { kind: string; config_json: string }) {
  if (row.kind !== "pulse_ingest" || p.siteIds === null) return;
  const site = (JSON.parse(row.config_json || "{}") as { site_id?: string }).site_id;
  if (!site || !p.siteIds.includes(site)) throw new ApiError(403, "forbidden", "site-scoped keys can only watch ingest for their own sites (set config.site_id)");
}

function requireAllSites(p: Principal) {
  if (p.siteIds !== null) throw new ApiError(403, "forbidden", "site-scoped keys can't change instance settings");
}

/** A check the principal may see, or 404. */
async function monitorFor(db: D1Database, p: Principal, id: string): Promise<Monitor> {
  const m = await getMonitor(db, id);
  if (!m || !canTouchMonitor(p, m.site_id)) throw new ApiError(404, "not_found", "check not found");
  return m;
}

export async function getMonitor(db: D1Database, id: string): Promise<Monitor | null> {
  return db.prepare("SELECT * FROM monitors WHERE id = ? AND enabled = 1").bind(id).first<Monitor>();
}

export async function listMonitors(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM monitors WHERE enabled = 1 ORDER BY sort, name").all<Monitor>();
  return results.map((m) => monitorView(env, m));
}

const heartbeatUrl = (env: Pick<Env, "PUBLIC_ORIGIN">, token: string) => `${env.PUBLIC_ORIGIN}/hb/${token}`;

export async function createMonitor(env: Env, p: Principal, input: MonitorInput) {
  const prepared = prepareMonitor(monitorInput.parse(input));
  requireKindAllowed(p, prepared.row.kind);
  requireConfigAllowed(p, prepared.row);
  if (!canTouchMonitor(p, prepared.row.site_id)) throw new ApiError(403, "forbidden", "site-scoped keys can only add checks under their sites (set site_id)");
  const row = await withToken(prepared.row, prepared.token);
  if (await env.DB.prepare("SELECT 1 FROM monitors WHERE id = ?").bind(row.id).first()) throw new ApiError(409, "monitor_exists", `a check with id ${row.id} already exists; pick another id or PATCH it`);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO monitors (id, name, kind, url, expect_status, enabled, temporary, created_at, site_id, config_json, interval_min, timeout_ms, failures_to_alert, degraded_ms, notify, channel_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.name, row.kind, row.url, row.expect_status, now, row.site_id, row.config_json, row.interval_min, row.timeout_ms, row.failures_to_alert, row.degraded_ms, row.notify, row.channel_ids_json, now)
    .run();
  await audit(env.DB, p.label, "monitor.create", row.id, { kind: row.kind, target: displayTarget(env, row as Monitor) });
  const m = (await getMonitor(env.DB, row.id))!;
  return { ...monitorView(env, m), ...(prepared.token ? { heartbeat_url: heartbeatUrl(env, prepared.token) } : {}) };
}

export async function updateMonitor(env: Env, p: Principal, id: string, input: MonitorInput) {
  const cur = await monitorFor(env.DB, p, id);
  requireKindAllowed(p, cur.kind);
  const prepared = prepareMonitor(input, cur);
  requireKindAllowed(p, prepared.row.kind);
  requireConfigAllowed(p, prepared.row);
  if (!canTouchMonitor(p, prepared.row.site_id)) throw new ApiError(403, "forbidden", "site-scoped keys can only move checks between their sites");
  const row = await withToken(prepared.row, prepared.token);
  await env.DB.prepare(
    "UPDATE monitors SET name = ?, kind = ?, url = ?, site_id = ?, config_json = ?, interval_min = ?, timeout_ms = ?, failures_to_alert = ?, degraded_ms = ?, notify = ?, channel_ids_json = ?, updated_at = ? WHERE id = ?",
  )
    .bind(row.name, row.kind, row.url, row.site_id, row.config_json, row.interval_min, row.timeout_ms, row.failures_to_alert, row.degraded_ms, row.notify, row.channel_ids_json, Date.now(), id)
    .run();
  await audit(env.DB, p.label, "monitor.update", id, Object.keys(input));
  const m = (await getMonitor(env.DB, id))!;
  return { ...monitorView(env, m), ...(prepared.token ? { heartbeat_url: heartbeatUrl(env, prepared.token) } : {}) };
}

export async function deleteMonitor(env: Env, p: Principal, id: string) {
  await monitorFor(env.DB, p, id);
  const res = await env.DB.prepare("DELETE FROM monitors WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "check not found");
  await env.DB.batch([env.DB.prepare("DELETE FROM checks WHERE monitor_id = ?").bind(id), env.DB.prepare("DELETE FROM monitor_days WHERE monitor_id = ?").bind(id), env.DB.prepare("DELETE FROM incidents WHERE monitor_id = ?").bind(id)]);
  await audit(env.DB, p.label, "monitor.delete", id);
}

/** Pause until a time (minutes from now, or an ISO time); null resumes. */
export async function pauseMonitor(env: Env, p: Principal, id: string, b: { minutes?: number | null; until?: string | null }) {
  await monitorFor(env.DB, p, id);
  const until = b.minutes ? Date.now() + b.minutes * 60_000 : b.until ? Date.parse(b.until) : null;
  if (until !== null && (!Number.isFinite(until) || until <= Date.now())) throw new ApiError(400, "invalid_request", "until must be in the future");
  await env.DB.prepare("UPDATE monitors SET paused_until = ?, updated_at = ? WHERE id = ?").bind(until, Date.now(), id).run();
  await audit(env.DB, p.label, until ? "monitor.pause" : "monitor.resume", id, until ? { until: new Date(until).toISOString() } : undefined);
  return monitorView(env, (await getMonitor(env.DB, id))!);
}

/** Run a saved check now; with record, store the result like a scheduled run (opens/resolves incidents). */
export async function runMonitorNow(env: Env, id: string, record: boolean) {
  const m = await getMonitor(env.DB, id);
  if (!m) throw new ApiError(404, "not_found", "check not found");
  const now = Date.now();
  const r = await runCheck(env, m, now);
  if (record) {
    await recordCheck(env, m, r, now);
    await updateIncident(env, m, r, now);
  }
  return { ...r, checked_at: new Date(now).toISOString(), recorded: record };
}

/** Dry run of an unsaved check. */
export async function testMonitor(env: Env, p: Principal, input: MonitorInput) {
  const { row } = prepareMonitor({ ...input, name: input.name ?? "test" });
  requireKindAllowed(p, row.kind);
  requireConfigAllowed(p, row);
  const now = Date.now();
  const m = { ...row, enabled: 1, temporary: 0, created_at: now, paused_until: null, sort: 0, last_ping_at: null, updated_at: null } as Monitor;
  return { ...(await runCheck(env, m, now)), target: displayTarget(env, m) };
}

export async function listIncidents(env: Env, status: "open" | "all" = "all", limit = 100, monitorId?: string) {
  const where = [...(status === "open" ? ["i.resolved_at IS NULL"] : []), ...(monitorId ? ["i.monitor_id = ?"] : [])];
  const { results } = await env.DB.prepare(
    `SELECT i.*, m.name AS monitor_name, m.site_id FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.started_at DESC LIMIT ?`,
  )
    .bind(...(monitorId ? [monitorId] : []), Math.min(Math.max(limit, 1), 500))
    .all<Record<string, unknown>>();
  const iso = (v: unknown) => (typeof v === "number" ? new Date(v).toISOString() : null);
  return results.map((i) => ({ id: i.id, monitor_id: i.monitor_id, monitor_name: i.monitor_name, site_id: i.site_id, started_at: iso(i.started_at), resolved_at: iso(i.resolved_at), error: i.error, note: i.note, acknowledged_at: iso(i.acknowledged_at), acknowledged_by: i.acknowledged_by }));
}

export const incidentPatch = z.object({ note: z.string().max(2000).nullable().optional(), acknowledged: z.boolean().optional(), resolved: z.literal(true).optional().openapi({ description: "Close it by hand (the next failing check opens a new one)" }) });

export async function updateIncidentRecord(env: Env, p: Principal, id: string, input: z.input<typeof incidentPatch>) {
  const b = onlyGiven(incidentPatch.parse(input), input);
  const cur = await env.DB.prepare("SELECT i.*, m.site_id FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id WHERE i.id = ?").bind(id).first<{ note: string | null; acknowledged_at: number | null; acknowledged_by: string | null; resolved_at: number | null; site_id: string | null }>();
  if (!cur || !canTouchMonitor(p, cur.site_id)) throw new ApiError(404, "not_found", "incident not found");
  const ack = b.acknowledged === undefined ? [cur.acknowledged_at, cur.acknowledged_by] : b.acknowledged ? [Date.now(), p.label] : [null, null];
  await env.DB.prepare("UPDATE incidents SET note = ?, acknowledged_at = ?, acknowledged_by = ?, resolved_at = ? WHERE id = ?")
    .bind(b.note === undefined ? cur.note : b.note, ack[0], ack[1], b.resolved ? (cur.resolved_at ?? Date.now()) : cur.resolved_at, id)
    .run();
  await audit(env.DB, p.label, "incident.update", id, b);
  return (await listIncidents(env, "all", 500)).find((i) => i.id === id);
}

export const opsSettingsPatch = opsSettingsSchema.partial();

export async function updateOpsSettings(env: Env, p: Principal, input: z.input<typeof opsSettingsPatch>): Promise<OpsSettings> {
  requireAllSites(p);
  const b = onlyGiven(opsSettingsPatch.parse(input), input);
  const cur = await getOpsSettings(env.DB);
  // Which databases are backed up and drilled decides what can be recovered: admin only. ops:write (which an
  // OAuth connector can hold) may still send them unchanged, e.g. when saving the whole form.
  const same = (a: string[] | undefined, c: string[]) => a === undefined || JSON.stringify(a) === JSON.stringify(c);
  if ((!same(b.backup_databases, cur.backup_databases) || !same(b.drill_databases, cur.drill_databases)) && !hasScope(p, "admin"))
    throw new ApiError(403, "insufficient_scope", "changing backup_databases or drill_databases requires scope admin");
  const next = opsSettingsSchema.parse({ ...cur, ...b });
  await putSetting(env.DB, "ops", next, p.label);
  await audit(env.DB, p.label, "settings.ops", null, b);
  return next;
}

export function registerOps(api: OpenAPIHono<AppEnv>): void {
  api.openapi(r({ method: "get", path: "/ops/status", tags: ["Status"], description: "Status board: every check with state, uptime (24 h/7 d/30 d/90 d), median response, 90 daily cells; incidents; database sizes; backups", scope: "stats:read" }), async (c) => {
    const p = c.get("principal");
    const r = await statusReport(c.env);
    if (p.siteIds === null) return c.json(r);
    return c.json({ ...r, monitors: r.monitors.filter((m) => canTouchMonitor(p, m.site_id)), incidents: r.incidents.filter((i) => canTouchMonitor(p, i.site_id)), databases: [], backups: null });
  });

  api.openapi(r({ method: "get", path: "/ops/monitors", tags: ["Status"], description: "Status checks with their configuration (no secrets)", scope: "stats:read" }), async (c) =>
    c.json({ data: (await listMonitors(c.env)).filter((m) => canTouchMonitor(c.get("principal"), m.site_id)), kinds: KIND_INFO, intervals: INTERVALS }),
  );

  api.openapi(r({ method: "get", path: "/ops/monitors/{id}", tags: ["Status"], description: "One status check", request: { params: idParam }, scope: "stats:read" }), async (c) => {
    return c.json({ data: monitorView(c.env, await monitorFor(c.env.DB, c.get("principal"), c.req.param("id") ?? "")) });
  });

  api.openapi(
    r({ method: "post", path: "/ops/monitors", tags: ["Status"], description: "Add a status check. Heartbeat checks return their ping URL once.", request: { body: { content: { "application/json": { schema: monitorInput } } } }, scope: "ops:write" }),
    async (c) => c.json({ data: await createMonitor(c.env, c.get("principal"), await c.req.json()) }, 201 as 200),
  );

  api.openapi(
    r({ method: "post", path: "/ops/monitors/test", tags: ["Status"], description: "Try a check configuration without saving it", request: { body: { content: { "application/json": { schema: monitorInput.partial() } } } }, scope: "ops:write" }),
    async (c) => c.json({ data: await testMonitor(c.env, c.get("principal"), await c.req.json()) }),
  );

  api.openapi(
    r({ method: "patch", path: "/ops/monitors/{id}", tags: ["Status"], description: "Edit a status check (config is merged)", request: { params: idParam, body: { content: { "application/json": { schema: monitorInput.partial() } } } }, scope: "ops:write" }),
    async (c) => c.json({ data: await updateMonitor(c.env, c.get("principal"), c.req.param("id") ?? "", await c.req.json()) }),
  );

  api.openapi(r({ method: "delete", path: "/ops/monitors/{id}", tags: ["Status"], description: "Delete a status check with its history", request: { params: idParam }, scope: "ops:write" }), async (c) => {
    await deleteMonitor(c.env, c.get("principal"), c.req.param("id") ?? "");
    return c.json({ data: { deleted: true } });
  });

  api.openapi(
    r({ method: "post", path: "/ops/monitors/{id}/check", tags: ["Status"], description: "Run a check now. With record=true the result is stored like a scheduled run.", request: { params: idParam, query: z.object({ record: z.enum(["true", "false"]).optional() }) }, scope: "ops:write" }),
    async (c) => {
      const m = await monitorFor(c.env.DB, c.get("principal"), c.req.param("id") ?? "");
      requireKindAllowed(c.get("principal"), m.kind);
      return c.json({ data: await runMonitorNow(c.env, m.id, c.req.query("record") === "true") });
    },
  );

  const pauseBody = z.object({ minutes: z.number().int().min(1).max(525_600).nullable().optional(), until: z.string().datetime({ offset: true }).nullable().optional() });
  api.openapi(
    r({ method: "post", path: "/ops/monitors/{id}/pause", tags: ["Status"], description: "Pause a check (maintenance) for some minutes or until a time; send {} or nulls to resume", request: { params: idParam, body: { content: { "application/json": { schema: pauseBody } } } }, scope: "ops:write" }),
    async (c) => c.json({ data: await pauseMonitor(c.env, c.get("principal"), c.req.param("id") ?? "", pauseBody.parse(await c.req.json())) }),
  );

  api.openapi(r({ method: "post", path: "/ops/monitors/{id}/heartbeat-token", tags: ["Status"], description: "Issue a new ping URL for a heartbeat check (the old one stops working). Shown once.", request: { params: idParam }, scope: "ops:write" }), async (c) => {
    const m = await monitorFor(c.env.DB, c.get("principal"), c.req.param("id") ?? "");
    if (m.kind !== "heartbeat") throw new ApiError(404, "not_found", "heartbeat check not found");
    const token = randomToken(24);
    const cfg = JSON.parse(m.config_json) as Record<string, unknown>;
    cfg.token_hash = await sha256Hex(token);
    await c.env.DB.prepare("UPDATE monitors SET config_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(cfg), Date.now(), m.id).run();
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "monitor.heartbeat_token", m.id));
    return c.json({ data: { heartbeat_url: heartbeatUrl(c.env, token) } });
  });

  api.openapi(
    r({ method: "get", path: "/ops/monitors/{id}/checks", tags: ["Status"], description: "Recent results of one check (newest first)", request: { params: idParam, query: z.object({ hours: z.coerce.number().int().min(1).max(2160).optional() }) }, scope: "stats:read" }),
    async (c) => {
      await monitorFor(c.env.DB, c.get("principal"), c.req.param("id") ?? "");
      const hours = Number(c.req.query("hours") ?? 24);
      const { results } = await c.env.DB.prepare("SELECT ts, ok, status, ms, error FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 5000")
        .bind(c.req.param("id") ?? "", Date.now() - hours * 3_600_000)
        .all<{ ts: number; ok: number; status: number | null; ms: number | null; error: string | null }>();
      return c.json({ data: results.map((x) => ({ ...x, ok: !!x.ok, ts: new Date(x.ts).toISOString() })) });
    },
  );

  api.openapi(
    r({
      method: "get",
      path: "/ops/incidents",
      tags: ["Status"],
      description: "Incidents, newest first, optionally for one check",
      request: { query: z.object({ status: z.enum(["open", "all"]).optional(), monitor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }) },
      scope: "stats:read",
    }),
    async (c) => {
      const status = c.req.query("status") === "open" ? "open" : "all";
      const limit = Number(c.req.query("limit") ?? 100) || 100;
      const rows = await listIncidents(c.env, status, limit, c.req.query("monitor") || undefined);
      return c.json({ data: rows.filter((i) => canTouchMonitor(c.get("principal"), (i.site_id as string | null) ?? null)) });
    },
  );

  api.openapi(
    r({ method: "patch", path: "/ops/incidents/{id}", tags: ["Status"], description: "Add a note to, acknowledge or close an incident", request: { params: idParam, body: { content: { "application/json": { schema: incidentPatch } } } }, scope: "ops:write" }),
    async (c) => c.json({ data: await updateIncidentRecord(c.env, c.get("principal"), c.req.param("id") ?? "", await c.req.json()) }),
  );

  api.openapi(r({ method: "get", path: "/ops/settings", tags: ["Status"], description: "Ops settings: which databases are backed up and drilled, and the D1 size warning (scheduled reports have their own routes)", scope: "stats:read" }), async (c) =>
    c.json({ data: await getOpsSettings(c.env.DB) }),
  );

  api.openapi(
    r({ method: "patch", path: "/ops/settings", tags: ["Status"], description: "Change ops settings (merged)", request: { body: { content: { "application/json": { schema: opsSettingsPatch } } } }, scope: "ops:write" }),
    async (c) => c.json({ data: await updateOpsSettings(c.env, c.get("principal"), await c.req.json()) }),
  );

  api.openapi(r({ method: "get", path: "/ops/databases", tags: ["Status"], description: "D1 databases in the Cloudflare account (names and sizes), for backup and query-check pickers", scope: "ops:write" }), async (c) => {
    requireAllSites(c.get("principal"));
    const { listD1 } = await import("../ops/cfapi.ts");
    if (!c.env.PULSE_OPS_TOKEN) return c.json({ data: [], available: false, reason: "PULSE_OPS_TOKEN is not configured, so database names can't be listed" });
    const dbs = await listD1(c.env);
    return c.json({ data: dbs.map((d) => ({ name: d.name, size_mb: d.file_size ? Math.round((d.file_size / 1048576) * 10) / 10 : null })), available: true });
  });

  const opsJob = z.object({ job: z.enum(["monitors", "db_sizes", "ops_backup", "restore_drill", "digest", "pulse_backup", "retention"]) });
  api.openapi(r({ method: "post", path: "/ops/run", tags: ["Status"], description: "Run an ops job now (admin): monitors, db_sizes, ops_backup, restore_drill, digest (sends the weekly-digest report), pulse_backup, retention", request: { body: { content: { "application/json": { schema: opsJob } } } }, scope: "admin" }), async (c) => {
    const { job } = opsJob.parse(await c.req.json());
    const mon = await import("../ops/monitor.ts");
    const bk = await import("../ops/backups.ts");
    const cron = await import("../cron/jobs.ts");
    const run: Record<string, () => Promise<unknown>> = {
      monitors: () => mon.runMonitors(c.env),
      db_sizes: () => mon.recordDbSizes(c.env),
      ops_backup: () => bk.backupDatabases(c.env),
      restore_drill: () => bk.restoreDrill(c.env),
      digest: async () => {
        const rep = await import("../ops/reports.ts");
        const d = await rep.sendReport(c.env, rep.reportView(await rep.getReport(c.env.DB, "weekly-digest")));
        return { delivered: d.delivered, subject: d.subject, numbers: d.numbers };
      },
      pulse_backup: () => cron.backup(c.env),
      retention: () => cron.retention(c.env),
    };
    c.executionCtx.waitUntil(audit(c.env.DB, c.get("principal").label, "ops.run", job));
    return c.json({ data: await run[job]!() });
  });
}

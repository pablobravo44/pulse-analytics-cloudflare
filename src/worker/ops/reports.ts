// Scheduled reports: weekly or monthly summaries of chosen sites, sent through notification channels.
// The old weekly ops digest is the report "weekly-digest" (migration 0005). Numbers come from the presets.
import { z } from "zod";
import { ApiError } from "../api/common.ts";
import type { Env } from "../env.ts";
import { ulid } from "../lib/ids.ts";
import { onlyGiven } from "../lib/patch.ts";
import { listSitesCached, type Site } from "../lib/sites.ts";
import { addDays, isValidTimeZone, localParts, weekStart } from "../lib/time.ts";
import { aiSources, movers, summary } from "../query/presets.ts";
import { emailHtml, type MailBlock } from "./mailtpl.ts";
import { statusReport } from "./monitor.ts";
import { notify } from "./notify.ts";

export const REPORT_SECTIONS = ["kpis", "pages", "sources", "ai", "goals", "movers"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const reportInput = z.object({
  name: z.string().min(1).max(80),
  site_ids: z.array(z.string().min(1).max(64)).min(1).max(50).nullable().optional(),
  frequency: z.enum(["weekly", "monthly"]).default("weekly"),
  weekday: z.number().int().min(0).max(6).default(1),
  day_of_month: z.number().int().min(1).max(28).default(1),
  hour: z.number().int().min(0).max(23).default(8),
  timezone: z.string().refine(isValidTimeZone, "unknown time zone").default("UTC"),
  sections: z.array(z.enum(REPORT_SECTIONS)).min(1).default([...REPORT_SECTIONS]),
  include_ops: z.boolean().default(false),
  channel_ids: z.array(z.string().min(1).max(64)).nullable().optional(),
  enabled: z.boolean().default(true),
});
export type ReportInput = z.input<typeof reportInput>;

export interface ReportRow {
  id: string;
  name: string;
  site_ids_json: string | null;
  frequency: "weekly" | "monthly";
  weekday: number;
  day_of_month: number;
  hour: number;
  timezone: string;
  sections_json: string;
  include_ops: number;
  channel_ids_json: string | null;
  enabled: number;
  last_sent_at: number | null;
  last_period: string | null;
  last_error: string | null;
  created_by: string;
  created_at: number;
  updated_at: number | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function reportView(r: ReportRow) {
  return {
    id: r.id,
    name: r.name,
    site_ids: parse<string[] | null>(r.site_ids_json, null),
    frequency: r.frequency,
    weekday: r.weekday,
    day_of_month: r.day_of_month,
    hour: r.hour,
    timezone: r.timezone,
    sections: parse<ReportSection[]>(r.sections_json, [...REPORT_SECTIONS]),
    include_ops: !!r.include_ops,
    channel_ids: parse<string[] | null>(r.channel_ids_json, null),
    enabled: !!r.enabled,
    last_sent_at: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null,
    last_error: r.last_error,
    created_by: r.created_by,
  };
}
export type Report = ReturnType<typeof reportView>;

/** Reports visible to a principal: all of them, or for a site-scoped principal only those limited to its sites. */
export async function listReports(db: D1Database, siteIds: string[] | null) {
  const { results } = await db.prepare("SELECT * FROM reports ORDER BY created_at, name").all<ReportRow>();
  const all = results.map(reportView);
  return siteIds === null ? all : all.filter((r) => r.site_ids !== null && r.site_ids.every((s) => siteIds.includes(s)));
}

export async function getReport(db: D1Database, id: string): Promise<ReportRow> {
  const row = await db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<ReportRow>();
  if (!row) throw new ApiError(404, "not_found", "report not found");
  return row;
}

async function checkSites(db: D1Database, ids: string[] | null | undefined) {
  if (!ids) return;
  const known = new Set((await listSitesCached(db)).map((s) => s.id));
  const bad = ids.filter((s) => !known.has(s));
  if (bad.length) throw new ApiError(400, "invalid_request", `unknown sites: ${bad.join(", ")}`);
}

export async function createReport(db: D1Database, actor: string, input: unknown) {
  const b = reportInput.parse(input);
  await checkSites(db, b.site_ids);
  const id = ulid();
  await db
    .prepare(
      "INSERT INTO reports (id, name, site_ids_json, frequency, weekday, day_of_month, hour, timezone, sections_json, include_ops, channel_ids_json, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, b.name, b.site_ids ? JSON.stringify(b.site_ids) : null, b.frequency, b.weekday, b.day_of_month, b.hour, b.timezone, JSON.stringify(b.sections), b.include_ops ? 1 : 0, b.channel_ids ? JSON.stringify(b.channel_ids) : null, b.enabled ? 1 : 0, actor, Date.now(), Date.now())
    .run();
  return reportView(await getReport(db, id));
}

export async function updateReport(db: D1Database, id: string, input: unknown) {
  const cur = reportView(await getReport(db, id));
  const b = onlyGiven(reportInput.partial().parse(input), input);
  await checkSites(db, b.site_ids);
  const n = { ...cur, ...b };
  await db
    .prepare("UPDATE reports SET name = ?, site_ids_json = ?, frequency = ?, weekday = ?, day_of_month = ?, hour = ?, timezone = ?, sections_json = ?, include_ops = ?, channel_ids_json = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .bind(n.name, n.site_ids ? JSON.stringify(n.site_ids) : null, n.frequency, n.weekday, n.day_of_month, n.hour, n.timezone, JSON.stringify(n.sections), n.include_ops ? 1 : 0, n.channel_ids ? JSON.stringify(n.channel_ids) : null, n.enabled ? 1 : 0, Date.now(), id)
    .run();
  return reportView(await getReport(db, id));
}

export async function deleteReport(db: D1Database, id: string) {
  const res = await db.prepare("DELETE FROM reports WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "report not found");
}

/** The last complete period before `now`: Monday–Sunday for weekly, the previous calendar month for monthly. */
export function reportPeriod(r: Pick<Report, "frequency" | "timezone">, now = Date.now()): { from: string; to: string } {
  const today = localParts(now, r.timezone).day;
  if (r.frequency === "monthly") {
    const firstThis = `${today.slice(0, 7)}-01`;
    const to = addDays(firstThis, -1);
    return { from: `${to.slice(0, 7)}-01`, to };
  }
  const from = addDays(weekStart(today), -7);
  return { from, to: addDays(from, 6) };
}

/**
 * Due from the configured local weekday (or day of month) and hour, once per period: `lastPeriod` is the first day
 * of the last period sent on schedule. Manual sends ("send now") don't count, so they never skip a scheduled one.
 * A run that misses the hour (cron outage, every channel down, an hour skipped by a DST change) catches up until
 * the same hour the next day. Returns the instant whose period is due (on the scheduled day), or null.
 */
export function reportDueAt(r: Report, lastPeriod: string | null, now = Date.now()): number | null {
  if (!r.enabled) return null;
  const scheduledDay = (day: string) =>
    r.frequency === "monthly" ? Number(day.slice(8, 10)) === r.day_of_month : new Date(`${day}T00:00:00Z`).getUTCDay() === r.weekday;
  const local = localParts(now, r.timezone);
  let ref: number | null = null;
  if (scheduledDay(local.day) && local.hour >= r.hour) ref = now;
  else if (local.hour < r.hour && scheduledDay(localParts(now - 86_400_000, r.timezone).day)) ref = now - 86_400_000;
  if (ref === null) return null;
  return lastPeriod !== reportPeriod(r, ref).from ? ref : null;
}

export function isReportDue(r: Report, lastPeriod: string | null, now = Date.now()): boolean {
  return reportDueAt(r, lastPeriod, now) !== null;
}

const num = (v: unknown) => (v === null || v === undefined ? "–" : new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(Number(v)));
const chg = (v: number | null | undefined) => (v === null || v === undefined ? undefined : `${v >= 0 ? "+" : "−"}${Math.abs(v)}%`);

async function siteBlocks(env: Env, site: Site, range: { from: string; to: string }, sections: ReportSection[], now: number) {
  const c = { date_range: range, timezone: "site" as const, compare: "previous_period" as const, filters: [] };
  const want = (s: ReportSection) => sections.includes(s);
  const [s, ai, mv] = await Promise.all([summary(env.DB, site, c, now), want("ai") ? aiSources(env.DB, site, c, now) : null, want("movers") ? movers(env.DB, site, { ...c, dimension: "page", metric: "visitors", limit: 3 }, now) : null]);
  const k = s.kpis as Record<string, { value: number | null; change_pct: number | null }>;
  const rows: [string, string, string?, boolean?][] = [];
  const text: string[] = [site.name];
  if (want("kpis")) {
    rows.push(["Visitors", num(k.visitors?.value), chg(k.visitors?.change_pct)], ["Pageviews", num(k.pageviews?.value), chg(k.pageviews?.change_pct)], ["Bounce rate", `${num(k.bounce_rate?.value)}%`, chg(k.bounce_rate?.change_pct), true]);
    text.push(`  Visitors ${num(k.visitors?.value)} (${chg(k.visitors?.change_pct) ?? "–"}), pageviews ${num(k.pageviews?.value)} (${chg(k.pageviews?.change_pct) ?? "–"}), bounce ${num(k.bounce_rate?.value)}%`);
  }
  const lines: string[] = [];
  if (want("pages")) lines.push(`Top pages: ${s.top.pages.slice(0, 3).map((p) => `${p.page} (${num(p.pageviews)})`).join(", ") || "–"}`);
  if (want("sources")) lines.push(`Top channels: ${s.top.channels.slice(0, 3).map((p) => `${p.channel} (${num(p.visitors)})`).join(", ") || "–"}`);
  if (ai) lines.push(`AI assistants: ${num(ai.totals.sessions)} sessions, ${ai.share_of_sessions_pct}% of all`);
  if (want("goals")) for (const g of s.goals) lines.push(`Goal ${g.name}: ${num(g.conversions)} (${num(g.conversion_rate)}%)`);
  if (mv) lines.push(`Rising: ${mv.gainers.map((g) => `${g.value} +${g.change}`).join(", ") || "–"}; falling: ${mv.losers.map((g) => `${g.value} ${g.change}`).join(", ") || "–"}`);
  text.push(...lines.map((l) => `  ${l}`));
  return { block: { heading: site.name, rows, lines } satisfies MailBlock, text: text.join("\n"), numbers: { site: site.id, visitors: k.visitors?.value ?? null, pageviews: k.pageviews?.value ?? null } };
}

async function opsBlock(env: Env, now: number) {
  const st = await statusReport(env, now);
  const lines = [
    ...st.monitors.map((m) => `${m.status === "up" ? "✓" : m.status === "down" ? "✕" : "•"} ${m.name}: ${m.uptime_7d === null ? "–" : m.uptime_7d.toFixed(2) + "%"} 7-day uptime`),
    `Incidents (7 days): ${st.incidents.filter((i) => Date.parse(i.started_at) > now - 7 * 86_400_000).length}`,
    `Backups: last ${st.backups.last ?? "none"}${st.backups.ok === false ? " (FAILED)" : ""}; restore drill ${st.backups.drill ? `${st.backups.drill.at.slice(0, 10)} ${st.backups.drill.ok ? "ok" : "MISMATCH"}` : "not run"}`,
    ...st.databases.map((d) => `D1 ${d.name}: ${d.size_mb.toFixed(1)} MB${d.growth_mb_per_week !== null ? ` (${d.growth_mb_per_week >= 0 ? "+" : ""}${d.growth_mb_per_week.toFixed(2)} MB/week)` : ""}`),
  ];
  return { block: { heading: "Ops", lines } satisfies MailBlock, text: ["Ops", ...lines.map((l) => `  ${l}`)].join("\n") };
}

/** Build a report for the last complete period before `ref` (default now). Pure read: nothing is sent or recorded. */
export async function buildReport(env: Env, r: Report, now = Date.now(), ref = now) {
  const range = reportPeriod(r, ref);
  const all = await listSitesCached(env.DB);
  const sites = r.site_ids ? all.filter((s) => r.site_ids!.includes(s.id)) : all.filter((s) => !s.settings.hidden && s.settings.include_in_digest);
  const parts = [];
  for (const site of sites) parts.push(await siteBlocks(env, site, range, r.sections, now));
  const ops = r.include_ops ? await opsBlock(env, now) : null;
  const period = r.frequency === "monthly" ? "month" : "week";
  const subject = `Pulse ${r.name}: ${range.from} → ${range.to}`;
  const intro = `${range.from} → ${range.to} (${r.timezone}), compared with the previous ${period}.`;
  const text = [intro, "", ...parts.map((p) => p.text + "\n"), ...(ops ? [ops.text, ""] : []), env.PUBLIC_ORIGIN].join("\n");
  const html = emailHtml({ title: r.name, intro, blocks: [...parts.map((p) => p.block), ...(ops ? [ops.block] : [])], link: { url: env.PUBLIC_ORIGIN, label: "Open Pulse" }, footer: `Sent by Pulse. Change or stop this report in Settings → Reports.` });
  return { subject, text, html, range, numbers: parts.map((p) => p.numbers) };
}

/** Build and send a report now through its channels; records the outcome on the report. */
export async function sendReport(env: Env, r: Report, now = Date.now(), ref = now) {
  const built = await buildReport(env, r, now, ref);
  const delivered = await notify(env, { title: built.subject, text: built.text, html: built.html, url: env.PUBLIC_ORIGIN, severity: "info", category: "report", data: { report: r.id, range: built.range, numbers: built.numbers } }, r.channel_ids);
  await env.DB.prepare("UPDATE reports SET last_sent_at = ?, last_error = ? WHERE id = ?").bind(now, delivered ? null : "no channel accepted the report", r.id).run();
  return { delivered, ...built };
}

/**
 * Called by the 5-minute trigger: send every report that is due. Each period is claimed with a conditional UPDATE
 * before the report is built, so overlapping runs can't send it twice; a failed or undelivered send releases the
 * claim and is retried by the next run (until the same hour the next day).
 */
export async function runDueReports(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare("SELECT * FROM reports WHERE enabled = 1").all<ReportRow>();
  let sent = 0;
  for (const row of results) {
    const r = reportView(row);
    const ref = reportDueAt(r, row.last_period, now);
    if (ref === null) continue;
    const period = reportPeriod(r, ref).from;
    const claim = await env.DB.prepare("UPDATE reports SET last_period = ? WHERE id = ? AND (last_period IS NULL OR last_period <> ?)").bind(period, r.id, period).run();
    if (claim.meta.changes !== 1) continue;
    const release = () => env.DB.prepare("UPDATE reports SET last_period = ? WHERE id = ? AND last_period = ?").bind(row.last_period, r.id, period).run();
    try {
      const out = await sendReport(env, r, now, ref);
      if (out.delivered) sent++;
      else await release();
    } catch (err) {
      const msg = String((err as Error).message ?? err).slice(0, 160);
      console.error(JSON.stringify({ msg: "report_failed", report: r.id, error: msg }));
      await env.DB.prepare("UPDATE reports SET last_error = ? WHERE id = ?").bind(msg, r.id).run();
      await release();
    }
  }
  return sent;
}

/** What a principal may see of a report: site-scoped principals never get the instance-wide ops section. */
export function reportFor(r: Report, siteIds: string[] | null): Report | null {
  if (siteIds === null) return r;
  if (!r.site_ids || !r.site_ids.every((s) => siteIds.includes(s))) return null;
  return { ...r, include_ops: false };
}

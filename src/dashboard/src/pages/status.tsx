import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Pause, Play, Plus, RefreshCw } from "../components/icons.tsx";
import { useEffect, useState } from "react";
import { ChannelPicker } from "../components/ChannelPicker.tsx";
import { useSites } from "../components/Shell.tsx";
import { TimeChart } from "../components/TimeChart.tsx";
import {
  ago,
  Confirm,
  CopyField,
  Empty,
  ErrorBox,
  Field,
  Section,
  Sheet,
  Skeleton,
  StatusGlyph,
  Switch,
  useToast,
  type Health,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { locale, t } from "../lib/i18n.ts";
import { TimezoneSelect } from "./sites.tsx";

interface Day {
  day: string;
  checks: number;
  up: number;
}
interface Monitor {
  id: string;
  name: string;
  kind: string;
  site_id: string | null;
  url: string;
  status: Health;
  incident_since: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  uptime_30d: number | null;
  uptime_90d: number | null;
  p50_ms: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  interval_min: number;
  paused_until: string | null;
  days: Day[];
  config?: { quiet_hours?: QuietHours | null };
}
interface QuietHours {
  from: string;
  to: string;
  tz: string;
}
interface Incident {
  id: string;
  monitor_id: string;
  monitor_name: string;
  site_id: string | null;
  started_at: string;
  resolved_at: string | null;
  error: string | null;
  note: string | null;
  acknowledged_at: string | null;
}
interface StatusRes {
  summary: string;
  monitors: Monitor[];
  incidents: Incident[];
  databases: { name: string; size_mb: number; growth_mb_per_week: number | null }[];
  backups: {
    last: string | null;
    ok: boolean | null;
    errors?: string[];
    missing?: string[];
    drill: { at: string; ok: boolean; problems?: string[]; skipped?: string[]; overdue?: boolean } | null;
  } | null;
}
interface CheckConfig {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  target: string;
  site_id: string | null;
  interval_min: number;
  timeout_ms: number;
  failures_to_alert: number;
  degraded_ms: number | null;
  notify: boolean;
  channel_ids: string[] | null;
  paused_until: string | null;
  last_ping_at: string | null;
  config: Record<string, unknown>;
}

/** What a check watches, in the interface's language (the API describes non-URL targets in English). */
function targetLabel(target: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^heartbeat every (\S+) min$/.exec(target))) return t("heartbeat every {n} min", { n: m[1]! });
  if (target === "Pulse ingest") return t("Pulse ingest");
  if ((m = /^Pulse ingest for (.+)$/.exec(target))) return t("Pulse ingest for {site}", { site: m[1]! });
  if ((m = /^(.+) database$/.exec(target))) return t("{name} database", { name: m[1]! });
  return target;
}

/** The board's one-line summary, from the checks themselves. */
function summaryText(monitors: { status: string }[]): string {
  const active = monitors.filter((m) => m.status !== "paused");
  const down = active.filter((m) => m.status === "down").length;
  const unknown = active.filter((m) => m.status === "unknown").length;
  if (!monitors.length) return t("No checks yet.");
  if (down) return t("{n} of {total} checks down.", { n: down, total: active.length });
  // A new check has no result until its first run (within 5 minutes): don't call it up yet.
  if (active.length && unknown === active.length) return t("Waiting for the first check run (every 5 minutes).");
  if (unknown > 0)
    return t("{up} of {total} checks up ({pending} waiting).", {
      up: active.length - unknown,
      total: active.length,
      pending: unknown,
    });
  return active.length === 1 ? t("The check is up.") : t("All {n} checks up.", { n: active.length });
}

const pct = (v: number | null) =>
  v === null
    ? "–"
    : `${v >= 99.995 ? "100" : v.toLocaleString(locale, { minimumFractionDigits: v >= 99.95 ? 2 : 1, maximumFractionDigits: v >= 99.95 ? 2 : 1 })}%`;

const KINDS: [string, string][] = [
  ["http", t("Web page or URL")],
  ["json", t("JSON API")],
  ["heartbeat", t("Heartbeat (a job pings Pulse)")],
  ["d1_query", t("Database query (D1)")],
  ["dns", t("DNS record")],
  ["domain_expiry", t("Domain renewal")],
  ["pulse_ingest", t("Pulse data arriving")],
];
const KIND_HELP: Record<string, string> = {
  http: t("Up when the URL answers with the expected status and the keyword rules hold."),
  json: t("Up when a value in the JSON exists, isn't empty, equals something or is recent."),
  json_nonempty: t("Up when the JSON contains a non-empty list (older kind; prefer JSON API)."),
  heartbeat: t("Your cron job or scraper calls a secret URL after each run. Down when the calls stop."),
  d1_query: t(
    "Runs a read-only SELECT on one of your D1 databases. Up when the ok column is true. :today is today's date in the chosen time zone.",
  ),
  dns: t("Up when the record resolves (and contains the expected value)."),
  domain_expiry: t("Down when the domain's registration expires within the warning window. Checked daily."),
  pulse_ingest: t("Up while live events keep arriving, overall or for one site."),
};
const INTERVALS = [5, 10, 15, 30, 60, 360, 1440];
const every = (m: number) =>
  m < 60 ? t("{n} min", { n: m }) : m === 60 ? t("hour") : m === 1440 ? t("day") : t("{n} h", { n: m / 60 });

function dayTone(r: number | null): { color: string; label: string } {
  if (r === null) return { color: "var(--line-2)", label: t("no data") };
  if (r >= 0.999) return { color: "var(--good)", label: t("all up") };
  if (r >= 0.5) return { color: "var(--warn)", label: t("some failures") };
  return { color: "var(--bad)", label: t("mostly down") };
}

/** 90 daily bars coloured by state; hover a bar for the day and its uptime. */
function DayCells({ days }: { days: Day[] }) {
  const [hot, setHot] = useState<number | null>(null);
  const d = hot !== null ? days[hot] : null;
  const r = d && d.checks ? d.up / d.checks : null;
  return (
    <div className="relative" onMouseLeave={() => setHot(null)}>
      <div
        className="flex h-7 min-w-0 items-stretch gap-px sm:gap-[2px]"
        role="img"
        aria-label={t("Last 90 days")}
      >
        {days.map((x, i) => {
          const rr = x.checks ? x.up / x.checks : null;
          const tone = dayTone(rr);
          return (
            <span
              key={x.day}
              onMouseEnter={() => setHot(i)}
              className="min-w-px flex-1 rounded-[2px] transition-opacity sm:rounded-[3px]"
              style={{
                background: tone.color,
                opacity: hot !== null && hot !== i ? 0.55 : rr === null ? 1 : rr >= 0.999 ? 0.55 : 1,
              }}
            />
          );
        })}
      </div>
      {d && hot !== null && (
        <div
          className="floating pointer-events-none absolute -top-10 z-10 -translate-x-1/2 whitespace-nowrap px-2.5 py-1 text-xs"
          style={{ left: `clamp(60px, ${((hot + 0.5) / days.length) * 100}%, calc(100% - 60px))` }}
        >
          <span className="font-medium">{d.day}</span>{" "}
          <span className="text-ink-2">
            {r === null
              ? t("no data")
              : t("{pct}% up, {state}", { pct: (r * 100).toLocaleString(locale, { maximumFractionDigits: r < 1 ? 1 : 0 }), state: dayTone(r).label })}
          </span>
        </div>
      )}
    </div>
  );
}

function CheckForm({
  initial,
  onDone,
}: {
  initial: Partial<CheckConfig> | null;
  onDone: (heartbeatUrl?: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const sites = useSites();
  const editing = !!initial?.id;
  const [v, setV] = useState({
    name: initial?.name ?? "",
    kind: initial?.kind ?? "http",
    url: initial?.url ?? "https://",
    site_id: initial?.site_id ?? null,
    interval_min: initial?.interval_min ?? 5,
    failures_to_alert: initial?.failures_to_alert ?? 2,
    degraded_ms: initial?.degraded_ms ?? null,
    notify: initial?.notify ?? true,
    channel_ids: initial?.channel_ids ?? null,
    timeout_ms: initial?.timeout_ms ?? 10000,
  });
  const [cfg, setCfg] = useState<Record<string, unknown>>(initial?.config ?? {});
  const browserTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const iq = initial?.config?.quiet_hours as QuietHours | null | undefined;
  const [quiet, setQuiet] = useState({ from: iq?.from ?? "", to: iq?.to ?? "", tz: iq?.tz ?? browserTz });
  const quietOn = !!(quiet.from || quiet.to);
  const c = (k: string) => (cfg[k] === undefined || cfg[k] === null ? "" : String(cfg[k]));
  const setC = (k: string, val: unknown) => setCfg((x) => ({ ...x, [k]: val === "" ? undefined : val }));
  const body = () => {
    const config = Object.fromEntries(Object.entries(cfg).filter(([, x]) => x !== undefined && x !== ""));
    const quiet_hours =
      quiet.from && quiet.to
        ? { from: quiet.from, to: quiet.to, tz: quiet.tz || browserTz }
        : editing
          ? null
          : undefined;
    return {
      ...v,
      quiet_hours,
      url: v.kind === "http" || v.kind === "json" || v.kind === "json_nonempty" ? v.url : undefined,
      config,
    };
  };
  const test = useMutation({
    mutationFn: () =>
      api.post<{ data: { ok: boolean; status: number | null; ms: number | null; error: string | null } }>(
        "/api/v1/ops/monitors/test",
        body(),
      ),
  });
  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.patch<{ data: { heartbeat_url?: string } }>(`/api/v1/ops/monitors/${initial!.id}`, body())
        : api.post<{ data: { heartbeat_url?: string } }>("/api/v1/ops/monitors", body()),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["status"] });
      void qc.invalidateQueries({ queryKey: ["checks"] });
      toast(editing ? t("Check saved") : t("Check added"));
      onDone(r.data.heartbeat_url);
    },
  });
  const http = v.kind === "http" || v.kind === "json" || v.kind === "json_nonempty";
  return (
    <form
      id="check-form"
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("Name")}>
          <input
            className="input"
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
            required
            placeholder={t("Home page")}
            autoFocus
          />
        </Field>
        <Field label={t("Site")} hint={t("Groups the check on this page")}>
          <select
            className="input"
            value={v.site_id ?? ""}
            onChange={(e) => setV({ ...v, site_id: e.target.value || null })}
          >
            <option value="">{t("No site (system)")}</option>
            {(sites.data?.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t("What to check")} hint={KIND_HELP[v.kind]}>
        <select
          className="input"
          value={v.kind}
          onChange={(e) => {
            setV({
              ...v,
              kind: e.target.value,
              interval_min: e.target.value === "domain_expiry" ? 1440 : v.interval_min,
            });
            setCfg({});
          }}
        >
          {KINDS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
          {v.kind === "json_nonempty" && <option value="json_nonempty">{t("JSON not empty (older)")}</option>}
        </select>
      </Field>

      {http && (
        <>
          <Field label={t("URL")}>
            <input
              className="input"
              value={v.url}
              onChange={(e) => setV({ ...v, url: e.target.value })}
              required
              placeholder="https://example.com/"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("Expected status")} hint={t("e.g. 200, 200-299 or 200,301")}>
              <input
                className="input"
                value={c("expect_status")}
                placeholder="200"
                onChange={(e) => setC("expect_status", e.target.value)}
              />
            </Field>
            <Field label={t("Must contain")}>
              <input
                className="input"
                value={c("keyword")}
                onChange={(e) => setC("keyword", e.target.value)}
              />
            </Field>
            <Field label={t("Must not contain")}>
              <input
                className="input"
                value={c("keyword_absent")}
                onChange={(e) => setC("keyword_absent", e.target.value)}
              />
            </Field>
          </div>
          <Switch
            checked={!!cfg.follow_redirects}
            onChange={(x) => setC("follow_redirects", x)}
            label={t("Follow redirects")}
            hint={t("Off: a redirect counts as its own status (e.g. 301)")}
          />
        </>
      )}
      {v.kind === "json" && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("Path")} hint={t("e.g. data.items or results[0].date")}>
            <input className="input" value={c("path")} onChange={(e) => setC("path", e.target.value)} />
          </Field>
          <Field label={t("Up when")}>
            <select
              className="input"
              value={c("expect") || "non_empty"}
              onChange={(e) => setC("expect", e.target.value)}
            >
              <option value="non_empty">{t("it isn't empty")}</option>
              <option value="exists">{t("it exists")}</option>
              <option value="equals">{t("it equals…")}</option>
              <option value="max_age_minutes">{t("it's a recent date")}</option>
            </select>
          </Field>
          {c("expect") === "equals" && (
            <Field label={t("Value")}>
              <input className="input" value={c("value")} onChange={(e) => setC("value", e.target.value)} />
            </Field>
          )}
          {c("expect") === "max_age_minutes" && (
            <Field label={t("No older than (minutes)")}>
              <input
                className="input"
                type="number"
                min={1}
                value={c("max_age_minutes")}
                onChange={(e) => setC("max_age_minutes", e.target.value ? Number(e.target.value) : undefined)}
              />
            </Field>
          )}
        </div>
      )}
      {v.kind === "heartbeat" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Expect a ping every (minutes)")}>
            <input
              className="input"
              type="number"
              min={1}
              value={c("period_min")}
              onChange={(e) => setC("period_min", e.target.value ? Number(e.target.value) : undefined)}
              required
            />
          </Field>
          <Field label={t("Grace (minutes)")} hint={t("Extra time before it counts as missed")}>
            <input
              className="input"
              type="number"
              min={0}
              value={c("grace_min")}
              placeholder="5"
              onChange={(e) => setC("grace_min", e.target.value ? Number(e.target.value) : undefined)}
            />
          </Field>
          {editing && (
            <p className="text-xs text-ink-3 sm:col-span-2">
              {t(
                "The ping URL was shown when the check was added. To get a new one, use “New ping URL” in the check's details.",
              )}
            </p>
          )}
        </div>
      )}
      {v.kind === "d1_query" && (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Database")}>
              <input
                className="input"
                value={c("database")}
                onChange={(e) => setC("database", e.target.value)}
                required
              />
            </Field>
            <Field label={t("Time zone for :today")}>
              <input
                className="input"
                value={c("timezone")}
                placeholder="UTC"
                onChange={(e) => setC("timezone", e.target.value)}
              />
            </Field>
          </div>
          <Field
            label={t("Query")}
            hint={t("One read-only SELECT returning a column named ok (and optionally detail).")}
          >
            <textarea
              className="input font-mono text-[13px]"
              rows={3}
              value={c("sql")}
              onChange={(e) => setC("sql", e.target.value)}
              placeholder="SELECT COUNT(*) > 0 AS ok FROM runs WHERE day = :today"
              required
            />
          </Field>
        </div>
      )}
      {v.kind === "dns" && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("Name")}>
            <input
              className="input"
              value={c("name")}
              onChange={(e) => setC("name", e.target.value)}
              required
              placeholder="example.com"
            />
          </Field>
          <Field label={t("Record")}>
            <select className="input" value={c("type") || "A"} onChange={(e) => setC("type", e.target.value)}>
              {["A", "AAAA", "CNAME", "MX", "TXT", "NS"].map((rt) => (
                <option key={rt}>{rt}</option>
              ))}
            </select>
          </Field>
          <Field label={t("Should contain")}>
            <input
              className="input"
              value={c("expect_contains")}
              onChange={(e) => setC("expect_contains", e.target.value)}
            />
          </Field>
        </div>
      )}
      {v.kind === "domain_expiry" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Domain")}>
            <input
              className="input"
              value={c("domain")}
              onChange={(e) => setC("domain", e.target.value)}
              required
              placeholder="example.com"
            />
          </Field>
          <Field label={t("Warn this many days before")}>
            <input
              className="input"
              type="number"
              min={1}
              value={c("warn_days")}
              placeholder="21"
              onChange={(e) => setC("warn_days", e.target.value ? Number(e.target.value) : undefined)}
            />
          </Field>
        </div>
      )}
      {v.kind === "pulse_ingest" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Down after no events for (minutes)")}>
            <input
              className="input"
              type="number"
              min={5}
              value={c("max_lag_min")}
              placeholder="120"
              onChange={(e) => setC("max_lag_min", e.target.value ? Number(e.target.value) : undefined)}
            />
          </Field>
          <Field label={t("Only this site")}>
            <select className="input" value={c("site_id")} onChange={(e) => setC("site_id", e.target.value)}>
              <option value="">{t("Any site")}</option>
              {(sites.data?.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      <div className="grid gap-4 border-t border-line pt-5 sm:grid-cols-3">
        <Field label={t("Check every")}>
          <select
            className="input"
            value={v.interval_min}
            onChange={(e) => setV({ ...v, interval_min: Number(e.target.value) })}
          >
            {INTERVALS.map((m) => (
              <option key={m} value={m}>
                {every(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Alert after")} hint={t("consecutive failures")}>
          <select
            className="input"
            value={v.failures_to_alert}
            onChange={(e) => setV({ ...v, failures_to_alert: Number(e.target.value) })}
          >
            {[1, 2, 3, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        {http && (
          <Field label={t("Slow above (ms)")} hint={t("Marked slow, no alert")}>
            <input
              className="input"
              type="number"
              min={50}
              value={v.degraded_ms ?? ""}
              onChange={(e) => setV({ ...v, degraded_ms: e.target.value ? Number(e.target.value) : null })}
            />
          </Field>
        )}
      </div>
      <Switch
        checked={v.notify}
        onChange={(notify) => setV({ ...v, notify })}
        label={t("Tell me when it goes down and when it recovers")}
      />
      {v.notify && (
        <ChannelPicker value={v.channel_ids} onChange={(channel_ids) => setV({ ...v, channel_ids })} />
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("Quiet hours from")}>
            <input
              className="input"
              type="time"
              value={quiet.from}
              required={quietOn}
              onChange={(e) => setQuiet({ ...quiet, from: e.target.value })}
            />
          </Field>
          <Field label={t("Quiet hours to")}>
            <input
              className="input"
              type="time"
              value={quiet.to}
              required={quietOn}
              onChange={(e) => setQuiet({ ...quiet, to: e.target.value })}
            />
          </Field>
          <Field label={t("Time zone")}>
            <TimezoneSelect value={quiet.tz} onChange={(tz) => setQuiet({ ...quiet, tz })} />
          </Field>
        </div>
        <p className="text-xs text-ink-3">
          {t(
            "Optional. Failures inside the window are recorded but open no incident and send no alert. Clear both times to turn it off.",
          )}
        </p>
      </div>

      {test.data && (
        <p className={`border-l-2 px-3 py-2 text-sm ${test.data.data.ok ? "border-live" : "border-down"}`}>
          {test.data.data.ok ? t("● Up") : t("✕ Down")}
          {[
            test.data.data.status ? `HTTP ${test.data.data.status}` : "",
            test.data.data.ms !== null ? t("in {ms} ms", { ms: test.data.data.ms }) : "",
            test.data.data.error ?? "",
          ]
            .filter(Boolean)
            .map((x) => `, ${x}`)
            .join("")}
        </p>
      )}
      {(test.error || save.error) && <ErrorBox error={test.error ?? save.error} />}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={() => test.mutate()} disabled={test.isPending}>
          <RefreshCw size={14} className={test.isPending ? "animate-spin" : ""} aria-hidden="true" />{" "}
          {t("Test")}
        </button>
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>
          {editing ? t("Save changes") : t("Add check")}
        </button>
      </div>
    </form>
  );
}

function CheckDetail({
  m,
  onEdit,
  onClose,
}: {
  m: Monitor;
  onEdit: (c: CheckConfig) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [hours, setHours] = useState(24);
  const cfg = useQuery({
    queryKey: ["checks", m.id],
    queryFn: () => api.get<{ data: CheckConfig }>(`/api/v1/ops/monitors/${m.id}`),
  });
  const hist = useQuery({
    queryKey: ["checks", m.id, "hist", hours],
    queryFn: () =>
      api.get<{
        data: { ts: string; ok: boolean; status: number | null; ms: number | null; error: string | null }[];
      }>(`/api/v1/ops/monitors/${m.id}/checks?hours=${hours}`),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["status"] });
    void qc.invalidateQueries({ queryKey: ["checks", m.id] });
  };
  const run = useMutation({
    mutationFn: () =>
      api.post<{ data: { ok: boolean; error: string | null; ms: number | null } }>(
        `/api/v1/ops/monitors/${m.id}/check?record=true`,
      ),
    onSuccess: (r) => (
      toast(
        r.data.ok ? t("Checked: up") : t("Checked: down ({error})", { error: String(r.data.error) }),
        r.data.ok ? "ok" : "error",
      ),
      invalidate()
    ),
  });
  const pause = useMutation({
    mutationFn: (minutes: number | null) =>
      api.post(`/api/v1/ops/monitors/${m.id}/pause`, minutes ? { minutes } : {}),
    onSuccess: () => (toast(m.paused_until ? t("Check resumed") : t("Check paused")), invalidate()),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/v1/ops/monitors/${m.id}`),
    onSuccess: () => (toast(t("Check deleted")), invalidate(), onClose()),
  });
  const token = useMutation({
    mutationFn: () =>
      api.post<{ data: { heartbeat_url: string } }>(`/api/v1/ops/monitors/${m.id}/heartbeat-token`),
  });
  const [confirmDel, setConfirmDel] = useState(false);
  const rows = (hist.data?.data ?? []).slice().reverse();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusGlyph status={m.status} withLabel />
        <span className="text-sm text-ink-2">
          {t("checked {when}, every {interval}", {
            when: ago(m.last_checked_at),
            interval: every(m.interval_min),
          })}
        </span>
        {m.last_error && <span className="w-full text-sm text-down">{m.last_error}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn" onClick={() => run.mutate()} disabled={run.isPending}>
          <RefreshCw size={14} className={run.isPending ? "animate-spin" : ""} aria-hidden="true" />{" "}
          {t("Check now")}
        </button>
        {m.paused_until ? (
          <button className="btn" onClick={() => pause.mutate(null)}>
            <Play size={14} aria-hidden="true" /> {t("Resume")}
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => pause.mutate(60)}>
              <Pause size={14} aria-hidden="true" /> {t("Pause 1 hour")}
            </button>
            <button className="btn btn-quiet" onClick={() => pause.mutate(60 * 24 * 365)}>
              {t("Pause until resumed")}
            </button>
          </>
        )}
        {cfg.data && (
          <button className="btn" onClick={() => onEdit(cfg.data!.data)}>
            {t("Edit")}
          </button>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {[
          [t("24 hours"), pct(m.uptime_24h)],
          [t("7 days"), pct(m.uptime_7d)],
          [t("30 days"), pct(m.uptime_30d)],
          [t("90 days"), pct(m.uptime_90d)],
        ].map(([k, val]) => (
          <div key={k}>
            <dt className="text-xs text-ink-3">{k}</dt>
            <dd className="t-num text-[22px] font-medium">{val}</dd>
          </div>
        ))}
      </dl>
      {m.kind !== "heartbeat" && m.kind !== "pulse_ingest" && (
        <Section
          title={t("Response time")}
          actions={
            <select
              className="input w-auto"
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              aria-label={t("Period")}
            >
              <option value={24}>{t("24 hours")}</option>
              <option value={168}>{t("7 days")}</option>
            </select>
          }
        >
          <div className="paper-grid sheet px-1 pt-2">
            {hist.isLoading ? (
              <Skeleton h={160} />
            ) : (
              <TimeChart
                rows={rows.map((r) => ({
                  minute_ago: Math.round((Date.parse(r.ts) - Date.now()) / 60000),
                  ms: r.ms ?? 0,
                }))}
                xKey="minute_ago"
                metric="ms"
                label={t("Response time (ms)")}
                height={160}
              />
            )}
          </div>
        </Section>
      )}
      {m.kind === "heartbeat" && (
        <Section title={t("Ping URL")}>
          <p className="mb-2 text-sm text-ink-2">
            {t("Last ping {when}. Call the URL at the end of each successful run, e.g.", {
              when: ago(cfg.data?.data.last_ping_at),
            })}{" "}
            <code>curl -fsS &lt;url&gt;</code>.
          </p>
          {token.data ? (
            <CopyField value={token.data.data.heartbeat_url} />
          ) : (
            <button className="btn" onClick={() => token.mutate()}>
              {t("New ping URL")}
            </button>
          )}
          {token.data && (
            <p className="mt-2 text-xs text-ink-3">
              {t("The previous URL no longer works. This one is shown once.")}
            </p>
          )}
        </Section>
      )}
      <Section title={t("Recent results")}>
        <ul className="flex max-h-64 flex-col overflow-y-auto text-sm">
          {(hist.data?.data ?? []).slice(0, 50).map((r) => (
            <li key={r.ts} className="flex items-center gap-3 border-b border-line py-1.5 last:border-0">
              <StatusGlyph status={r.ok ? "up" : "down"} />
              <span className="w-36 shrink-0 text-ink-2">
                {new Date(r.ts).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
              </span>
              <span className="t-num">{r.ms !== null ? `${r.ms} ms` : ""}</span>
              <span className="truncate text-ink-2">{r.error ?? (r.status ? `HTTP ${r.status}` : "")}</span>
            </li>
          ))}
        </ul>
      </Section>
      <div className="border-t border-line pt-4">
        <button className="btn btn-danger" onClick={() => setConfirmDel(true)}>
          {t("Delete check")}
        </button>
      </div>
      <Confirm
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={t("Delete {name}?", { name: m.name })}
        body={t("Its history and incidents are deleted too.")}
        confirm={t("Delete check")}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}

function Incidents({ incidents }: { incidents: Incident[] }) {
  const qc = useQueryClient();
  const [noteFor, setNoteFor] = useState<Incident | null>(null);
  const [note, setNote] = useState("");
  const patch = useMutation({
    mutationFn: (b: { id: string; note?: string | null; acknowledged?: boolean; resolved?: true }) =>
      api.patch(`/api/v1/ops/incidents/${b.id}`, { ...b, id: undefined }),
    onSuccess: () => {
      setNoteFor(null);
      void qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
  if (!incidents.length) return <Empty>{t("No incidents in the last 90 days.")}</Empty>;
  return (
    <>
      <ol className="relative ml-2 flex flex-col border-l border-line pl-5">
        {incidents.map((i) => {
          const open = !i.resolved_at;
          const mins = Math.round(
            ((i.resolved_at ? Date.parse(i.resolved_at) : Date.now()) - Date.parse(i.started_at)) / 60000,
          );
          return (
            <li key={i.id} className="relative flex flex-wrap items-start justify-between gap-3 py-3">
              <span
                aria-hidden="true"
                className={`absolute -left-[26px] top-[18px] h-2.5 w-2.5 rounded-full border-2 border-surface ${open ? "bg-bad" : "bg-ghost"}`}
              />
              <div className="min-w-0">
                <div className="text-xs text-ink-3">
                  {new Date(i.started_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                </div>
                <div className="flex flex-wrap items-center gap-x-2">
                  <StatusGlyph status={open ? "down" : "up"} />
                  <span className="font-medium">{i.monitor_name}</span>
                  <span className="text-[13px] text-ink-2">
                    {open
                      ? t("down for {time}", {
                          time:
                            mins < 60 ? t("{n} min", { n: mins }) : t("{n} h", { n: Math.round(mins / 60) }),
                        })
                      : t("was down for {time}", {
                          time:
                            mins < 60 ? t("{n} min", { n: mins }) : t("{n} h", { n: Math.round(mins / 60) }),
                        })}
                  </span>
                  {open && <span className="chip">{i.acknowledged_at ? t("acknowledged") : t("open")}</span>}
                </div>
                {i.error && <div className="mt-0.5 text-[13px] text-ink-2">{i.error}</div>}
                {i.note && <div className="mt-1 text-[13px]">{t("Note: {note}", { note: i.note })}</div>}
              </div>
              <div className="flex gap-1">
                {open && !i.acknowledged_at && (
                  <button
                    className="btn btn-sm"
                    onClick={() => patch.mutate({ id: i.id, acknowledged: true })}
                  >
                    {t("Acknowledge")}
                  </button>
                )}
                <button
                  className="btn btn-sm btn-quiet"
                  onClick={() => {
                    setNoteFor(i);
                    setNote(i.note ?? "");
                  }}
                >
                  {i.note ? t("Edit note") : t("Add note")}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <Sheet
        open={!!noteFor}
        onOpenChange={(v) => !v && setNoteFor(null)}
        title={t("Note on {name}", { name: noteFor?.monitor_name ?? "" })}
        footer={
          <button
            className="btn btn-primary"
            onClick={() => noteFor && patch.mutate({ id: noteFor.id, note: note || null })}
          >
            {t("Save note")}
          </button>
        }
      >
        <Field label={t("What happened")} hint={t("Visible to everyone with access and to agents")}>
          <textarea
            className="input"
            rows={5}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
        </Field>
      </Sheet>
    </>
  );
}

export function StatusPage() {
  const search = useSearch({ strict: false }) as { new?: string; site?: string };
  const navigate = useNavigate();
  const sites = useSites();
  const q = useQuery({
    queryKey: ["status"],
    queryFn: () => api.get<StatusRes>("/api/v1/ops/status"),
    refetchInterval: 300_000,
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ data: { email: string; role: string } }>("/auth/me"),
    retry: false,
    staleTime: 300_000,
  });
  const canWrite = me.data ? me.data.data.role !== "viewer" : true;
  const [form, setForm] = useState<Partial<CheckConfig> | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [pingUrl, setPingUrl] = useState<string | null>(null);
  useEffect(() => {
    if (search.new === "1" && canWrite) {
      setForm({ site_id: search.site ?? null });
      void navigate({ to: ".", search: {}, replace: true } as never);
    }
  }, [search.new, search.site, canWrite, navigate]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton h={400} />;
  const siteName = (id: string | null) =>
    id ? (sites.data?.data.find((s) => s.id === id)?.name ?? id) : t("Pulse and system");
  const groups = [...new Set(q.data.monitors.map((m) => m.site_id))].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : siteName(a).localeCompare(siteName(b)),
  );
  const current = q.data.monitors.find((m) => m.id === detail) ?? null;
  const down = q.data.monitors.filter((m) => m.status === "down");
  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="t-title">{t("Status")}</h1>
          <p className={`text-sm ${down.length ? "font-medium text-down" : "text-ink-2"}`}>
            {summaryText(q.data.monitors)}
          </p>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setForm({})}>
            <Plus size={15} aria-hidden="true" /> {t("Add check")}
          </button>
        )}
      </header>

      {!q.data.monitors.length ? (
        <Empty
          action={
            canWrite ? (
              <button className="btn btn-primary" onClick={() => setForm({})}>
                {t("Add your first check")}
              </button>
            ) : undefined
          }
        >
          {t("No status checks yet. Add one for each site's home page and for anything it depends on.")}
        </Empty>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((g) => {
            const color = g ? sites.data?.data.find((x) => x.id === g)?.color : undefined;
            return (
              <section key={g ?? "system"} data-site={color} aria-label={siteName(g)}>
                <h2 className="t-heading mb-2 flex items-center gap-2 px-1">
                  <span className="swatch" aria-hidden="true" />
                  {siteName(g)}
                </h2>
                <ul className="flex flex-col gap-3">
                  {q
                    .data!.monitors.filter((m) => m.site_id === g)
                    .map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => setDetail(m.id)}
                          className="panel row-hover flex w-full flex-col gap-3 px-4 py-3.5 text-left"
                        >
                          <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{m.name}</span>
                              <span className="block truncate text-[13px] text-ink-2">
                                {m.status === "paused"
                                  ? t("paused until {when}", {
                                      when: m.paused_until
                                        ? new Date(m.paused_until).toLocaleString(locale)
                                        : t("resumed"),
                                    })
                                  : m.status === "down" && m.last_error
                                    ? m.last_error
                                    : targetLabel(m.url)}
                              </span>
                            </span>
                            <span className="flex items-center gap-4">
                              {m.p50_ms !== null && (
                                <span
                                  className="t-num text-[15px] text-ink-2"
                                  title={t("Median response time")}
                                >
                                  {m.p50_ms} ms
                                </span>
                              )}
                              <StatusGlyph status={m.status} withLabel />
                            </span>
                          </span>
                          <span className="block">
                            <DayCells days={m.days} />
                          </span>
                          <span className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px] text-ink-2">
                            {[
                              [t("24 h"), m.uptime_24h],
                              [t("30 d"), m.uptime_30d],
                              [t("90 d"), m.uptime_90d],
                            ].map(([k, v]) => (
                              <span key={k as string}>
                                {k}{" "}
                                <span className="t-num text-[15px] text-ink">{pct(v as number | null)}</span>
                              </span>
                            ))}
                            {m.config?.quiet_hours && (
                              <span className="chip" title={m.config.quiet_hours.tz}>
                                {t("Quiet {from}–{to}", {
                                  from: m.config.quiet_hours.from,
                                  to: m.config.quiet_hours.to,
                                })}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section title={t("Incidents")}>
          <Incidents incidents={q.data.incidents} />
        </Section>
        {q.data.backups && (
          <Section title={t("Backups and databases")}>
            <dl className="flex flex-col px-2 text-sm">
              <div className="flex justify-between gap-4 border-b border-line py-2">
                <dt className="text-ink-2">{t("Last backup")}</dt>
                <dd className={q.data.backups.ok === false ? "text-down" : ""}>
                  {q.data.backups.last
                    ? `${ago(q.data.backups.last)}${q.data.backups.ok === false ? `, ${t("failed")}` : ""}`
                    : t("none yet")}
                </dd>
              </div>
              {!!q.data.backups.errors?.length && (
                <div className="border-b border-line py-2 text-down">
                  {q.data.backups.errors.map((e) => (
                    <p key={e} className="text-xs break-words">
                      {e}
                    </p>
                  ))}
                </div>
              )}
              {!!q.data.backups.missing?.length && (
                <div className="border-b border-line py-2">
                  <p className="text-xs text-warn">
                    {t("No longer in your Cloudflare account, so not backed up:")}{" "}
                    <span className="font-medium">{q.data.backups.missing.join(", ")}</span>.{" "}
                    <a href="/settings/ops" className="link">
                      {t("Remove them")}
                    </a>
                  </p>
                </div>
              )}
              <div className="flex justify-between gap-4 border-b border-line py-2">
                <dt className="text-ink-2">{t("Restore drill")}</dt>
                <dd
                  className={
                    q.data.backups.drill?.ok === false
                      ? "text-down"
                      : q.data.backups.drill?.overdue
                        ? "text-warn"
                        : ""
                  }
                >
                  {q.data.backups.drill
                    ? `${new Date(q.data.backups.drill.at).toLocaleDateString(locale)}, ${q.data.backups.drill.ok ? t("counts matched") : t("failed")}${q.data.backups.drill.overdue ? `, ${t("overdue")}` : ""}`
                    : t("not run yet")}
                </dd>
              </div>
              {!!q.data.backups.drill?.skipped?.length && (
                <div className="border-b border-line py-2 text-ink-3">
                  {q.data.backups.drill.skipped.map((e) => (
                    <p key={e} className="text-xs break-words">
                      {t("Not drilled:")} {e}
                    </p>
                  ))}
                </div>
              )}
              {!!q.data.backups.drill?.problems?.length && (
                <div className="border-b border-line py-2 text-down">
                  {q.data.backups.drill.problems.map((e) => (
                    <p key={e} className="text-xs break-words">
                      {e}
                    </p>
                  ))}
                </div>
              )}
              {q.data.databases.map((d) => (
                <div
                  key={d.name}
                  className="flex justify-between gap-4 border-b border-line py-2 last:border-0"
                >
                  <dt className="truncate text-ink-2">{d.name}</dt>
                  <dd className="t-num shrink-0">
                    {d.size_mb.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB
                    {d.growth_mb_per_week !== null && (
                      <span className="text-ink-3">
                        {" "}
                        {d.growth_mb_per_week >= 0 ? "+" : ""}
                        {d.growth_mb_per_week.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}
                        {t("/wk")}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <a href="/settings/ops" className="link mx-2 mt-3 inline-block text-sm">
              {t("Choose what's backed up")}
            </a>
          </Section>
        )}
      </div>

      <Sheet
        open={!!current}
        onOpenChange={(v) => !v && setDetail(null)}
        title={current?.name ?? ""}
        description={current?.url}
        wide
      >
        {current && (
          <CheckDetail
            m={current}
            onClose={() => setDetail(null)}
            onEdit={(c) => {
              setDetail(null);
              setForm(c);
            }}
          />
        )}
      </Sheet>
      <Sheet
        open={!!form}
        onOpenChange={(v) => !v && setForm(null)}
        title={form?.id ? t("Edit {name}", { name: String(form.name) }) : t("Add a status check")}
        description={
          form?.id ? undefined : t("Pulse runs it every few minutes and emails you when it fails.")
        }
        wide
      >
        {form && (
          <CheckForm
            key={form.id ?? "new"}
            initial={form}
            onDone={(url) => {
              setForm(null);
              if (url) setPingUrl(url);
            }}
          />
        )}
      </Sheet>
      <Sheet open={!!pingUrl} onOpenChange={(v) => !v && setPingUrl(null)} title={t("Your heartbeat URL")}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-2">
            {t("Call this URL at the end of each successful run of your job. It's shown once.")}
          </p>
          {pingUrl && <CopyField value={pingUrl} />}
          {pingUrl && <CopyField value={`curl -fsS ${pingUrl}`} />}
        </div>
      </Sheet>
    </div>
  );
}

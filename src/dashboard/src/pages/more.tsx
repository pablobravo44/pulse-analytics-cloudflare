import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Bug, Check, Plus, WarningCircle, X } from "../components/icons.tsx";
import { useState } from "react";
import { DenseTable } from "../components/DenseTable.tsx";
import { MiniChart } from "../components/MiniChart.tsx";
import { Sankey } from "../components/Sankey.tsx";
import { Toolbar } from "../components/Toolbar.tsx";
import {
  ago,
  BarList,
  Confirm,
  CsvButton,
  Delta,
  Empty,
  ErrorBox,
  Field,
  Section,
  Segmented,
  Sheet,
  Skeleton,
  Tabs,
  useToast,
} from "../components/ui.tsx";
import { api, duration, fmt, rangeBody, rangeParams, type Row } from "../lib/api.ts";
import { useFilters } from "../lib/state.ts";
import { locale, t, tn } from "../lib/i18n.ts";
import { channelName, countryName, deviceName } from "../lib/labels.ts";
import { useSites } from "../components/Shell.tsx";
import { SiteHeader } from "./overview.tsx";
import { noteKind } from "../components/TimeChart.tsx";

const useSite = () => (useParams({ strict: false }) as { site: string }).site;

function useCanWrite() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ data: { email: string; role: string } }>("/auth/me"),
    retry: false,
    staleTime: 300_000,
  });
  return me.data ? me.data.data.role !== "viewer" : true;
}

// ---------- Realtime ----------

// ---------- Goals ----------

interface Match {
  kind: "pageview" | "event" | "outbound";
  path?: string;
  event?: string;
  host?: string;
  prop?: { key: string; value: string | number | boolean };
}
interface Goal {
  id: string;
  name: string;
  match: Match;
}

function matchText(m: Match): string {
  if (m.kind === "pageview") return t("visits {path}", { path: String(m.path) });
  if (m.kind === "event")
    return m.prop
      ? t("sends “{event}” with {key} = {value}", {
          event: String(m.event),
          key: m.prop.key,
          value: String(m.prop.value),
        })
      : t("sends “{event}”", { event: String(m.event) });
  return t("clicks a link to {host}", { host: m.host || t("another site") });
}

/** Conversion rate as a ring (the site's colour on a faint track). */
function Ring({ pct, size = 46 }: { pct: number | null; size?: number }) {
  const sw = 5;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="shrink-0 -rotate-90"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-2)" strokeWidth={sw} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--site)"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`}
      />
    </svg>
  );
}

function MatchFields({
  value,
  onChange,
  step,
}: {
  value: Match;
  onChange: (m: Match) => void;
  step?: number;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <select
          className="input"
          value={value.kind}
          onChange={(e) => onChange({ kind: e.target.value as Match["kind"] })}
          aria-label={step ? t("Step {n} type", { n: step }) : t("Type")}
        >
          <option value="pageview">{t("Visits a page")}</option>
          <option value="event">{t("Sends an event")}</option>
          <option value="outbound">{t("Clicks an outbound link")}</option>
        </select>
        <input
          className="input"
          required
          aria-label={step ? t("Step {n} value", { n: step }) : t("Value")}
          placeholder={
            value.kind === "pageview"
              ? t("/thanks or /*/pricing")
              : value.kind === "event"
                ? t("event name, e.g. signup")
                : t("wa.me, calendly.com")
          }
          value={value.path ?? value.event ?? value.host ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              [value.kind === "pageview" ? "path" : value.kind === "event" ? "event" : "host"]:
                e.target.value,
            })
          }
        />
      </div>
      {value.kind === "event" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className="input"
            placeholder={t("property (optional), e.g. plan")}
            value={value.prop?.key ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                prop: e.target.value ? { key: e.target.value, value: value.prop?.value ?? "" } : undefined,
              })
            }
            aria-label={t("Property")}
          />
          <input
            className="input"
            placeholder={t("equals, e.g. pro")}
            value={String(value.prop?.value ?? "")}
            disabled={!value.prop}
            onChange={(e) => onChange({ ...value, prop: { key: value.prop!.key, value: e.target.value } })}
            aria-label={t("Property value")}
          />
        </div>
      )}
    </div>
  );
}

function GoalRow({
  site,
  goal,
  f,
  currency,
  canWrite,
  onEdit,
}: {
  site: string;
  goal: Goal;
  f: ReturnType<typeof useFilters>[0];
  currency?: string;
  canWrite: boolean;
  onEdit: () => void;
}) {
  const q = useQuery({
    queryKey: ["goalrow", site, goal.id, f],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.post<{ rows: Row[]; totals: Row; comparison: { totals: Row } | null }>(
        `/api/v1/sites/${site}/query`,
        {
          ...rangeBody(f),
          metrics: ["conversions", "conversion_rate", ...(goal.match.kind === "event" ? ["revenue"] : [])],
          dimensions: ["day"],
          limit: 400,
          goal: goal.id,
        },
      ),
  });
  const tot = q.data?.totals;
  const prev = Number(q.data?.comparison?.totals.conversions ?? 0);
  const cur = Number(tot?.conversions ?? 0);
  const ch = f.compare && prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;
  const rate =
    tot?.conversion_rate === null || tot?.conversion_rate === undefined ? null : Number(tot.conversion_rate);
  const rows = q.data?.rows ?? [];
  const revenue = Number(tot?.revenue ?? 0);
  return (
    <li>
      <button
        type="button"
        disabled={!canWrite}
        onClick={onEdit}
        className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-lg px-2 py-3 text-left sm:grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1fr)_100px_120px] ${canWrite ? "row-hover" : "cursor-default"}`}
      >
        <Ring pct={rate} />
        <span className="min-w-0">
          <span className="t-heading block truncate">{goal.name}</span>
          <span className="block truncate text-[13px] text-ink-2">
            {t("when someone {what}", { what: matchText(goal.match) })}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[12.5px] text-ink-2 sm:hidden">
            <span className="t-num font-semibold text-ink">{q.data ? fmt(cur) : "–"}</span> {t("conversions")}
            {ch !== null && <Delta pct={ch} />}
          </span>
        </span>
        <span
          className="hidden min-w-0 sm:block"
          aria-label={t("Conversions per day, {n} in total", { n: fmt(cur) })}
        >
          {q.data && rows.length > 1 && (
            <MiniChart
              values={rows.map((r) => Number(r.conversions ?? 0))}
              labels={rows.map((r) => String(r.day))}
              unit={t("conversions")}
              height={40}
            />
          )}
        </span>
        <span className="text-right">
          <span className="t-num block text-[28px] font-bold leading-8">
            {rate === null ? "–" : fmt(rate, "conversion_rate")}
          </span>
          <span className="text-xs text-ink-3">
            {revenue > 0
              ? t("{amount} revenue", {
                  amount: `${currency ? `${currency} ` : ""}${fmt(revenue, "revenue")}`,
                })
              : t("of sessions")}
          </span>
        </span>
        <span className="hidden flex-col items-end gap-1 sm:flex">
          <span className="t-num text-[20px] font-semibold leading-6">{q.data ? fmt(cur) : "–"}</span>
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            {t("conversions")}
            {ch !== null && <Delta pct={ch} />}
          </span>
        </span>
      </button>
    </li>
  );
}

export function GoalsPage() {
  const site = useSite();
  const [f, setF] = useFilters();
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = useCanWrite();
  const currency = useSites().data?.data.find((s) => s.id === site)?.settings.revenue_currency;
  const goals = useQuery({
    queryKey: ["goals", site],
    queryFn: () => api.get<{ data: Goal[] }>(`/api/v1/sites/${site}/goals`),
  });
  const [edit, setEdit] = useState<Partial<Goal> | null>(null);
  const [del, setDel] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["goals", site] });
  const save = useMutation({
    mutationFn: (g: Partial<Goal>) =>
      g.id
        ? api.patch(`/api/v1/sites/${site}/goals/${g.id}`, { name: g.name, match: g.match })
        : api.post(`/api/v1/sites/${site}/goals`, { name: g.name, match: g.match }),
    onSuccess: () => (toast(t("Goal saved")), setEdit(null), refresh()),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/sites/${site}/goals/${id}`),
    onSuccess: () => (toast(t("Goal deleted")), setEdit(null), refresh()),
  });
  return (
    <div className="flex flex-col gap-6 [&>header:first-child]:-mb-1">
      <SiteHeader site={site} />
      <Toolbar value={f} onChange={setF} />
      <Section
        title={t("Goals")}
        actions={
          canWrite ? (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setEdit({ name: "", match: { kind: "event", event: "" } })}
            >
              <Plus size={14} aria-hidden="true" /> {t("Add goal")}
            </button>
          ) : undefined
        }
      >
        {goals.isLoading ? (
          <Skeleton h={160} />
        ) : !goals.data?.data.length ? (
          <Empty
            action={
              canWrite ? (
                <button
                  className="btn btn-primary"
                  onClick={() => setEdit({ name: "", match: { kind: "event", event: "" } })}
                >
                  {t("Add a goal")}
                </button>
              ) : undefined
            }
          >
            {t(
              "No goals yet. A goal counts the sessions that do something that matters: sign up, buy, book, reach a page.",
            )}
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-line-2">
            {goals.data.data.map((g) => (
              <GoalRow
                key={g.id}
                site={site}
                goal={g}
                f={f}
                currency={currency}
                canWrite={canWrite}
                onEdit={() => canWrite && setEdit(g)}
              />
            ))}
          </ul>
        )}
      </Section>
      <Sheet
        open={!!edit}
        onOpenChange={(v) => !v && setEdit(null)}
        title={edit?.id ? t("Edit {name}", { name: String(edit.name) }) : t("Add a goal")}
        description={t("Counts each session once, the first time it matches.")}
      >
        {edit && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(edit);
            }}
          >
            <Field label={t("Name")}>
              <input
                className="input"
                value={edit.name ?? ""}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder={t("Signup")}
                required
                autoFocus
              />
            </Field>
            <Field
              group
              label={t("Counts when someone")}
              hint={t(
                "Page paths accept * wildcards. For revenue, send a numeric revenue property with the event.",
              )}
            >
              <MatchFields
                value={edit.match ?? { kind: "event" }}
                onChange={(match) => setEdit({ ...edit, match })}
              />
            </Field>
            {save.error && <ErrorBox error={save.error} />}
            <div className="flex justify-end gap-2">
              {edit.id && (
                <button type="button" className="btn btn-danger mr-auto" onClick={() => setDel(true)}>
                  {t("Delete goal")}
                </button>
              )}
              <button className="btn btn-primary" type="submit" disabled={save.isPending}>
                {edit.id ? t("Save changes") : t("Add goal")}
              </button>
            </div>
          </form>
        )}
        <Confirm
          open={del}
          onOpenChange={setDel}
          title={t("Delete {name}?", { name: edit?.name ?? t("this goal") })}
          body={t("Its conversions stay in your data; only the goal definition goes.")}
          confirm={t("Delete goal")}
          onConfirm={() => edit?.id && remove.mutate(edit.id)}
        />
      </Sheet>
    </div>
  );
}

// ---------- Funnels ----------

interface Step {
  name?: string;
  match: Match;
}
interface FunnelDef {
  id: string;
  name: string;
  steps: Step[];
  window_minutes: number;
  step_order?: "flexible" | "strict";
}
interface FunnelResult {
  steps: Row[];
  comparison: { steps: Row[] } | null;
  breakdown?: { dimension: string; rows: { value: string; sessions: number[]; conversion_pct: number }[] };
}
const BREAKDOWNS: { value: string; label: string }[] = [
  { value: "", label: t("All") },
  { value: "channel", label: t("Channel") },
  { value: "device", label: t("Device") },
  { value: "country", label: t("Country") },
];
const round1 = (n: number) => Math.round(n * 10) / 10;

export function FunnelsPage() {
  const site = useSite();
  const [f, setF] = useFilters();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ["funnels", site],
    queryFn: () => api.get<{ data: FunnelDef[] }>(`/api/v1/sites/${site}/funnels`),
  });
  const [sel, setSel] = useState<string | null>(null);
  const current = list.data?.data.find((x) => x.id === sel) ?? list.data?.data[0];
  const [bd, setBd] = useState("");
  const result = useQuery({
    queryKey: ["funnel", site, current?.id, f, bd],
    enabled: !!current,
    // Old numbers stay while a new range loads, never another funnel's steps or another breakdown's rows.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === current?.id && prevQuery?.queryKey[4] === bd
        ? keepPreviousData(prev)
        : undefined,
    queryFn: () =>
      api.get<FunnelResult>(
        `/api/v1/sites/${site}/funnels/${current!.id}?${rangeParams(f)}${bd ? `&breakdown=${bd}` : ""}`,
      ),
  });
  const [edit, setEdit] = useState<Partial<FunnelDef> | null>(null);
  const [del, setDel] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["funnels", site] });
  const save = useMutation({
    mutationFn: (d: Partial<FunnelDef>) =>
      d.id
        ? api.patch(`/api/v1/sites/${site}/funnels/${d.id}`, d)
        : api.post<{ data: { id: string } }>(`/api/v1/sites/${site}/funnels`, d),
    onSuccess: (r) => {
      toast(t("Funnel saved"));
      const id = (r as { data?: { id?: string } }).data?.id;
      if (id) setSel(id);
      setEdit(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/sites/${site}/funnels/${id}`),
    onSuccess: () => (toast(t("Funnel deleted")), setEdit(null), setSel(null), refresh()),
  });
  const steps = result.data?.steps ?? [];
  const prevSteps = result.data?.comparison?.steps ?? null;
  const max = Math.max(
    ...steps.map((s) => Number(s.sessions)),
    ...(prevSteps ?? []).map((s) => Number(s.sessions)),
    1,
  );
  const first = steps[0];
  const last = steps[steps.length - 1];
  const overall = last ? Number(last.conversion_from_start_pct) : null;
  const prevLast = prevSteps?.[prevSteps.length - 1];
  const overallDelta =
    overall !== null && prevLast ? round1(overall - Number(prevLast.conversion_from_start_pct)) : null;
  const blank = {
    name: "",
    window_minutes: 30,
    step_order: "flexible" as const,
    steps: [{ match: { kind: "pageview", path: "/" } }, { match: { kind: "event", event: "" } }] as Step[],
  };
  const bdLabel = BREAKDOWNS.find((b) => b.value === bd)?.label ?? bd;
  return (
    <div className="flex flex-col gap-6 [&>header:first-child]:-mb-1">
      <SiteHeader site={site} />
      <Toolbar value={f} onChange={setF} />
      <Section
        title={current ? current.name : t("Funnels")}
        actions={
          <>
            {(list.data?.data.length ?? 0) > 1 && (
              <Tabs
                label={t("Funnel")}
                value={current?.id ?? ""}
                onChange={(v) => setSel(v)}
                options={(list.data?.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              />
            )}
            {current && (
              <button className="btn btn-sm" onClick={() => setEdit(current)}>
                {t("Edit")}
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => setEdit(blank)}>
              <Plus size={14} aria-hidden="true" /> {t("New funnel")}
            </button>
            <CsvButton rows={steps} name={`${site}-funnel`} />
          </>
        }
      >
        {!list.data?.data.length ? (
          <Empty
            action={
              <button className="btn btn-primary" onClick={() => setEdit(blank)}>
                {t("Build a funnel")}
              </button>
            }
          >
            {t("No funnels yet. A funnel shows how many sessions get through each step, in order.")}
          </Empty>
        ) : result.isLoading ? (
          <Skeleton h={220} />
        ) : (
          <div className="px-2 pb-2 pt-1">
            {first && last && (
              <div className="mb-6 flex flex-wrap items-end gap-x-8 gap-y-3 border-b border-line-2 pb-5">
                <div>
                  <div className="text-[13px] text-ink-2">{t("Overall conversion")}</div>
                  <div className="flex items-center gap-3">
                    <span className="t-readout text-site-ink" style={{ fontSize: 48, lineHeight: "52px" }}>
                      {fmt(overall, "conversion_rate")}
                    </span>
                    {overallDelta !== null && <Delta pct={overallDelta} unit=" pts" />}
                  </div>
                </div>
                <p className="pb-1.5 text-[13.5px] text-ink-2">
                  <span className="t-num font-semibold text-ink">{fmt(last.sessions)}</span> {t("of")}{" "}
                  <span className="t-num font-semibold text-ink">{fmt(first.sessions)}</span>{" "}
                  {t("sessions that started it reached the last step.")}
                </p>
              </div>
            )}
            <ol className="flex flex-col">
              {steps.map((s, i) => {
                const p = prevSteps?.[i];
                const dpp = p
                  ? round1(Number(s.conversion_from_start_pct) - Number(p.conversion_from_start_pct))
                  : null;
                const cont =
                  s.conversion_from_previous_pct === null || s.conversion_from_previous_pct === undefined
                    ? null
                    : Number(s.conversion_from_previous_pct);
                return (
                  <li key={i}>
                    {i > 0 && (
                      <div className="ml-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-dashed border-line-strong py-2.5 pl-4 text-[13px]">
                        <span
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-bad"
                          style={{ background: "color-mix(in oklab, var(--bad) 10%, transparent)" }}
                        >
                          <span aria-hidden="true">↘</span>
                          {cont !== null ? `−${fmt(round1(100 - cont), "drop_pct")}` : "–"} ·{" "}
                          {t("{n} left", { n: fmt(s.drop_off) })}
                        </span>
                        <span className="text-ink-2">
                          {cont !== null ? t("{pct} continued", { pct: fmt(cont, "conversion_rate") }) : ""}
                          {s.median_seconds_from_previous !== null &&
                          s.median_seconds_from_previous !== undefined
                            ? `${cont !== null ? ", " : ""}${t("median {time} from the step before", { time: duration(Number(s.median_seconds_from_previous)) })}`
                            : ""}
                        </span>
                      </div>
                    )}
                    <div>
                      <div className="mb-1.5 flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-sm">
                          <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-site-tint text-[11.5px] font-semibold text-site-ink">
                            {i + 1}
                          </span>
                          <span className="font-medium">{String(s.name)}</span>
                        </span>
                        <span className="flex shrink-0 items-baseline gap-2 tabular">
                          <span className="t-num text-[22px] font-semibold">{fmt(s.sessions)}</span>
                          <span className="text-[13px] text-ink-2">
                            {fmt(s.conversion_from_start_pct, "conversion_rate")}
                          </span>
                          {i > 0 && dpp !== null && dpp !== 0 && <Delta pct={dpp} unit=" pts" />}
                        </span>
                      </div>
                      <div className="relative h-8 rounded-lg bg-site-tint">
                        <div
                          className="h-8 rounded-lg bg-site"
                          style={{
                            width: `${Math.max((Number(s.sessions) / max) * 100, 0.8)}%`,
                            opacity: Math.max(1 - i * 0.1, 0.55),
                          }}
                        />
                        {p && (
                          <div
                            className="absolute inset-y-[-3px] border-r-2 border-dashed border-ghost"
                            style={{ left: `${(Number(p.sessions) / max) * 100}%` }}
                            title={t("Comparison period: {n} sessions", { n: fmt(p.sessions) })}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {current && (
          <p className="mt-2 px-2 text-xs text-ink-3">
            {t("{order}, within one session and {n} minutes. Page paths accept * wildcards.", {
              order:
                current.step_order === "strict"
                  ? t("Strict order: the next page viewed must be the next step")
                  : t("Steps in order, other pages allowed in between"),
              n: current.window_minutes,
            })}
            {prevSteps ? ` ${t("The dashed mark is the comparison period.")}` : ""}
          </p>
        )}
      </Section>
      {current && (
        <Section
          title={t("Who gets through")}
          actions={<Segmented label={t("Break down by")} value={bd} onChange={setBd} options={BREAKDOWNS} />}
        >
          {!bd ? (
            <p className="px-2 py-2 text-sm text-ink-2">
              {t(
                "Pick a dimension to see each step by channel, device or country, and where conversion is strongest.",
              )}
            </p>
          ) : !result.data?.breakdown ? (
            <Skeleton h={120} />
          ) : !result.data.breakdown.rows.length ? (
            <Empty>{t("No sessions started this funnel in this range.")}</Empty>
          ) : (
            <DenseTable
              label={t("Funnel by {dimension}", { dimension: bdLabel.toLowerCase() })}
              minWidth={480 + steps.length * 90}
              rows={result.data.breakdown.rows}
              cols={[
                {
                  key: "value",
                  label: bdLabel,
                  render: (r) => (
                    <span className="font-medium">
                      {!r.value
                        ? t("(none)")
                        : bd === "channel"
                          ? channelName(r.value)
                          : bd === "device"
                            ? deviceName(r.value)
                            : bd === "country"
                              ? countryName(r.value)
                              : r.value}
                    </span>
                  ),
                },
                ...steps.map((s, i) => ({
                  key: `s${i}`,
                  label: `${i + 1}. ${String(s.name)}`,
                  align: "right" as const,
                  className: "t-num text-[15px]",
                  render: (r: { sessions: number[] }) => fmt(r.sessions[i]),
                })),
                {
                  key: "conversion_pct",
                  label: t("Converted"),
                  align: "right",
                  render: (r) => {
                    const best = Math.max(1, ...result.data!.breakdown!.rows.map((x) => x.conversion_pct));
                    return (
                      <span className="flex items-center justify-end gap-2">
                        <span
                          className="hidden h-2 w-20 rounded-full bg-site-tint sm:block"
                          aria-hidden="true"
                        >
                          <span
                            className="block h-2 rounded-full bg-site"
                            style={{ width: `${(Number(r.conversion_pct) / best) * 100}%` }}
                          />
                        </span>
                        <span className="t-num w-12 text-right text-[15px] font-semibold">
                          {fmt(r.conversion_pct, "conversion_rate")}
                        </span>
                      </span>
                    );
                  },
                },
              ]}
            />
          )}
        </Section>
      )}
      <Sheet
        open={!!edit}
        onOpenChange={(v) => !v && setEdit(null)}
        title={edit?.id ? t("Edit {name}", { name: String(edit.name) }) : t("Build a funnel")}
        wide
      >
        {edit && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(edit);
            }}
          >
            <Field label={t("Name")}>
              <input
                className="input"
                value={edit.name ?? ""}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder={t("Product to purchase")}
                required
                autoFocus
              />
            </Field>
            <ol className="flex flex-col gap-3">
              {(edit.steps ?? []).map((s, i) => (
                <li key={i} className="flex flex-col gap-2 border-l-2 border-site pl-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{t("Step {n}", { n: i + 1 })}</span>
                    {(edit.steps?.length ?? 0) > 2 && (
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm text-ink-2"
                        onClick={() => setEdit({ ...edit, steps: edit.steps!.filter((_, j) => j !== i) })}
                      >
                        {t("Remove")}
                      </button>
                    )}
                  </div>
                  <input
                    className="input"
                    placeholder={t("Label (optional)")}
                    value={s.name ?? ""}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        steps: edit.steps!.map((x, j) =>
                          j === i ? { ...x, name: e.target.value || undefined } : x,
                        ),
                      })
                    }
                    aria-label={t("Step {n} label", { n: i + 1 })}
                  />
                  <MatchFields
                    step={i + 1}
                    value={s.match}
                    onChange={(match) =>
                      setEdit({ ...edit, steps: edit.steps!.map((x, j) => (j === i ? { ...x, match } : x)) })
                    }
                  />
                </li>
              ))}
            </ol>
            {(edit.steps?.length ?? 0) < 8 && (
              <button
                type="button"
                className="btn self-start"
                onClick={() =>
                  setEdit({
                    ...edit,
                    steps: [...(edit.steps ?? []), { match: { kind: "pageview", path: "" } }],
                  })
                }
              >
                <Plus size={14} aria-hidden="true" /> {t("Add step")}
              </button>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("Within (minutes)")}
                hint={t("All steps must happen in one session, within this time")}
              >
                <input
                  className="input w-28"
                  type="number"
                  min={1}
                  max={1440}
                  value={edit.window_minutes ?? 30}
                  onChange={(e) => setEdit({ ...edit, window_minutes: Number(e.target.value) })}
                />
              </Field>
              <Field
                label={t("Step order")}
                hint={
                  edit.step_order === "strict"
                    ? t("Any other page in between ends the run")
                    : t("Visitors may look at other pages in between")
                }
              >
                <select
                  className="input"
                  value={edit.step_order ?? "flexible"}
                  onChange={(e) => setEdit({ ...edit, step_order: e.target.value as "flexible" | "strict" })}
                >
                  <option value="flexible">{t("Flexible")}</option>
                  <option value="strict">{t("Strict")}</option>
                </select>
              </Field>
            </div>
            {save.error && <ErrorBox error={save.error} />}
            <div className="flex justify-end gap-2">
              {edit.id && (
                <button type="button" className="btn btn-danger mr-auto" onClick={() => setDel(true)}>
                  {t("Delete funnel")}
                </button>
              )}
              <button className="btn btn-primary" type="submit" disabled={save.isPending}>
                {edit.id ? t("Save changes") : t("Save funnel")}
              </button>
            </div>
          </form>
        )}
        <Confirm
          open={del}
          onOpenChange={setDel}
          title={t("Delete {name}?", { name: edit?.name ?? t("this funnel") })}
          body={t("Only the funnel definition is deleted; your data stays.")}
          confirm={t("Delete funnel")}
          onConfirm={() => edit?.id && remove.mutate(edit.id)}
        />
      </Sheet>
    </div>
  );
}

// ---------- Journeys ----------

export function PathsPage() {
  const site = useSite();
  const [f, setF] = useFilters();
  const [from, setFrom] = useState("/");
  const [draft, setDraft] = useState("/");
  const [dir, setDir] = useState<"next" | "previous">("next");
  const [view, setView] = useState<"flow" | "list">("flow");
  const top = useQuery({
    queryKey: ["toppages", site, f.range],
    queryFn: () =>
      api.post<{ rows: Row[] }>(`/api/v1/sites/${site}/query`, {
        ...rangeBody({ ...f, filters: [] }),
        compare: null,
        metrics: ["pageviews"],
        dimensions: ["page"],
        limit: 12,
      }),
  });
  const q = useQuery({
    queryKey: ["paths", site, f, from, dir],
    placeholderData: keepPreviousData,
    queryFn: () => {
      const p = new URLSearchParams(rangeParams(f));
      const fromDate = p.get("from");
      const toDate = p.get("to");
      p.delete("from");
      p.delete("to");
      if (fromDate) p.set("date_from", fromDate);
      if (toDate) p.set("date_to", toDate);
      p.set("from", from);
      p.set("direction", dir);
      p.set("depth", "3");
      return api.get<{ occurrences: number; paths: { path: string; count: number; share_pct: number }[] }>(
        `/api/v1/sites/${site}/paths?${p}`,
      );
    },
  });
  return (
    <div className="flex flex-col gap-6 [&>header:first-child]:-mb-1">
      <SiteHeader site={site} />
      <Toolbar value={f} onChange={setF} showCompare={false} />
      <Section
        title={t("Journeys")}
        actions={
          <Segmented
            label={t("View")}
            value={view}
            onChange={setView}
            options={[
              { value: "flow", label: t("Flow") },
              { value: "list", label: t("List") },
            ]}
          />
        }
      >
        <div className="px-2 pt-1">
          <form
            className="mb-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setFrom(draft || "/");
            }}
          >
            <select
              className="input w-auto"
              value={dir}
              onChange={(e) => setDir(e.target.value as "next" | "previous")}
              aria-label={t("Direction")}
            >
              <option value="next">{t("What people do after")}</option>
              <option value="previous">{t("How people reach")}</option>
            </select>
            <input
              className="input min-w-0 flex-1"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={t("Page")}
              list="journey-pages"
            />
            <datalist id="journey-pages">
              {(top.data?.rows ?? []).map((r) => (
                <option key={String(r.page)} value={String(r.page)} />
              ))}
            </datalist>
            <button className="btn" type="submit">
              {t("Show")}
            </button>
          </form>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {(top.data?.rows ?? []).slice(0, 8).map((r) => (
              <button
                key={String(r.page)}
                type="button"
                aria-pressed={from === r.page}
                className={`chip ${from === r.page ? "chip-mark font-semibold" : "hover:bg-hover"}`}
                onClick={() => (setFrom(String(r.page)), setDraft(String(r.page)))}
              >
                {String(r.page)}
              </button>
            ))}
          </div>
        </div>
        {q.isLoading ? (
          <Skeleton h={220} />
        ) : q.error ? (
          <ErrorBox error={q.error} />
        ) : !q.data!.paths.length ? (
          <Empty>{t("No journeys through {path} in this range.", { path: from })}</Empty>
        ) : view === "flow" ? (
          <Sankey start={from} paths={q.data!.paths} direction={dir} occurrences={q.data!.occurrences} />
        ) : (
          <div className="px-2">
            <BarList rows={q.data!.paths} dimension="path" metric="count" secondary="share_pct" limit={25} />
          </div>
        )}
        {q.data && (
          <p className="mt-3 px-2 text-xs text-ink-3">
            {t("{n} visits to {path} in this range.", { n: fmt(q.data.occurrences), path: from })}{" "}
            {view === "flow"
              ? t(
                  "Flow width is sessions; hover a flow for the numbers. Small branches are grouped as other pages.",
                )
              : ""}
          </p>
        )}
      </Section>
    </div>
  );
}

// ---------- Retention ----------

/** One hue (the site's), light to dark by share of the strongest cohort; the text flips to white on dark cells. */
function heat(v: number, max: number) {
  const x = Math.round(8 + 77 * Math.min(1, Math.max(0, v) / max));
  return {
    background: `color-mix(in oklab, var(--site) ${x}%, var(--line-2))`,
    color: x > 50 ? "#fff" : "var(--ink)",
  };
}

export function RetentionPage() {
  const site = useSite();
  const [f, setF] = useFilters();
  const q = useQuery({
    queryKey: ["ret", site, f],
    queryFn: () =>
      api.get<{ caveat: string; cohorts: Row[] }>(`/api/v1/sites/${site}/retention?${rangeParams(f)}`),
  });
  const cohorts = q.data?.cohorts ?? [];
  const max = Math.max(1, ...cohorts.map((c) => Number(c.return_rate_pct ?? 0)));
  const days = cohorts.reduce((a, c) => a + Number(c.visitor_days ?? 0), 0);
  const back = cohorts.reduce((a, c) => a + Number(c.returning_same_day ?? 0), 0);
  const overall = days ? round1((back / days) * 100) : null;
  return (
    <div className="flex flex-col gap-6 [&>header:first-child]:-mb-1">
      <SiteHeader site={site} />
      <Toolbar value={f} onChange={setF} showCompare={false} />
      <Section title={t("Returning the same day")}>
        <div className="px-2 pt-1">
          {q.data && (
            <div className="mb-5 flex flex-wrap items-end gap-x-8 gap-y-2">
              <div>
                <div className="text-[13px] text-ink-2">{t("Came back the same day")}</div>
                <div className="t-readout text-site-ink" style={{ fontSize: 44, lineHeight: "48px" }}>
                  {overall === null ? "–" : fmt(overall, "return_rate_pct")}
                </div>
              </div>
              <p className="pb-1 text-sm text-ink-2">
                {t(
                  "Visitor ids rotate every day (no cookies), so retention counts visitors who came back in another session the same day.",
                )}
              </p>
            </div>
          )}
        </div>
        {q.isLoading ? (
          <Skeleton h={200} />
        ) : (
          <>
            <DenseTable
              label={t("Weekly cohorts")}
              minWidth={520}
              rows={cohorts}
              cols={[
                {
                  key: "week",
                  label: t("Week of"),
                  render: (r) => (
                    <span className="font-medium">
                      {new Date(`${r.week}T00:00:00`).toLocaleDateString(locale, {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  ),
                },
                {
                  key: "visitor_days",
                  label: t("Visitor-days"),
                  align: "right",
                  className: "t-num text-[15px]",
                  render: (r) => fmt(r.visitor_days),
                },
                {
                  key: "returning_same_day",
                  label: t("Came back"),
                  align: "right",
                  className: "t-num text-[15px]",
                  render: (r) => fmt(r.returning_same_day),
                },
                {
                  key: "return_rate_pct",
                  label: t("Return rate"),
                  render: (r) => (
                    <div
                      className="t-num min-w-[8rem] rounded-lg px-3 py-1.5 text-center text-[15px] font-semibold"
                      style={heat(Number(r.return_rate_pct ?? 0), max)}
                    >
                      {fmt(r.return_rate_pct, "return_rate_pct")}
                    </div>
                  ),
                },
                {
                  key: "sessions_per_visitor_day",
                  label: t("Sessions each"),
                  align: "right",
                  className: "t-num text-[15px]",
                  render: (r) => fmt(r.sessions_per_visitor_day),
                },
              ]}
            />
            {cohorts.length > 0 && (
              <div className="mt-3 flex items-center gap-2 px-3 text-xs text-ink-3">
                <span>{t("Lower")}</span>
                <span
                  className="h-2.5 w-28 rounded-full"
                  style={{
                    background: `linear-gradient(to right, ${heat(0, max).background}, ${heat(max, max).background})`,
                  }}
                  aria-hidden="true"
                />
                <span>{t("Higher (up to {max})", { max: fmt(max, "return_rate_pct") })}</span>
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

// ---------- Web vitals ----------

const VITALS: {
  m: "lcp" | "inp" | "cls";
  name: string;
  what: string;
  limits: [number, number];
  good: string;
}[] = [
  {
    m: "lcp",
    name: t("Largest Contentful Paint"),
    what: t("How fast the main content appears"),
    limits: [2500, 4000],
    good: t("good under 2.5 s, poor over 4 s"),
  },
  {
    m: "inp",
    name: t("Interaction to Next Paint"),
    what: t("How fast the page reacts to taps and clicks"),
    limits: [200, 500],
    good: t("good under 200 ms, poor over 500 ms"),
  },
  {
    m: "cls",
    name: t("Cumulative Layout Shift"),
    what: t("How much the layout jumps while loading"),
    limits: [0.1, 0.25],
    good: t("good under 0.1, poor over 0.25"),
  },
];

type Verdict = "good" | "warn" | "poor";
const verdictOf = (m: "lcp" | "inp" | "cls", v: unknown): Verdict | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const [g, p] = VITALS.find((x) => x.m === m)!.limits;
  return n <= g ? "good" : n <= p ? "warn" : "poor";
};
const showVital = (m: "lcp" | "inp" | "cls", v: unknown) => {
  if (v === null || v === undefined || v === "") return "–";
  const n = Number(v);
  return m === "lcp"
    ? n >= 1000
      ? `${(n / 1000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`
      : `${Math.round(n)} ms`
    : m === "inp"
      ? `${Math.round(n)} ms`
      : n.toLocaleString(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
};
const VERDICT = {
  good: { label: t("Good"), color: "var(--good)", Icon: Check },
  warn: { label: t("Needs work"), color: "var(--warn)", Icon: WarningCircle },
  poor: { label: t("Poor"), color: "var(--bad)", Icon: X },
};

/** A verdict pill: an icon, never colour alone. With `text`, it shows that instead of the verdict's name. */
function VerdictPill({ v, text, size = "md" }: { v: Verdict | null; text?: string; size?: "sm" | "md" }) {
  if (!v) return <span className="text-ink-3">{text ?? t("No data yet")}</span>;
  const { label, color, Icon } = VERDICT[v];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold ${size === "sm" ? "px-2 py-0.5 text-[12.5px]" : "px-2.5 py-1 text-[12.5px]"}`}
      style={{ color, background: `color-mix(in oklab, ${color} 12%, transparent)` }}
      title={label}
    >
      <Icon size={size === "sm" ? 12 : 13} weight="bold" aria-hidden="true" />
      {text ?? label}
      {text && <span className="sr-only">, {label}</span>}
    </span>
  );
}

export function VitalsPage() {
  const site = useSite();
  const [f, setF] = useFilters();
  const [dim, setDim] = useState<"page" | "device">("page");
  const q = useQuery({
    queryKey: ["vitals", site, f, dim],
    queryFn: () =>
      api.get<{
        p75: Row;
        shares: Record<
          string,
          {
            samples: number;
            good_pct: number | null;
            needs_improvement_pct: number | null;
            poor_pct: number | null;
          }
        >;
        rows: Row[];
      }>(`/api/v1/sites/${site}/vitals?${rangeParams(f)}&dimension=${dim}`),
  });
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SiteHeader site={site} />
      <Toolbar value={f} onChange={setF} showCompare={false} />
      {q.isLoading ? (
        <Skeleton h={160} />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {VITALS.map(({ m, name, what, good }) => {
              const s = q.data!.shares[m] ?? {
                samples: 0,
                good_pct: null,
                needs_improvement_pct: null,
                poor_pct: null,
              };
              const p75 = q.data!.p75[`${m}_p75`];
              const v = s.samples ? verdictOf(m, p75) : null;
              return (
                <section key={m} className="panel flex min-w-0 flex-col gap-3 p-5" aria-label={name}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="t-heading" title={name}>
                      {m.toUpperCase()}
                    </h2>
                    <VerdictPill v={v} />
                  </div>
                  <div>
                    <div className="t-readout">{showVital(m, p75)}</div>
                    <div className="text-xs text-ink-3">
                      {t("75th percentile · {n} samples", { n: fmt(s.samples) })}
                    </div>
                  </div>
                  <div className="flex h-2 gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
                    <div style={{ width: `${s.good_pct ?? 0}%`, background: "var(--good)" }} />
                    <div style={{ width: `${s.needs_improvement_pct ?? 0}%`, background: "var(--warn)" }} />
                    <div style={{ width: `${s.poor_pct ?? 0}%`, background: "var(--bad)" }} />
                  </div>
                  <p className="text-[12.5px] text-ink-2">
                    {t("{good} good · {warn} needs work · {poor} poor", {
                      good: fmt(s.good_pct, "_pct"),
                      warn: fmt(s.needs_improvement_pct, "_pct"),
                      poor: fmt(s.poor_pct, "_pct"),
                    })}
                  </p>
                  <p className="text-xs text-ink-3">
                    {what}; {good}.
                  </p>
                </section>
              );
            })}
          </div>
          <Section
            title={dim === "page" ? t("By page (75th percentile)") : t("By device (75th percentile)")}
            actions={
              <Segmented
                label={t("Group by")}
                value={dim}
                onChange={setDim}
                options={[
                  { value: "page", label: t("Pages") },
                  { value: "device", label: t("Devices") },
                ]}
              />
            }
          >
            <DenseTable
              label={dim === "page" ? t("Web vitals by page") : t("Web vitals by device")}
              minWidth={620}
              rows={q.data!.rows}
              cols={[
                {
                  key: dim,
                  label: dim === "page" ? t("Page") : t("Device"),
                  render: (r) => (
                    <span className="block max-w-[320px] truncate font-medium">
                      {dim === "device" ? deviceName(r.device) : String(r[dim] ?? t("(none)"))}
                    </span>
                  ),
                },
                ...VITALS.map(({ m }) => ({
                  key: `${m}_p75`,
                  label: m.toUpperCase(),
                  align: "right" as const,
                  render: (r: Row) => (
                    <VerdictPill
                      size="sm"
                      v={verdictOf(m, r[`${m}_p75`])}
                      text={showVital(m, r[`${m}_p75`])}
                    />
                  ),
                })),
                {
                  key: "pageviews",
                  label: t("Pageviews"),
                  align: "right",
                  className: "t-num text-[15px]",
                  render: (r) => fmt(r.pageviews),
                },
              ]}
            />
          </Section>
        </>
      )}
    </div>
  );
}

// ---------- Errors ----------

export function ErrorsPage() {
  const site = useSite();
  const [f, setF] = useFilters();
  const q = useQuery({
    queryKey: ["errors", site, f],
    queryFn: () =>
      api.get<{ meta: { errors_enabled: boolean }; groups: Row[] }>(
        `/api/v1/sites/${site}/errors?${rangeParams(f)}`,
      ),
  });
  const groups = q.data?.groups ?? [];
  const total = groups.reduce((a, g) => a + Number(g.occurrences ?? 0), 0);
  return (
    <div className="flex flex-col gap-6 [&>header:first-child]:-mb-1">
      <SiteHeader site={site} />
      <Toolbar value={f} onChange={setF} showCompare={false} />
      <Section
        title={t("JavaScript errors")}
        icon={Bug}
        actions={
          groups.length ? (
            <span className="text-[13px] text-ink-2">
              {tn(groups.length, "{n} group", "{n} groups")} · {tn(total, "{n} occurrence", "{n} occurrences")}
            </span>
          ) : undefined
        }
      >
        {q.data && !q.data.meta.errors_enabled && (
          <p className="mx-2 mb-3 rounded-lg border-l-2 border-warn bg-site-soft px-3 py-2 text-sm">
            {t("Error tracking is off for this site. Turn it on in Site settings → What to collect, and add")}{" "}
            <code>data-errors="true"</code> {t("to the snippet.")}
          </p>
        )}
        {q.isLoading ? (
          <Skeleton h={160} />
        ) : !groups.length ? (
          <Empty>{t("No errors in this range.")}</Empty>
        ) : (
          <DenseTable
            label={t("Error groups")}
            minWidth={720}
            rows={groups}
            cols={[
              {
                key: "message",
                label: t("Error"),
                render: (g) => (
                  <span className="block min-w-0 max-w-[460px]">
                    <span className="block truncate font-mono text-[13px] font-medium text-bad">
                      {String(g.message)}
                    </span>
                    <span className="block truncate text-[12.5px] text-ink-2">
                      {g.source ? String(g.source).replace(/^https?:\/\/[^/]+/, "") : t("unknown source")}
                    </span>
                  </span>
                ),
              },
              {
                key: "pages",
                label: t("Pages"),
                align: "right",
                className: "t-num text-[15px]",
                render: (g) => fmt(g.pages),
              },
              {
                key: "sessions",
                label: t("Sessions"),
                align: "right",
                className: "t-num text-[15px]",
                render: (g) => fmt(g.sessions),
              },
              {
                key: "trend",
                label: t("Per day"),
                className: "w-[130px]",
                render: (g) => {
                  const daily = g.daily as unknown as
                    { n: number; day?: string; date?: string }[] | undefined;
                  return daily?.length ? (
                    <MiniChart
                      tone="bad"
                      height={28}
                      values={daily.map((d) => d.n)}
                      labels={daily.map((d) => d.day ?? d.date ?? "")}
                      unit={t("errors")}
                      className="w-[120px]"
                    />
                  ) : (
                    <span className="text-ink-3">–</span>
                  );
                },
              },
              {
                key: "last_seen",
                label: t("Last seen"),
                align: "right",
                render: (g) => (
                  <span className="block whitespace-nowrap">
                    {ago(Number(g.last_seen))}
                    <span className="block text-xs text-ink-3">
                      {t("first {when}", { when: ago(Number(g.first_seen)) })}
                    </span>
                  </span>
                ),
              },
              {
                key: "occurrences",
                label: t("Count"),
                align: "right",
                className: "t-num text-[20px] font-semibold",
                render: (g) => fmt(g.occurrences),
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

// ---------- Annotations ----------

const CATEGORIES: [string, string, string][] = [
  ["deploy", t("Deploy"), "▼"],
  ["content", t("Content"), "■"],
  ["campaign", t("Campaign"), "◆"],
  ["incident", t("Incident"), "✕"],
  ["data", t("Data quality"), "◐"],
  ["other", t("Other"), "●"],
];
/** The same icon and colour per kind as the chart's note markers. */
function NoteIcon({ category }: { category: string | null }) {
  const k = noteKind(category);
  const Icon = k.icon;
  return <Icon size={13} weight="fill" aria-hidden="true" className="shrink-0" style={{ color: k.color }} />;
}

/** Metrics a data-quality annotation can mark as not comparable across it. */
const AFFECTABLE: [string, string][] = [
  ["visitors", t("Visitors")],
  ["sessions", t("Sessions")],
  ["pageviews", t("Pageviews")],
  ["bounce_rate", t("Bounce rate")],
  ["avg_session_duration", t("Visit duration")],
  ["avg_engaged_time", t("Engaged per page")],
  ["views_per_session", t("Views per session")],
  ["conversion_rate", t("Conversion rate")],
];
const affectLabel = (m: string) => AFFECTABLE.find(([k]) => k === m)?.[1] ?? m;

function AffectsPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="min-w-0 px-2 pt-1 sm:col-span-full">
      <legend className="mb-1 text-[12.5px] font-semibold">{t("Metrics affected")}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {AFFECTABLE.map(([k, l]) => (
          <label key={k} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={value.includes(k)}
              onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))}
            />
            {l}
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink-3">
        {t(
          "Metrics whose definition or source changed at this moment. The overview shows them as not comparable across it.",
        )}
      </p>
    </fieldset>
  );
}

interface Ann {
  id: string;
  site_id: string | null;
  ts: string;
  title: string;
  body: string | null;
  url: string | null;
  category: string | null;
  affects?: string[];
  created_by: string;
}

export function AnnotationsPage() {
  const site = useSite();
  const [f, setF] = useFilters();
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = useCanWrite();
  const q = useQuery({
    queryKey: ["annlist", site, f.range],
    queryFn: () =>
      api.get<{ data: Ann[] }>(`/api/v1/sites/${site}/annotations?${rangeParams({ ...f, filters: [] })}`),
  });
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [cat, setCat] = useState("deploy");
  const [affects, setAffects] = useState<string[]>([]);
  const [edit, setEdit] = useState<Ann | null>(null);
  const [del, setDel] = useState(false);
  const [only, setOnly] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["annlist", site] });
    void qc.invalidateQueries({ queryKey: ["ann", site] });
  };
  const add = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/sites/${site}/annotations`, {
        title,
        category: cat,
        ...(cat === "data" && affects.length ? { affects } : {}),
        ...(when ? { ts: new Date(when).toISOString() } : {}),
      }),
    onSuccess: () => (setTitle(""), setWhen(""), setAffects([]), toast(t("Annotation added")), refresh()),
  });
  const save = useMutation({
    mutationFn: (a: Ann) =>
      api.patch(`/api/v1/sites/${a.site_id ?? "*"}/annotations/${a.id}`, {
        title: a.title,
        body: a.body || null,
        url: a.url || null,
        category: a.category ?? undefined,
        affects: a.category === "data" ? (a.affects ?? []) : [],
        ts: a.ts,
      }),
    onSuccess: () => (setEdit(null), toast(t("Annotation saved")), refresh()),
  });
  const remove = useMutation({
    mutationFn: (a: Ann) => api.del(`/api/v1/sites/${a.site_id ?? "*"}/annotations/${a.id}`),
    onSuccess: () => (setEdit(null), toast(t("Annotation deleted")), refresh()),
  });
  const all = q.data?.data ?? [];
  const counts = new Map<string, number>();
  for (const a of all) counts.set(a.category ?? "other", (counts.get(a.category ?? "other") ?? 0) + 1);
  const shown = all
    .filter((x) => !only || (x.category ?? "other") === only)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const localInput = (iso: string) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  return (
    <div className="flex flex-col gap-6 [&>header:first-child]:-mb-1">
      <SiteHeader site={site} />
      <Toolbar value={f} onChange={setF} showCompare={false} />
      {canWrite && (
        <Section title={t("Mark a change")}>
          <form
            className="grid gap-2 px-2 pt-1 sm:grid-cols-[minmax(0,1fr)_12rem_14rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <input
              className="input"
              placeholder={t("What changed? e.g. New pricing page")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              aria-label={t("Title")}
              maxLength={200}
            />
            <select
              className="input"
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              aria-label={t("Category")}
            >
              {CATEGORIES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <input
              className="input"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              aria-label={t("When (default now)")}
            />
            <button className="btn btn-primary" type="submit">
              {t("Add annotation")}
            </button>
            {cat === "data" && <AffectsPicker value={affects} onChange={setAffects} />}
          </form>
          <p className="mt-2 px-2 text-xs text-ink-3">
            {t(
              "Annotations appear as marks on the overview chart. Agents and the deploy script can add them too.",
            )}
          </p>
        </Section>
      )}
      <Section title={t("Timeline")}>
        <div className="mb-2 flex flex-wrap gap-1.5 px-2" role="group" aria-label={t("Category")}>
          {[
            ["", t("All"), "", all.length] as const,
            ...CATEGORIES.map(([k, l, g]) => [k, l, g, counts.get(k) ?? 0] as const),
          ].map(([k, l, g, n]) => (
            <button
              key={k}
              type="button"
              aria-pressed={only === k}
              onClick={() => setOnly(k)}
              className={`chip ${only === k ? "chip-mark font-semibold" : "hover:bg-hover"}`}
            >
              {g && <NoteIcon category={k} />}
              {l}
              <span className="text-ink-3">{n}</span>
            </button>
          ))}
        </div>
        {!shown.length ? (
          <Empty>{t("No annotations in this range.")}</Empty>
        ) : (
          <DenseTable
            label={t("Annotations")}
            minWidth={640}
            rows={shown}
            onRow={canWrite ? setEdit : undefined}
            rowLabel={canWrite ? (a) => t("Edit {name}", { name: a.title }) : undefined}
            cols={[
              {
                key: "ts",
                label: t("When"),
                render: (a) => (
                  <span className="block whitespace-nowrap">
                    <span className="font-medium">
                      {new Date(a.ts).toLocaleDateString(locale, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                    <span className="block text-xs text-ink-3">
                      {new Date(a.ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </span>
                ),
              },
              {
                key: "category",
                label: t("Category"),
                render: (a) => (
                  <span className={`chip ${a.category === "incident" ? "text-bad" : ""}`}>
                    <NoteIcon category={a.category} />
                    {CATEGORIES.find(([k]) => k === (a.category ?? "other"))?.[1] ?? t("Other")}
                  </span>
                ),
              },
              {
                key: "title",
                label: t("Change"),
                render: (a) => (
                  <span className="block max-w-[420px]">
                    <span className="block truncate font-medium">{a.title}</span>
                    {a.body && <span className="block truncate text-xs text-ink-2">{a.body}</span>}
                    {!!a.affects?.length && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {a.affects.map((m) => (
                          <span key={m} className="chip">
                            {affectLabel(m)}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: "by",
                label: t("By"),
                render: (a) => (
                  <span className="whitespace-nowrap text-ink-2">
                    {a.created_by.replace(/^(user|key|oauth):/, "")}
                  </span>
                ),
              },
              {
                key: "scope",
                label: t("Scope"),
                render: (a) => (
                  <span className="whitespace-nowrap text-ink-2">
                    {a.site_id === null ? t("All sites") : t("This site")}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Section>
      <Sheet open={!!edit} onOpenChange={(v) => !v && setEdit(null)} title={t("Edit annotation")}>
        {edit && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(edit);
            }}
          >
            <Field label={t("Title")}>
              <input
                className="input"
                value={edit.title}
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                required
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Category")}>
                <select
                  className="input"
                  value={edit.category ?? "other"}
                  onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                >
                  {CATEGORIES.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("When")}>
                <input
                  className="input"
                  type="datetime-local"
                  value={localInput(edit.ts)}
                  onChange={(e) =>
                    e.target.value && setEdit({ ...edit, ts: new Date(e.target.value).toISOString() })
                  }
                  required
                />
              </Field>
            </div>
            {edit.category === "data" && (
              <AffectsPicker value={edit.affects ?? []} onChange={(v) => setEdit({ ...edit, affects: v })} />
            )}
            <Field label={t("Note")}>
              <textarea
                className="input"
                rows={3}
                value={edit.body ?? ""}
                onChange={(e) => setEdit({ ...edit, body: e.target.value })}
              />
            </Field>
            <Field label={t("Link")} hint={t("e.g. the commit or the article")}>
              <input
                className="input"
                type="url"
                value={edit.url ?? ""}
                onChange={(e) => setEdit({ ...edit, url: e.target.value || null })}
              />
            </Field>
            {save.error && <ErrorBox error={save.error} />}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-danger mr-auto" onClick={() => setDel(true)}>
                {t("Delete annotation")}
              </button>
              <button className="btn btn-primary" type="submit">
                {t("Save changes")}
              </button>
            </div>
          </form>
        )}
        <Confirm
          open={del}
          onOpenChange={setDel}
          title={t("Delete this annotation?")}
          body={t("It disappears from every chart.")}
          confirm={t("Delete annotation")}
          onConfirm={() => edit && remove.mutate(edit)}
        />
      </Sheet>
    </div>
  );
}

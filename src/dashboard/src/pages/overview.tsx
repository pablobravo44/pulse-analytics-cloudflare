// The site view: header, range and filters, what stands out, the KPI strip driving the main chart, then the panels.
// Data: one /overview request (KPIs, every KPI's series, each panel's first tab, goals, annotations); other tabs ask
// /query; insights load after the view (docs/PERFORMANCE.md).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  BellPlus,
  Bookmark,
  Download,
  ExternalLink,
  FileText,
  Link2,
  MagnifyingGlass,
  ShareNetwork,
  Sparkles,
  Target,
  TrendingUp,
  X,
  type LucideIcon,
} from "../components/icons.tsx";
import { Popover } from "radix-ui";
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from "react";
import { HeatGrid } from "../components/Charts.tsx";
import { PageDrawer } from "../components/PageDrawer.tsx";
import { useSites } from "../components/Shell.tsx";
import { NotesMenu, noteKind, TimeChart, useNoteKinds } from "../components/TimeChart.tsx";
import { ExportSheet } from "../components/ExportSheet.tsx";
import { compareLabel as compareLabelOf, Toolbar } from "../components/Toolbar.tsx";
import {
  BarList,
  Confirm,
  CsvButton,
  DataTable,
  Delta,
  ErrorBox,
  Field,
  Section,
  Segmented,
  Sheet,
  Skeleton,
  Switch,
  Tabs,
  useToast,
} from "../components/ui.tsx";
import { DeviceIcon } from "../components/icons.tsx";
import { CountUp } from "../components/motion.tsx";
import { locale, t } from "../lib/i18n.ts";
import { api, fmt, rangeBody, rangeParams, type Filters, type Row } from "../lib/api.ts";
import { addFilter, ReadOnly, useFilters } from "../lib/state.ts";
import { useOverview, type Overview } from "../lib/overview.ts";
import { channelName, deviceName, linkableDomain } from "../lib/labels.ts";

interface QueryRes {
  rows: Row[];
  totals: Row;
  comparison: { rows: Row[]; totals: Row } | null;
}

export function useStats(
  site: string,
  f: Filters,
  body: Record<string, unknown>,
  key: unknown[] = [],
  enabled = true,
) {
  return useQuery({
    queryKey: ["q", site, f, body, ...key],
    enabled,
    queryFn: () => api.post<QueryRes>(`/api/v1/sites/${site}/query`, { ...rangeBody(f), ...body }),
    // Old numbers stay (dimmed) while new ones load, but only for the same site and the same breakdown: rows of
    // another dimension (a panel switching from Entry to Exit pages) have no value for this one and would all read
    // "(none)".
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === site && sameShape(prevQuery.queryKey[3], body)
        ? keepPreviousData(prev)
        : undefined,
  });
}

/** Two query bodies return rows of the same shape: same dimensions and metrics. */
export function sameShape(a: unknown, b: Record<string, unknown>): boolean {
  const x = (a ?? {}) as Record<string, unknown>;
  return (
    JSON.stringify(x.dimensions ?? []) === JSON.stringify(b.dimensions ?? []) &&
    JSON.stringify(x.metrics ?? []) === JSON.stringify(b.metrics ?? [])
  );
}

const WorldMap = lazy(() => import("../components/WorldMap.tsx"));

const KPIS: { m: string; label: string; invert?: boolean }[] = [
  { m: "visitors", label: t("Visitors") },
  { m: "sessions", label: t("Sessions") },
  { m: "pageviews", label: t("Pageviews") },
  { m: "bounce_rate", label: t("Bounce rate"), invert: true },
  { m: "avg_session_duration", label: t("Visit duration") },
  { m: "avg_engaged_time", label: t("Engaged per page") },
];

type Interval = "hour" | "day" | "week" | "month";

function defaultInterval(range: string): Interval {
  if (range === "today" || range === "yesterday") return "hour";
  if (range === "12mo" || range === "ytd" || range === "all") return "week";
  if (range.includes(",")) {
    const [a, b] = range.split(",");
    const days = (Date.parse(b!) - Date.parse(a!)) / 86_400_000;
    return days < 1 ? "hour" : days > 120 ? "week" : "day";
  }
  return "day";
}

/** Live visitors as a pill; the dot breathes, and beats once when the count goes up. */
export function LiveCount({ site }: { site: string }) {
  const readOnly = useContext(ReadOnly);
  const q = useQuery({
    queryKey: ["rt", site],
    queryFn: () => api.get<{ visitors: number }>(`/api/v1/sites/${site}/realtime`),
    refetchInterval: 30_000,
  });
  const prev = useRef<number | null>(null);
  const [beat, setBeat] = useState(0);
  const n = q.data?.visitors;
  useEffect(() => {
    if (n !== undefined && prev.current !== null && n > prev.current) setBeat((b) => b + 1);
    if (n !== undefined) prev.current = n;
  }, [n]);
  if (n === undefined) return null;
  const pill = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold ${n ? "bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good" : "bg-line-2 text-ink-2"}`;
  const body = (
    <>
      <span
        key={beat}
        className={`live-dot ${n ? "breathe" : "opacity-50"} ${beat ? "beat" : ""}`}
        aria-hidden="true"
      />
      {t("{n} live", { n })}
    </>
  );
  if (readOnly)
    return (
      <span className={pill} title={t("Visitors in the last 5 minutes")}>
        {body}
      </span>
    );
  return (
    <Link
      to="/sites/$site/realtime"
      params={{ site }}
      className={`${pill} hover:opacity-85`}
      title={t("Visitors in the last 5 minutes")}
    >
      {body}
    </Link>
  );
}

export function SiteHeader({ site, children }: { site: string; children?: React.ReactNode }) {
  const sites = useSites();
  const s = sites.data?.data.find((x) => x.id === site);
  const domain = linkableDomain(s?.domains);
  const labelDomain = domain ?? s?.domains[0];
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <span className="h-3.5 w-3.5 shrink-0 rounded-[4px] bg-site" aria-hidden="true" />
          <h1 className="t-title truncate" style={{ viewTransitionName: `site-${site}` }}>
            {s?.name ?? site}
          </h1>
          <LiveCount site={site} />
        </div>
        {/* The line is there before the site loads, so the page doesn't move when it does. */}
        {!labelDomain && <span className="ml-[26px] block h-5" aria-hidden="true" />}
        {domain ? (
          <a
            href={`https://${domain}`}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-[26px] inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
          >
            {domain}
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : (
          labelDomain && <span className="ml-[26px] block text-sm text-ink-2">{labelDomain}</span>
        )}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  );
}

/** A panel's rows: from the overview payload when it carries this tab, otherwise its own /query. */
function usePanelRows(
  site: string,
  f: Filters,
  preset: Row[] | undefined,
  presetLoading: boolean,
  body: Record<string, unknown>,
) {
  const q = useStats(site, f, body, [], preset === undefined && !presetLoading);
  if (preset !== undefined) return { rows: preset, isLoading: false, error: null };
  if (presetLoading) return { rows: [] as Row[], isLoading: true, error: null };
  return { rows: q.data?.rows ?? [], isLoading: q.isLoading, error: q.error };
}

type Preset = { data: Record<string, Row[]> | undefined; loading: boolean };
type Tab = {
  value: string;
  label: string;
  filters?: Filters["filters"];
  metric?: string;
  dimension?: string;
  secondary?: string;
};

const regionNames = (() => {
  try {
    return new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    return null;
  }
})();
/** Country names in the interface's language (the flag carries the code). */
function countryName(v: string | number | null): string {
  if (v === null) return t("Unknown");
  try {
    return regionNames?.of(String(v)) ?? String(v);
  } catch {
    return String(v);
  }
}
const LABELS: Record<string, (v: string | number | null) => string> = {
  country: countryName,
  referrer_host: (v) => (v === null ? t("Direct") : String(v)),
  source_name: (v) => (v === null ? t("Direct") : String(v)),
  channel: channelName,
};

/** Every row of a panel's tab in a drawer, with a search box and CSV export. */
function PanelDrawer({
  open,
  onOpenChange,
  site,
  f,
  title,
  tab,
  setF,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  site: string;
  f: Filters;
  title: string;
  tab: Tab;
  setF: (p: Partial<Filters>) => void;
}) {
  const [search, setSearch] = useState("");
  const dim = tab.dimension ?? tab.value;
  const m = tab.metric ?? "visitors";
  const q = useStats(
    site,
    f,
    {
      metrics: tab.secondary ? [m, tab.secondary] : [m],
      dimensions: [dim],
      filters: [...f.filters, ...(tab.filters ?? [])],
      compare: null,
      limit: 1000,
    },
    ["drawer"],
    open,
  );
  const label = LABELS[dim];
  const rows = (q.data?.rows ?? []).filter(
    (r) =>
      !search ||
      (label ? label(r[dim] ?? null) : String(r[dim] ?? "")).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`${title}: ${tab.label}`}
      description={t("All {n} rows for this range", { n: rows.length })}
      wide
    >
      <div className="mb-3 flex items-center gap-2">
        <label className="relative flex-1">
          <span className="sr-only">{t("Search")}</span>
          <MagnifyingGlass
            size={15}
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            className="input pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search")}
          />
        </label>
        <CsvButton rows={rows} name={`${site}-${dim}`} />
      </div>
      {q.isLoading ? (
        <Skeleton h={300} />
      ) : (
        <BarList
          rows={rows}
          dimension={dim}
          metric={m}
          secondary={tab.secondary}
          limit={1000}
          formatLabel={label}
          onSelect={(v) => {
            setF({ filters: addFilter(f.filters, dim, v) });
            onOpenChange(false);
          }}
        />
      )}
    </Sheet>
  );
}

function ExpandButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm h-7 w-7 p-0 text-ink-2"
      onClick={onClick}
      aria-label={t("Show all: {label}", { label })}
      title={t("Show all")}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
      </svg>
    </button>
  );
}

function Panel({
  site,
  f,
  setF,
  title,
  icon,
  tabs,
  preset,
  before,
  onPick,
  children,
}: {
  site: string;
  f: Filters;
  setF: (p: Partial<Filters>) => void;
  title: string;
  icon?: LucideIcon;
  tabs: Tab[];
  preset: Preset;
  before?: React.ReactNode;
  /** Replaces the click-to-filter behaviour of a tab's rows (the Pages panel opens a drawer instead). */
  onPick?: (dim: string, v: string | number | null) => void;
  children?: (tab: string) => React.ReactNode;
}) {
  const [tab, setTab] = useState(tabs[0]!.value);
  const [all, setAll] = useState(false);
  const tb = tabs.find((x) => x.value === tab)!;
  const dim = tb.dimension ?? tb.value;
  const m = tb.metric ?? "visitors";
  const first = tab === tabs[0]!.value && !tb.filters;
  const custom = children?.(tab);
  const q = usePanelRows(
    site,
    f,
    custom ? [] : first ? preset.data?.[dim] : undefined,
    !custom && first && preset.loading,
    {
      metrics: tb.secondary ? [m, tb.secondary] : [m],
      dimensions: [dim],
      filters: [...f.filters, ...(tb.filters ?? [])],
      compare: null,
      limit: 100,
    },
  );
  return (
    <Section
      title={title}
      icon={icon}
      actions={
        <>
          {tabs.length > 1 && <Tabs label={title} value={tab} options={tabs} onChange={setTab} />}
          {!custom && <ExpandButton onClick={() => setAll(true)} label={`${title}, ${tb.label}`} />}
        </>
      }
    >
      {before}
      {custom ??
        (q.error ? (
          <ErrorBox error={q.error} />
        ) : q.isLoading ? (
          <Skeleton h={220} />
        ) : (
          <BarList
            rows={q.rows}
            dimension={dim}
            metric={m}
            secondary={tb.secondary}
            formatLabel={LABELS[dim]}
            onSelect={(v) => (onPick ? onPick(dim, v) : setF({ filters: addFilter(f.filters, dim, v) }))}
          />
        ))}
      {!custom && (
        <PanelDrawer open={all} onOpenChange={setAll} site={site} f={f} title={title} tab={tb} setF={setF} />
      )}
    </Section>
  );
}

function InstallBanner({ site }: { site: string }) {
  const sites = useSites();
  const s = sites.data?.data.find((x) => x.id === site);
  if (!s || s.data_range.last_event) return null;
  return (
    <div className="panel mb-5 flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
      <span>
        {t(
          "No visits have arrived for this site yet. Add the snippet to its pages, then check the installation.",
        )}
      </span>
      <Link to="/sites/$site/settings" params={{ site }} className="btn btn-sm">
        {t("Check installation")}
      </Link>
    </div>
  );
}

/** Device split as one stacked bar (the site's colour in three strengths, 2 px gaps) with a labelled legend. */
function DeviceSplit({ rows }: { rows: Row[] }) {
  const total = rows.reduce((a, r) => a + Number(r.visitors ?? 0), 0);
  if (!total) return null;
  const shades = [100, 55, 30];
  return (
    <div className="mb-3 px-2">
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
        {rows.slice(0, 3).map((r, i) => (
          <span
            key={String(r.device)}
            style={{
              width: `${(100 * Number(r.visitors)) / total}%`,
              background: `color-mix(in oklab, var(--site) ${shades[i]}%, var(--line-2))`,
            }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
        {rows.slice(0, 3).map((r) => (
          <li key={String(r.device)} className="flex items-center gap-1.5">
            <DeviceIcon value={String(r.device)} size={14} />
            <span>{deviceName(r.device)}</span>
            <strong className="font-semibold text-ink">
              {Math.round((100 * Number(r.visitors)) / total)}%
            </strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Conversion rate as a ring (the site's colour on a faint track). */
function Ring({ pct }: { pct: number | null }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true" className="shrink-0 -rotate-90">
      <circle cx="17" cy="17" r={r} fill="none" stroke="var(--line-2)" strokeWidth="4" />
      <circle
        cx="17"
        cy="17"
        r={r}
        fill="none"
        stroke="var(--site)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`}
      />
    </svg>
  );
}

function GoalsList({ ov, site, currency }: { ov: Overview | undefined; site: string; currency?: string }) {
  if (!ov) return <Skeleton h={160} />;
  const rev = ov.kpis.revenue;
  if (!ov.goals.length && !Number(rev?.value ?? 0))
    return (
      <p className="px-2 py-6 text-sm text-ink-2">
        {t("No goals yet.")}{" "}
        <Link to="/sites/$site/goals" params={{ site }} className="link">
          {t("Add a goal")}
        </Link>{" "}
        {t("to see conversions here.")}
      </p>
    );
  return (
    <ul className="divide-y divide-line">
      {ov.goals.map((g) => (
        <li key={g.id} className="flex items-center gap-3 px-2 py-3">
          <Ring pct={g.conversion_rate} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{g.name}</div>
            <div className="text-[12.5px] text-ink-2">{t("{n} conversions", { n: fmt(g.conversions) })}</div>
          </div>
          <span className="t-num text-[22px] font-bold">
            {g.conversion_rate === null ? "–" : `${fmt(g.conversion_rate)}%`}
          </span>
          <Delta pct={g.change_pct} />
        </li>
      ))}
      {Number(rev?.value ?? 0) > 0 && (
        <li className="flex items-center gap-3 px-2 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{t("Revenue")}</div>
            <div className="text-[12.5px] text-ink-2">{t("from events with a revenue property")}</div>
          </div>
          <span className="t-num text-[22px] font-bold">
            {currency ? `${currency} ` : ""}
            {fmt(rev!.value, "revenue")}
          </span>
          <Delta pct={rev!.change_pct} note={rev!.not_comparable} />
        </li>
      )}
    </ul>
  );
}

const INSIGHT_ICONS: Record<string, LucideIcon> = {
  traffic: TrendingUp,
  page: FileText,
  referrer: Link2,
  vitals: Sparkles,
  goal: Target,
};

/** A finding in the interface's language, from its code and values (the API's English text when the code is new). */
function insightText(i: {
  code?: string;
  params?: Record<string, string | number>;
  title: string;
  detail: string;
}) {
  const p = i.params ?? {};
  const n = (k: string) => fmt(Number(p[k] ?? 0));
  const vars = { ...p, current: n("current"), previous: n("previous"), change: n("change") } as Record<
    string,
    string | number
  >;
  switch (i.code) {
    case "traffic_up":
      return {
        title: t("Visitors up {pct}%", vars),
        detail: t("{current} visitors against {previous} in the previous period.", vars),
      };
    case "traffic_down":
      return {
        title: t("Visitors down {pct}%", vars),
        detail: t("{current} visitors against {previous} in the previous period.", vars),
      };
    case "page_gaining":
      return {
        title: t("{page} is gaining", vars),
        detail: t("+{change} visitors ({previous} → {current}).", vars),
      };
    case "page_losing":
      return {
        title: t("{page} is losing visitors", vars),
        detail: t("{change} visitors ({previous} → {current}).", vars),
      };
    case "new_referrer":
      return {
        title: t("New referrer: {host}", vars),
        detail: t("{current} visitors from a site that sent none in the previous period.", vars),
      };
    case "lcp_slower":
      return {
        title: t("Pages got slower"),
        detail: t("LCP p75 is {current} ms, up from {previous} ms.", vars),
      };
    case "inp_slow":
      return {
        title: t("Interactions feel slow"),
        detail: t("INP p75 is {current} ms (poor above 500 ms).", vars),
      };
    case "goal_up":
      return {
        title: t("{goal} up {pct}%", vars),
        detail: t("{current} conversions against {previous}.", vars),
      };
    case "goal_down":
      return {
        title: t("{goal} down {pct}%", vars),
        detail: t("{current} conversions against {previous}.", vars),
      };
    default:
      return { title: i.title, detail: i.detail };
  }
}

/** What stands out, as up to three cards; loads after the main view (it reads more), never in front of it. */
function Insights({ site, f, ready }: { site: string; f: Filters; ready: boolean }) {
  const q = useQuery({
    queryKey: ["insights", site, f],
    enabled: ready,
    queryFn: () =>
      api.get<{
        insights: {
          kind: string;
          code?: string;
          params?: Record<string, string | number>;
          title: string;
          detail: string;
          numbers?: { current?: number; previous?: number };
        }[];
      }>(`/api/v1/sites/${site}/insights?${rangeParams(f)}`),
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === site ? keepPreviousData(prev) : undefined,
  });
  const list = (q.data?.insights ?? []).slice(0, 3);
  // A slot of fixed height, so the view below never jumps when the findings arrive (they load after it).
  if (!q.data)
    return (
      <div className="mt-4 grid min-h-[66px] gap-3 md:grid-cols-3" aria-hidden="true">
        <div className="skeleton h-[66px]" />
        <div className="skeleton hidden h-[66px] md:block" />
        <div className="skeleton hidden h-[66px] md:block" />
      </div>
    );
  if (!list.length)
    return (
      <p className="panel mt-4 flex min-h-[66px] items-center gap-3 px-4 text-sm text-ink-2">
        <Sparkles size={16} aria-hidden="true" className="text-ink-3" />{" "}
        {t("Nothing unusual in this range compared with the one before.")}
      </p>
    );
  return (
    <ul
      className={`mt-4 grid min-h-[66px] gap-3 ${list.length === 1 ? "" : list.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3"}`}
      aria-label={t("What stands out")}
    >
      {list.map((i, n) => {
        const down =
          i.numbers?.current !== undefined &&
          i.numbers?.previous !== undefined &&
          i.numbers.current < i.numbers.previous;
        const Icon = INSIGHT_ICONS[i.kind] ?? Sparkles;
        const tone = i.kind === "vitals" || down ? "bad" : i.kind === "referrer" ? "site" : "good";
        return (
          <li key={n} className="panel flex items-start gap-3 px-4 py-3">
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-[9px] ${tone === "bad" ? "bg-[color-mix(in_oklab,var(--bad)_12%,transparent)] text-bad" : tone === "good" ? "bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good" : "bg-site-tint text-site"}`}
              aria-hidden="true"
            >
              <Icon size={16} className={down ? "-scale-y-100" : ""} />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-semibold">{insightText(i).title}</span>
              <span className="block text-[12.5px] text-ink-2">{insightText(i).detail}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function OverviewPage({ siteId }: { siteId?: string } = {}) {
  const params = useParams({ strict: false }) as { site: string };
  const site = siteId ?? params.site;
  const readOnly = useContext(ReadOnly);
  const [f, setF] = useFilters();
  const [metric, setMetric] = useState("visitors");
  const [ivPick, setIvPick] = useState<Interval | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [pagePick, setPagePick] = useState<{ dim: string; path: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const iv = ivPick ?? defaultInterval(f.range);
  useEffect(() => setIvPick(null), [f.range]);
  // One request for the whole view (KPIs, every KPI's series, each panel's first tab, goals, annotations).
  const ov = useOverview(site, f, iv);
  const updating = ov.isPlaceholderData;
  const preset: Preset = { data: ov.data?.breakdowns, loading: ov.isLoading };
  const totals = ov.data?.kpis;
  const siteInfo = useSites().data?.data.find((s) => s.id === site);
  const currency = siteInfo?.settings.revenue_currency;
  // Six tiles, always: a tile that appeared with the data would re-flow the strip. Revenue is in the Goals panel.
  const kpis = KPIS;
  const label = kpis.find((k) => k.m === metric)?.label ?? metric;
  const compareLabel = compareLabelOf(f.compare).replace(/^vs /, "");
  const series = ov.data?.timeseries.series ?? [];
  const xKey = (ov.data?.timeseries.interval ?? iv) as "hour" | "day" | "datehour" | "week" | "month";
  // Little traffic reads better as bars than as a flat line: under ~5 visitors a day on average.
  const days = Math.max(1, xKey === "day" ? series.length : 1);
  const bars = metric === "visitors" && xKey === "day" && Number(totals?.visitors?.value ?? 0) / days < 5;
  const empty = !!ov.data && !series.some((r) => Number(r.visitors ?? 0) > 0) && !f.filters.length;
  const [hiddenNotes, setHiddenNotes] = useNoteKinds();
  const allNotes = ov.data?.annotations;
  const notes = useMemo(
    () => (allNotes ?? []).filter((a) => !hiddenNotes.includes(noteKind(a.category).id)),
    [allNotes, hiddenNotes],
  );
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ data: { email: string; role: string } }>("/auth/me"),
    retry: false,
    staleTime: 300_000,
    enabled: !readOnly,
  });
  const canEdit = !readOnly && me.data?.data.role !== "viewer";
  return (
    <div className="w-full">
      <SiteHeader site={site}>
        {!readOnly && (
          <>
            {canEdit && (
              <Link
                to={"/sites/$site/settings" as never}
                params={{ site } as never}
                hash="shares"
                className="btn btn-sm"
              >
                <ShareNetwork size={15} aria-hidden="true" /> {t("Share")}
              </Link>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setExporting(true)}>
              <Download size={15} aria-hidden="true" /> {t("Export")}
            </button>
            {canEdit && (
              <Link
                to={"/sites/$site/settings" as never}
                params={{ site } as never}
                search={(f.filters.length ? { f: JSON.stringify(f.filters) } : {}) as never}
                hash="new-alert"
                className="btn btn-sm h-[30px] w-[34px] p-0"
                aria-label={t("Alert me when traffic for this view crosses a line")}
                title={t("Alert me when…")}
              >
                <BellPlus size={16} aria-hidden="true" />
              </Link>
            )}
          </>
        )}
      </SiteHeader>
      {!readOnly && <InstallBanner site={site} />}
      {!readOnly && <ExportSheet site={site} f={f} open={exporting} onOpenChange={setExporting} />}
      <Toolbar value={f} onChange={setF} />
      <Views site={site} f={f} setF={setF} />
      {ov.error && <ErrorBox error={ov.error} />}
      <Insights site={site} f={f} ready={!!ov.data && !updating} />

      <div className={`updating-host ${updating ? "is-updating" : ""}`} aria-busy={updating}>
        <section className="panel mt-4 overflow-hidden" aria-label={t("Key numbers and chart")}>
          <div
            role="radiogroup"
            aria-label={t("Metric shown in the chart")}
            className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto border-b border-line lg:grid lg:grid-cols-6"
          >
            {kpis.map((k) => {
              const active = metric === k.m;
              const kt = totals?.[k.m];
              return (
                <button
                  key={k.m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setMetric(k.m)}
                  className={`relative flex min-w-[148px] shrink-0 snap-start flex-col items-start gap-1 px-4 pb-3.5 pt-3.5 text-left transition-colors [&:not(:last-child)]:border-r [&:not(:last-child)]:border-line lg:min-w-0 ${active ? "" : "hover:bg-hover"}`}
                >
                  <span
                    className={`truncate text-[13px] ${active ? "font-semibold text-ink" : "text-ink-2"}`}
                  >
                    {k.label}
                  </span>
                  {ov.isLoading ? (
                    <>
                      <Skeleton h={38} w={90} />
                      {f.compare && <Skeleton h={22} w={56} />}
                    </>
                  ) : (
                    <span className="t-readout">
                      <CountUp value={kt?.value} format={(v) => fmt(v, k.m)} />
                    </span>
                  )}
                  {f.compare && kt && (
                    <Delta pct={kt.change_pct} invert={k.invert} note={kt.not_comparable} />
                  )}
                  {active && (
                    <span
                      className="absolute inset-x-3 bottom-0 h-[3px] rounded-t-full bg-site"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
          <div className="px-3 pb-3 pt-3 sm:px-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
              <span className="flex items-center gap-2">
                <NotesMenu annotations={allNotes ?? []} hidden={hiddenNotes} onChange={setHiddenNotes} />
              </span>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                <Segmented
                  label={t("Interval")}
                  value={iv}
                  onChange={(v) => setIvPick(v)}
                  options={[
                    { value: "hour", label: t("Hours") },
                    { value: "day", label: t("Days") },
                    { value: "week", label: t("Weeks") },
                    { value: "month", label: t("Months") },
                  ]}
                />
                <span className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={asTable}
                    onClick={() => setAsTable((v) => !v)}
                  >
                    {asTable ? t("Chart") : t("Table")}
                  </button>
                  <CsvButton rows={series} name={`${site}-${metric}-${iv}`} />
                </span>
              </div>
            </div>
            {ov.isLoading ? (
              <Skeleton h={280} />
            ) : empty ? (
              <div className="grid h-[240px] place-items-center text-center text-sm text-ink-2">
                <div>
                  <p className="font-semibold text-ink">{t("No visits in this range")}</p>
                  <p>{t("Pick a longer range, or check the installation if the site is new.")}</p>
                </div>
              </div>
            ) : asTable ? (
              <div className="max-h-[340px] overflow-y-auto">
                <DataTable
                  rows={series.map((r, i) => ({
                    ...r,
                    previous: f.compare ? (ov.data!.timeseries.comparison?.[i]?.[metric] ?? null) : null,
                  }))}
                  columns={[
                    {
                      key: xKey,
                      label:
                        xKey === "hour" || xKey === "datehour"
                          ? t("Hour")
                          : xKey === "week"
                            ? t("Week of")
                            : xKey === "month"
                              ? t("Month")
                              : t("Day"),
                    },
                    { key: metric, label, metric },
                    ...(f.compare
                      ? [
                          {
                            key: "previous",
                            label: compareLabel.replace(/^\w/, (c) => c.toUpperCase()),
                            metric,
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            ) : (
              <TimeChart
                rows={series}
                compareRows={f.compare ? ov.data?.timeseries.comparison : null}
                compareLabel={compareLabel}
                xKey={xKey}
                metric={metric}
                label={label}
                annotations={notes}
                bars={bars}
                invert={kpis.find((k) => k.m === metric)?.invert}
              />
            )}
          </div>
        </section>

        <div className="mt-4 grid gap-4 lg:grid-cols-2 3xl:grid-cols-3">
          <Panel
            preset={preset}
            site={site}
            f={f}
            setF={setF}
            title={t("Pages")}
            onPick={(dim, v) => {
              if (typeof v === "string" && v.startsWith("/") && dim !== "search_term")
                setPagePick({ dim, path: v });
              else setF({ filters: addFilter(f.filters, dim, v) });
            }}
            tabs={[
              { value: "page", label: t("Top"), metric: "pageviews", secondary: "visitors" },
              { value: "entry_page", label: t("Entry"), metric: "sessions" },
              { value: "exit_page", label: t("Exit"), metric: "sessions" },
              {
                value: "search_term",
                label: t("Search"),
                metric: "pageviews",
                filters: [["is_not", "search_term", ["(none)"]]],
              },
            ]}
          />
          <Panel
            preset={preset}
            site={site}
            f={f}
            setF={setF}
            title={t("Sources")}
            tabs={[
              { value: "referrer_host", label: t("Referrers") },
              { value: "channel", label: t("Channels") },
              {
                value: "utm_campaign",
                label: t("Campaigns"),
                filters: [["is_not", "utm_campaign", ["(none)"]]],
              },
              {
                value: "ai",
                dimension: "referrer_host",
                label: t("AI"),
                filters: [["is", "channel", ["AI Assistants"]]],
              },
            ]}
          />
          <Locations preset={preset} site={site} f={f} setF={setF} />
          <Panel
            preset={preset}
            site={site}
            f={f}
            setF={setF}
            title={t("Technology")}
            before={<DeviceSplit rows={ov.data?.breakdowns.device ?? []} />}
            tabs={[
              { value: "browser", label: t("Browsers") },
              { value: "os", label: t("OS") },
              { value: "screen", label: t("Screens") },
              { value: "language", label: t("Languages") },
            ]}
          />
          <Panel
            preset={preset}
            site={site}
            f={f}
            setF={setF}
            title={t("Goals")}
            tabs={[
              { value: "goals", label: t("Goals") },
              { value: "event_name", label: t("Events"), metric: "events", secondary: "visitors" },
              { value: "outbound_url", label: t("Outbound"), metric: "sessions" },
              {
                value: "404",
                dimension: "event_prop:path",
                label: t("404s"),
                metric: "events",
                filters: [["is", "event_name", ["404"]]],
              },
            ]}
          >
            {(tab) => (tab === "goals" ? <GoalsList ov={ov.data} site={site} currency={currency} /> : null)}
          </Panel>
          <WhenTheyCome preset={preset} site={site} f={f} />
        </div>
      </div>
      <PageDrawer
        site={site}
        f={f}
        path={pagePick?.path ?? null}
        domain={linkableDomain(siteInfo?.domains)}
        onClose={() => setPagePick(null)}
        onFilter={(path) => {
          setF({ filters: addFilter(f.filters, pagePick?.dim ?? "page", path) });
          setPagePick(null);
        }}
      />
    </div>
  );
}

function Locations({
  site,
  f,
  setF,
  preset,
}: {
  site: string;
  f: Filters;
  setF: (p: Partial<Filters>) => void;
  preset: Preset;
}) {
  const [tab, setTab] = useState<"country" | "map" | "region" | "city">("country");
  const [all, setAll] = useState(false);
  const dim = tab === "map" ? "country" : tab;
  const first = tab === "country";
  const q = usePanelRows(site, f, first ? preset.data?.country : undefined, first && preset.loading, {
    metrics: ["visitors"],
    dimensions: [dim],
    compare: null,
    limit: tab === "map" ? 250 : 100,
  });
  return (
    <Section
      title={t("Locations")}
      actions={
        <>
          <Tabs
            label={t("Locations")}
            value={tab}
            onChange={setTab}
            options={[
              { value: "country", label: t("Countries") },
              { value: "region", label: t("Regions") },
              { value: "city", label: t("Cities") },
              { value: "map", label: t("Map") },
            ]}
          />
          {tab !== "map" && (
            <ExpandButton onClick={() => setAll(true)} label={t("Locations, {tab}", { tab })} />
          )}
        </>
      }
    >
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : q.isLoading ? (
        <Skeleton h={220} />
      ) : tab === "map" ? (
        <Suspense fallback={<Skeleton h={220} />}>
          <WorldMap
            rows={q.rows}
            onSelect={(code) => setF({ filters: addFilter(f.filters, "country", code) })}
          />
        </Suspense>
      ) : (
        <BarList
          rows={q.rows}
          dimension={dim}
          metric="visitors"
          formatLabel={LABELS[dim]}
          onSelect={(v) => setF({ filters: addFilter(f.filters, dim, v) })}
        />
      )}
      <PanelDrawer
        open={all}
        onOpenChange={setAll}
        site={site}
        f={f}
        title={t("Locations")}
        tab={{
          value: dim,
          label: tab === "country" ? t("Countries") : tab === "region" ? t("Regions") : t("Cities"),
        }}
        setF={setF}
      />
    </Section>
  );
}

function WhenTheyCome({ site, f, preset }: { site: string; f: Filters; preset: Preset }) {
  const q = usePanelRows(site, f, preset.data?.weekday_hour, preset.loading, {
    metrics: ["visitors"],
    dimensions: ["weekday", "hour"],
    compare: null,
    limit: 200,
  });
  return (
    <Section title={t("When visitors come")}>
      {q.isLoading ? (
        <Skeleton h={180} />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <HeatGrid rows={q.rows} />
      )}
    </Section>
  );
}

interface View {
  id: string;
  name: string;
  filters: Filters["filters"];
  date_range: string | null;
  compare: string | null;
  pinned: boolean;
}

function Views({ site, f, setF }: { site: string; f: Filters; setF: (p: Partial<Filters>) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const readOnly = useContext(ReadOnly);
  const views = useQuery({
    queryKey: ["views", site],
    queryFn: () => api.get<{ data: View[] }>(`/api/v1/sites/${site}/views`),
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [withRange, setWithRange] = useState(false);
  const [del, setDel] = useState<View | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/sites/${site}/views`, {
        name,
        filters: f.filters,
        pinned: true,
        ...(withRange ? { date_range: f.range, compare: f.compare ?? "none" } : {}),
      }),
    onSuccess: () => {
      toast(t("View saved"));
      setOpen(false);
      setName("");
      void qc.invalidateQueries({ queryKey: ["views", site] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/sites/${site}/views/${id}`),
    onSuccess: () => (toast(t("View deleted")), qc.invalidateQueries({ queryKey: ["views", site] })),
  });
  const list = views.data?.data ?? [];
  const active = (v: View) => JSON.stringify(v.filters) === JSON.stringify(f.filters);
  if (!list.length && !f.filters.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {list.length > 0 && <span className="mr-1 text-xs text-ink-3">{t("Views")}</span>}
      {list.map((v) => (
        <span key={v.id} className={`chip group ${active(v) ? "chip-mark font-semibold" : ""}`}>
          <button
            type="button"
            onClick={() =>
              setF({
                filters: v.filters,
                ...(v.date_range ? { range: v.date_range } : {}),
                ...(v.compare
                  ? { compare: v.compare === "none" ? null : (v.compare as Filters["compare"]) }
                  : {}),
              })
            }
          >
            {v.name}
          </button>
          {!readOnly && (
            <button
              type="button"
              aria-label={t("Delete view {name}", { name: v.name })}
              className="rounded-[4px] p-0.5 text-ink-3 opacity-0 hover:bg-bar hover:text-ink focus:opacity-100 group-hover:opacity-100"
              onClick={() => setDel(v)}
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      {f.filters.length > 0 && !list.some(active) && !readOnly && (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger className="btn btn-quiet btn-sm text-ink-2">
            <Bookmark size={13} aria-hidden="true" /> {t("Save as view")}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              className="anim-pop floating z-40 w-[min(320px,calc(100vw-32px))] p-4"
            >
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate();
                }}
              >
                <Field label={t("Name")}>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("e.g. Spain, mobile")}
                    required
                    autoFocus
                  />
                </Field>
                <Switch checked={withRange} onChange={setWithRange} label={t("Also save the date range")} />
                <button className="btn btn-primary" type="submit" disabled={!name.trim() || save.isPending}>
                  {t("Save view")}
                </button>
                {save.error && <ErrorBox error={save.error} />}
              </form>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
      <Confirm
        open={!!del}
        onOpenChange={(v) => !v && setDel(null)}
        title={t("Delete the view “{name}”?", { name: del?.name ?? "" })}
        body={t("It's removed for everyone who can see this site.")}
        confirm={t("Delete view")}
        onConfirm={() => del && remove.mutate(del.id)}
      />
    </div>
  );
}

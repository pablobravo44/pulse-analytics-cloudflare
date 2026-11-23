// One page in a drawer: its numbers against the comparison, where its visitors come from, what they did before and
// after, and how fast it loads. Data: GET /pages/report (one preset over the query engine).
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "./icons.tsx";
import { BarList, Delta, ErrorBox, Section, Sheet, Skeleton } from "./ui.tsx";
import { api, fmt, rangeParams, type Filters, type Row } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";
import { channelName } from "../lib/labels.ts";

type Totals = Record<string, number | null>;

interface Step {
  path: string;
  count: number;
  share_pct: number;
}

interface PageReport {
  path: string;
  totals: Totals;
  comparison: { totals: Totals } | null;
  as_landing_page: { sessions: number; bounce_rate: number | null } | null;
  channels: Row[];
  devices: Row[];
  next_pages: Step[];
  previous_pages: Step[];
  vitals_p75: Totals;
}

const KPIS: { m: string; label: string; invert?: boolean }[] = [
  { m: "pageviews", label: t("Pageviews") },
  { m: "visitors", label: t("Visitors") },
  { m: "entries", label: t("Entries") },
  { m: "exits", label: t("Exits"), invert: true },
  { m: "exit_rate", label: t("Exit rate"), invert: true },
  { m: "avg_engaged_time", label: t("Engaged time") },
  { m: "scroll_depth", label: t("Scroll depth") },
];

function pct(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || !prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

type Verdict = { text: string; cls: string };
function verdict(v: number | null | undefined, good: number, poor: number): Verdict | null {
  if (v === null || v === undefined) return null;
  return v <= good
    ? { text: t("good"), cls: "delta-up" }
    : v <= poor
      ? { text: t("needs work"), cls: "text-warn bg-[color-mix(in_oklab,var(--warn)_13%,transparent)]" }
      : { text: t("poor"), cls: "delta-down" };
}

const VITALS: { m: string; label: string; good: number; poor: number }[] = [
  { m: "lcp_p75", label: t("Loading (LCP)"), good: 2500, poor: 4000 },
  { m: "inp_p75", label: t("Responsiveness (INP)"), good: 200, poor: 500 },
  { m: "cls_p75", label: t("Layout shift (CLS)"), good: 0.1, poor: 0.25 },
];

function stepLabel(p: string): string {
  return p === "(exit)" ? t("Left the site") : p === "(entrance)" ? t("Arrived here directly") : p;
}

function Steps({ rows, empty }: { rows: Step[]; empty: string }) {
  if (!rows.length) return <p className="px-2 py-3 text-sm text-ink-2">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <ul className="flex flex-col">
      {rows.slice(0, 6).map((r) => (
        <li key={r.path} className="relative flex items-center gap-3 rounded-[6px] px-2 py-1.5 text-sm">
          <span
            className="absolute inset-y-0.5 left-0 rounded-[6px] bg-site-tint"
            style={{ width: `${(r.count / max) * 100}%` }}
            aria-hidden="true"
          />
          <span className="relative min-w-0 flex-1 truncate" title={r.path}>
            {stepLabel(r.path)}
          </span>
          <span className="t-num relative text-ink-2">{fmt(r.count)}</span>
          <span className="t-num relative w-12 text-right text-ink-3">{fmt(r.share_pct)}%</span>
        </li>
      ))}
    </ul>
  );
}

export function PageDrawer({
  site,
  f,
  path,
  domain,
  onClose,
  onFilter,
}: {
  site: string;
  f: Filters;
  path: string | null;
  domain?: string;
  onClose: () => void;
  onFilter: (path: string) => void;
}) {
  const q = useQuery({
    queryKey: ["page-report", site, path, f.range, f.compare, f.filters],
    enabled: !!path,
    queryFn: () =>
      api.get<PageReport>(
        `/api/v1/sites/${site}/pages/report?${rangeParams(f)}&path=${encodeURIComponent(path ?? "")}`,
      ),
  });
  const d = q.data;
  const href = domain && path ? `https://${domain}${path}` : null;
  return (
    <Sheet
      open={!!path}
      onOpenChange={(v) => !v && onClose()}
      title={<span className="block truncate">{path}</span>}
      description={t("This page in the selected range")}
      wide
      footer={
        <>
          {href && (
            <a href={href} target="_blank" rel="noreferrer noopener" className="btn mr-auto">
              <ExternalLink size={15} aria-hidden="true" /> {t("Open the page")}
            </a>
          )}
          <button type="button" className="btn btn-primary" onClick={() => path && onFilter(path)}>
            {t("Filter by this page")}
          </button>
        </>
      }
    >
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : !d ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton h={96} />
          <Skeleton h={180} />
          <Skeleton h={140} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-4">
            {KPIS.map((k) => (
              <div key={k.m} className="bg-sheet px-3 py-3">
                <dt className="truncate text-[12.5px] text-ink-2">{k.label}</dt>
                <dd className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="t-num text-[22px] font-bold leading-7">{fmt(d.totals[k.m], k.m)}</span>
                  {d.comparison && (
                    <Delta pct={pct(d.totals[k.m], d.comparison.totals[k.m])} invert={k.invert} />
                  )}
                </dd>
              </div>
            ))}
            {d.as_landing_page && (
              <div className="bg-sheet px-3 py-3">
                <dt className="truncate text-[12.5px] text-ink-2">{t("Entry bounce rate")}</dt>
                <dd className="t-num mt-0.5 text-[22px] font-bold leading-7">
                  {fmt(d.as_landing_page.bounce_rate, "bounce_rate")}
                </dd>
              </div>
            )}
          </dl>
          <div className="grid gap-4 md:grid-cols-2">
            <Section title={t("Sources")}>
              <BarList rows={d.channels} dimension="channel" metric="visitors" formatLabel={channelName} />
            </Section>
            <Section title={t("Devices")}>
              <BarList rows={d.devices} dimension="device" metric="visitors" />
            </Section>
          </div>
          <Section title={t("Before and after this page")}>
            <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:gap-2">
              <div className="min-w-0">
                <h3 className="px-2 pb-1 text-xs font-semibold text-ink-3">{t("Visitors came from")}</h3>
                <Steps rows={d.previous_pages} empty={t("No data for this range.")} />
              </div>
              <div
                className="grid place-items-center px-1 text-sm font-semibold max-md:hidden"
                aria-hidden="true"
              >
                →
              </div>
              <div className="min-w-0">
                <h3 className="px-2 pb-1 text-xs font-semibold text-ink-3">{t("Visitors went to")}</h3>
                <Steps rows={d.next_pages} empty={t("No data for this range.")} />
              </div>
            </div>
          </Section>
          <Section title={t("Speed")}>
            <ul className="grid gap-px sm:grid-cols-3">
              {VITALS.map((v) => {
                const val = d.vitals_p75[v.m];
                const vd = verdict(val, v.good, v.poor);
                return (
                  <li key={v.m} className="px-2 py-2">
                    <div className="text-[12.5px] text-ink-2">{v.label}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="t-num text-[18px] font-bold">{fmt(val, v.m)}</span>
                      {vd ? (
                        <span className={`delta ${vd.cls}`}>{vd.text}</span>
                      ) : (
                        <span className="text-xs text-ink-3">{t("not enough data")}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Section>
        </div>
      )}
    </Sheet>
  );
}

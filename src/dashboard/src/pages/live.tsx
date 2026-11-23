// Who is on the sites now. The global page (/live) shows every site in its colour; a site's Realtime page is the same
// view filtered to it. One window for everything: a visit is "here now" when it had a hit in the last 5 minutes;
// the feed lists the last 30 minutes, newest first, active visits first marked by a breathing dot.
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useSites } from "../components/Shell.tsx";
import { DeviceIcon, Flag, SourceIcon } from "../components/icons.tsx";
import { CountUp } from "../components/motion.tsx";
import { ago, Empty, ErrorBox, Section, Skeleton } from "../components/ui.tsx";
import { api, fmt } from "../lib/api.ts";
import { t, tn } from "../lib/i18n.ts";
import { channelName, countryName, deviceName } from "../lib/labels.ts";
import { SiteHeader } from "./overview.tsx";

const WorldMap = lazy(() => import("../components/WorldMap.tsx"));

interface Visit {
  site?: string;
  started_at: string;
  last_at: string;
  active: boolean;
  pages: string[];
  pageviews: number;
  source: string | null;
  channel: string | null;
  country: string | null;
  device: string | null;
}

interface Live {
  per_site: { site: string; visitors: number; hits_per_minute: number[] }[];
  visits: Visit[];
  countries: { country: string; visitors: number }[];
}

interface Realtime {
  visitors: number;
  visits: Visit[];
  hits_per_minute: { minute_ago: number; hits: number }[];
  pages: { page: string; visitors: number }[];
}

/** Hits per minute for the last 30 minutes as small bars (the newest on the right). */
function Minutes({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  return (
    <div
      className="flex h-10 items-end gap-[2px]"
      role="img"
      aria-label={t("{label}: {n} hits in the last 30 minutes", {
        label,
        n: values.reduce((a, b) => a + b, 0),
      })}
    >
      {values.map((v, i) => (
        <span
          key={i}
          className="flex-1 rounded-t-[2px] bg-site"
          style={{
            height: `${Math.max(v ? 8 : 3, (v / max) * 100)}%`,
            opacity: v ? 0.35 + 0.65 * (i / values.length) : 0.15,
          }}
        />
      ))}
    </div>
  );
}

function VisitRow({ v, color, name }: { v: Visit; color?: string; name?: string }) {
  return (
    <li data-site={color} className="flex items-start gap-3 px-2 py-2.5">
      <span className="mt-1.5 w-2 shrink-0" aria-hidden="true">
        {v.active ? (
          <span className="live-dot breathe block" />
        ) : (
          <span className="block h-2 w-2 rounded-full bg-line-strong" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
          {name && (
            <span className="flex items-center gap-1.5 font-semibold">
              <span className="swatch" aria-hidden="true" />
              {name}
            </span>
          )}
          <span className="flex items-center gap-1 text-ink-2">
            <SourceIcon value={v.source ?? v.channel} size={14} />
            {v.source ?? channelName(v.channel)}
          </span>
          {v.country && (
            <span className="flex items-center gap-1 text-ink-2">
              <Flag code={v.country} /> {countryName(v.country)}
            </span>
          )}
          {v.device && (
            <span className="flex items-center gap-1 text-ink-2">
              <DeviceIcon value={v.device} size={14} /> <span>{deviceName(v.device)}</span>
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[13.5px]" title={v.pages.join(" → ")}>
          {v.pages.length ? v.pages.join(" → ") : <span className="text-ink-3">{t("no pages yet")}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right text-[12px] text-ink-2">
        <div className={v.active ? "font-semibold text-good" : ""}>
          {v.active ? t("here now") : ago(v.last_at)}
        </div>
        <div>{tn(v.pageviews, "{n} page", "{n} pages")}</div>
      </div>
    </li>
  );
}

function Feed({ visits, sites }: { visits: Visit[]; sites?: Map<string, { name: string; color?: string }> }) {
  if (!visits.length) return <Empty>{t("No visits in the last 30 minutes.")}</Empty>;
  return (
    <ul className="divide-y divide-line" aria-live="polite" aria-relevant="additions">
      {visits.map((v, i) => (
        <VisitRow
          key={`${v.site ?? ""}-${v.started_at}-${i}`}
          v={v}
          color={v.site ? sites?.get(v.site)?.color : undefined}
          name={v.site ? sites?.get(v.site)?.name : undefined}
        />
      ))}
    </ul>
  );
}

export function LivePage() {
  const sites = useSites();
  const q = useQuery({
    queryKey: ["live"],
    queryFn: () => api.get<Live>("/api/v1/live"),
    refetchInterval: 10_000,
  });
  const info = new Map((sites.data?.data ?? []).map((s) => [s.id, { name: s.name, color: s.color }]));
  const total = (q.data?.per_site ?? []).reduce((a, s) => a + s.visitors, 0);
  return (
    <div className="w-full">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-title">{t("Live")}</h1>
          <p className="text-sm text-ink-2">
            {t(
              "Visitors on your sites in the last 5 minutes; visits of the last 30 below. Updates every 10 seconds.",
            )}
          </p>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="t-readout text-[44px] leading-[44px]">
            <CountUp value={q.data ? total : undefined} format={(v) => fmt(v)} />
          </span>
          <span className="text-sm text-ink-2">{t("here now")}</span>
        </div>
      </header>
      {q.error && <ErrorBox error={q.error} />}
      {!q.data ? (
        <Skeleton h={320} />
      ) : (
        <>
          <ul className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {q.data.per_site.map((s) => (
              <li key={s.site} data-site={info.get(s.site)?.color} className="panel px-4 py-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Link
                    to="/sites/$site/realtime"
                    params={{ site: s.site }}
                    className="flex min-w-0 items-center gap-2 font-semibold hover:underline"
                  >
                    <span className="swatch" aria-hidden="true" />
                    <span className="truncate">{info.get(s.site)?.name ?? s.site}</span>
                  </Link>
                  <span className="t-num text-[22px] font-bold">{s.visitors}</span>
                </div>
                <Minutes values={s.hits_per_minute} label={info.get(s.site)?.name ?? s.site} />
              </li>
            ))}
          </ul>
          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Section title={t("Visits")}>
              <Feed visits={q.data.visits} sites={info} />
            </Section>
            <Section title={t("Where they are")}>
              <Suspense fallback={<Skeleton h={220} />}>
                <WorldMap
                  rows={q.data.countries.map((c) => ({ country: c.country, visitors: c.visitors }))}
                />
              </Suspense>
            </Section>
          </div>
        </>
      )}
    </div>
  );
}

/** A site's Realtime page: the same view for one site. */
export function SiteRealtimePage() {
  const { site } = useParams({ strict: false }) as { site: string };
  const q = useQuery({
    queryKey: ["realtime-page", site],
    queryFn: () => api.get<Realtime>(`/api/v1/sites/${site}/realtime`),
    refetchInterval: 10_000,
  });
  return (
    <div className="w-full">
      <SiteHeader site={site} />
      {q.error && <ErrorBox error={q.error} />}
      {!q.data ? (
        <Skeleton h={320} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Section title={t("Visits of the last 30 minutes")}>
            <Feed visits={q.data.visits} />
          </Section>
          <div className="flex flex-col gap-4">
            <Section title={t("Here now")}>
              <div className="flex items-baseline gap-2 px-2">
                <span className="t-readout text-[44px] leading-[44px]">
                  <CountUp value={q.data.visitors} format={(v) => fmt(v)} />
                </span>
                <span className="text-sm text-ink-2">{t("visitors in the last 5 minutes")}</span>
              </div>
              <div className="mt-3 px-2">
                <Minutes values={q.data.hits_per_minute.map((h) => h.hits)} label={t("Hits per minute")} />
                <div className="mt-1 flex justify-between text-[11.5px] text-ink-3">
                  <span>{t("{n} min ago", { n: 30 })}</span>
                  <span>{t("now")}</span>
                </div>
              </div>
            </Section>
            <Section title={t("Pages now")}>
              {q.data.pages.length ? (
                <ul className="divide-y divide-line">
                  {q.data.pages.map((p) => (
                    <li key={p.page} className="flex justify-between gap-3 px-2 py-2 text-sm">
                      <span className="truncate">{p.page}</span>
                      <span className="font-semibold">{p.visitors}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>{t("Nobody is on a page right now.")}</Empty>
              )}
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

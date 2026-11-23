// Home: "how is today going?" at the top, "how is each site doing?" below. One request (GET /sites/summary).
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ExternalLink, Plus, SourceIcon } from "../components/icons.tsx";
import { CardChart, River } from "../components/SiteCharts.tsx";
import { CountUp } from "../components/motion.tsx";
import { ago, Delta, ErrorBox, Segmented, Skeleton } from "../components/ui.tsx";
import { api, fmt } from "../lib/api.ts";
import { locale, t } from "../lib/i18n.ts";
import { channelName, linkableDomain } from "../lib/labels.ts";
import { prefetchOverview } from "../lib/overview.ts";
import { InstallCheck } from "./sites.tsx";

type Range = "today" | "7d" | "30d";

interface Card {
  id: string;
  name: string;
  domains: string[];
  color: string;
  visitors: { value: number; previous: number | null; change_pct: number | null };
  pageviews: number;
  series: { at: string | number; visitors: number }[];
  comparison: { at: string | number; visitors: number }[];
  low_traffic: boolean;
  today: { visitors: number; same_time_yesterday: number; change_pct: number | null };
  hours: { today: number[]; yesterday: number[] };
  live: number;
  top_page: { page: string; visitors: number } | null;
  top_source: { source: string; visitors: number } | null;
  goal: {
    id: string;
    name: string;
    conversions: number;
    conversion_rate: number | null;
    change_pct: number | null;
  } | null;
  errors_24h: number;
  lcp_p75: number | null;
  cls_p75: number | null;
  checks: {
    count: number;
    down: number;
    uptime_7d: number | null;
    uptime_30d: number | null;
    incident_since: string | null;
  };
  last_event: string | null;
  /** What changed on the last full day, from structured fields (the API's `sentence` is English and not shown). */
  changes?: {
    date: string;
    compared_with: string;
    visitors: { value: number; previous: number; change: number; change_pct: number | null };
    drivers: {
      dimension: "channel" | "page" | "country";
      value: string;
      current: number;
      previous: number;
      change: number;
    }[];
    sentence: string;
  } | null;
}

interface Summary {
  meta: { date_range: Range; generated_at: string; now_hour: number; timezone: string };
  totals: {
    visitors: { value: number; previous: number | null; change_pct: number | null };
    today: { visitors: number; same_time_yesterday: number; change_pct: number | null };
    live: number;
    checks: { count: number; down: number };
  };
  sites: Card[];
}

const RANGE_TEXT: Record<Range, string> = {
  today: t("today, against yesterday at this time"),
  "7d": t("last 7 days, against the 7 before"),
  "30d": t("last 30 days, against the 30 before"),
};

const dateTime = new Intl.DateTimeFormat(locale, {
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});
const weekdayLong = new Intl.DateTimeFormat(locale, { weekday: "long" });
const regionNames = (() => {
  try {
    return new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    return null;
  }
})();
function driverLabel(d: { dimension: string; value: string }): string {
  if (d.dimension === "channel") return channelName(d.value);
  if (d.dimension !== "country") return d.value;
  try {
    return regionNames?.of(d.value) ?? d.value;
  } catch {
    return d.value;
  }
}
const dayLabel = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" });

function label(at: string | number): string {
  if (typeof at === "number") return `${String(at).padStart(2, "0")}:00`;
  return dayLabel.format(new Date(`${at}T12:00:00`));
}

/** LCP verdict (web.dev thresholds): good ≤ 2.5 s, poor > 4 s. */
function lcpVerdict(ms: number) {
  return ms <= 2500
    ? { t: t("good"), cls: "delta-up" }
    : ms <= 4000
      ? { t: t("fair"), cls: "text-warn bg-[color-mix(in_oklab,var(--warn)_13%,transparent)]" }
      : { t: t("poor"), cls: "delta-down" };
}

export function SitesPage() {
  const [range, setRange] = useState<Range>("7d");
  const [sort, setSort] = useState<"traffic" | "name">("traffic");
  const q = useQuery({
    queryKey: ["sites-summary", range],
    queryFn: () => api.get<Summary>(`/api/v1/sites/summary?date_range=${range}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const data = q.data;
  const cards = [...(data?.sites ?? [])].sort((a, b) =>
    sort === "traffic" ? b.visitors.value - a.visitors.value : a.name.localeCompare(b.name),
  );
  // A new install: no numbers to show yet, only what to do first.
  if (data && !data.sites.length) return <Welcome />;
  return (
    <div className="w-full">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="t-title">{t("All sites")}</h1>
          <p className="text-sm text-ink-2">{dateTime.format(new Date())}</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            label={t("Period")}
            value={range}
            onChange={setRange}
            options={[
              { value: "today", label: t("Today") },
              { value: "7d", label: t("7 days") },
              { value: "30d", label: t("30 days") },
            ]}
          />
          <Link to="/add-site" className="btn btn-primary">
            <Plus size={16} aria-hidden="true" /> {t("Add site")}
          </Link>
        </div>
      </header>
      {q.error && <ErrorBox error={q.error} />}
      {!data ? (
        <Skeleton h={280} />
      ) : (
        <div className={`updating-host ${q.isPlaceholderData ? "is-updating" : ""}`}>
          <Today data={data} />
          <div className="mb-3 mt-9 flex flex-wrap items-end justify-between gap-3">
            <h2 className="t-heading">
              {t("Your sites")} <span className="ml-2 font-normal text-ink-2">{RANGE_TEXT[range]}</span>
            </h2>
            <Segmented
              label={t("Sort sites")}
              value={sort}
              onChange={setSort}
              options={[
                { value: "traffic", label: t("Traffic") },
                { value: "name", label: t("Name") },
              ]}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2 3xl:grid-cols-3">
            {cards.map((c) => (
              <SiteCard key={c.id} c={c} />
            ))}
          </div>
          <AddAnother />
        </div>
      )}
    </div>
  );
}

function Today({ data }: { data: Summary }) {
  const tot = data.totals;
  const river = [...data.sites].sort((a, b) => a.color.localeCompare(b.color));
  const yesterday = Array.from({ length: 24 }, (_, h) =>
    data.sites.reduce((a, s) => a + (s.hours.yesterday[h] ?? 0), 0),
  );
  return (
    <section className="panel grid overflow-hidden lg:grid-cols-[300px_1fr]" aria-label={t("Today")}>
      <div className="flex flex-col gap-4 border-line p-6 max-lg:border-b lg:border-r">
        <div>
          <div className="flex items-center gap-2 text-sm text-ink-2">
            {t("Visitors today")} <Delta pct={tot.today.change_pct} />
          </div>
          <div className="t-readout mt-1 text-[64px] leading-[64px]">
            <CountUp value={tot.today.visitors} format={(v) => fmt(v)} />
          </div>
          <p className="mt-1 text-sm text-ink-2">
            {t("{n} by this time yesterday", { n: fmt(tot.today.same_time_yesterday) })}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4">
          <Stat label={t("live now")} value={fmt(tot.live)} />
          <Stat
            label={
              data.meta.date_range === "today"
                ? t("visitors, today")
                : t("visitors, {n} days", { n: data.meta.date_range.replace("d", "") })
            }
            value={fmt(tot.visitors.value)}
          />
          <Stat
            label={t("checks up")}
            value={tot.checks.count ? `${tot.checks.count - tot.checks.down}/${tot.checks.count}` : "–"}
            tone={tot.checks.down ? "bad" : tot.checks.count ? "good" : undefined}
          />
          <Stat label={t("sites tracked")} value={String(data.sites.length)} />
        </dl>
      </div>
      <div className="min-w-0 p-5">
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
          {river.map((s) => (
            <span key={s.id} data-site={s.color} className="flex items-center gap-1.5">
              <span className="swatch" aria-hidden="true" />
              {s.name}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <svg width="18" height="4" aria-hidden="true">
              <line
                x1="0"
                x2="18"
                y1="2"
                y2="2"
                stroke="var(--ghost)"
                strokeWidth="1.5"
                strokeDasharray="4 3"
              />
            </svg>
            {t("Yesterday")}
          </span>
          <span className="ml-auto text-ink-3">{t("visitors per hour")}</span>
        </div>
        <River
          series={river.map((s) => ({ id: s.id, name: s.name, color: s.color, values: s.hours.today }))}
          yesterday={yesterday}
          nowHour={data.meta.now_hour}
        />
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div>
      <dd
        className={`t-num text-[22px] font-bold leading-7 ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : ""}`}
      >
        {value}
      </dd>
      <dt className="text-[12.5px] text-ink-2">{label}</dt>
    </div>
  );
}

function SiteCard({ c }: { c: Card }) {
  const qc = useQueryClient();
  const empty = !c.last_event;
  const externalHost = linkableDomain(c.domains);
  return (
    <article
      data-site={c.color}
      className="panel relative flex flex-col overflow-hidden"
      onMouseEnter={() => prefetchOverview(qc, c.id)}
    >
      <span className="absolute inset-x-0 top-0 h-1 bg-site" aria-hidden="true" />
      <header className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <h3
            className="t-display truncate text-[19px] font-bold"
            style={{ viewTransitionName: `site-${c.id}` }}
          >
            <Link
              to="/sites/$site"
              params={{ site: c.id }}
              className="after:absolute after:inset-0 after:content-['']"
            >
              {c.name}
            </Link>
          </h3>
          <p className="truncate text-[12.5px] text-ink-2">{c.domains[0] ?? ""}</p>
        </div>
        <div className="relative z-[1] flex shrink-0 items-center gap-2">
          {c.checks.down > 0 && (
            // On a phone only the mark shows, so the site's name keeps its room.
            <span className="delta delta-down" title={t("check down")}>
              ↘ <span className="max-sm:sr-only">{t("check down")}</span>
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold ${c.live ? "bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good" : "bg-line-2 text-ink-2"}`}
          >
            <span className={`live-dot ${c.live ? "" : "opacity-50"}`} aria-hidden="true" />
            {t("{n} live", { n: c.live })}
          </span>
          {externalHost && (
            <a
              href={`https://${externalHost}`}
              target="_blank"
              rel="noreferrer noopener"
              className="btn btn-sm h-8 w-8 p-0"
              aria-label={t("Open {site}", { site: externalHost })}
              title={t("Open {site}", { site: externalHost })}
            >
              <ExternalLink size={15} aria-hidden="true" />
            </a>
          )}
        </div>
      </header>
      {empty ? (
        <div className="relative z-[1] flex flex-col gap-3 px-5 py-4 text-sm">
          <p className="text-ink-2">
            {t(
              "No visits have arrived yet. Add the snippet to the site's pages, then check the installation.",
            )}
          </p>
          <InstallCheck site={c.id} />
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2 px-5 pt-3">
            <span className="t-readout text-[38px] leading-[40px]">
              <CountUp value={c.visitors.value} format={(v) => fmt(v)} />
            </span>
            <span className="text-sm text-ink-2">{t("visitors")}</span>
            <Delta pct={c.visitors.change_pct} />
          </div>
          <YesterdayLine changes={c.changes} />
          <div className="mt-2">
            <CardChart
              values={c.series.map((p) => p.visitors)}
              previous={c.comparison.map((p) => p.visitors)}
              labels={c.series.map((p) => label(p.at))}
              bars={c.low_traffic}
            />
          </div>
          <dl className="grid grid-cols-2 border-t border-line sm:grid-cols-3 [&>div]:border-line [&>div]:px-5 [&>div]:py-3 [&>div:not(:nth-child(3n))]:sm:border-r [&>div:nth-child(-n+3)]:sm:border-b max-sm:[&>div:nth-child(odd)]:border-r max-sm:[&>div:nth-child(-n+4)]:border-b">
            <Fact label={t("Today")}>
              <span className="font-semibold">{fmt(c.today.visitors)}</span>{" "}
              <Delta pct={c.today.change_pct} />
            </Fact>
            <Fact label={t("Top page")}>
              <span className="block truncate font-semibold" title={c.top_page?.page}>
                {c.top_page?.page ?? "–"}
              </span>
            </Fact>
            <Fact label={t("Top source")}>
              {c.top_source ? (
                <span className="flex min-w-0 items-center gap-1.5 font-semibold">
                  <SourceIcon value={c.top_source.source} size={15} />
                  <span className="truncate">{c.top_source.source}</span>
                </span>
              ) : (
                "–"
              )}
            </Fact>
            {c.goal ? (
              <Fact label={c.goal.name}>
                <span className="font-semibold">
                  {c.goal.conversion_rate === null ? "–" : `${fmt(c.goal.conversion_rate)}%`}
                </span>{" "}
                <span className="text-ink-2">{fmt(c.goal.conversions)}</span>
              </Fact>
            ) : (
              <Fact label={t("Pageviews")}>
                <span className="font-semibold">{fmt(c.pageviews)}</span>
              </Fact>
            )}
            <Fact label={t("Uptime, 30 days")}>
              {c.checks.count ? (
                <span className={`font-semibold ${c.checks.down ? "text-bad" : ""}`}>
                  {c.checks.down ? "↘ " : "● "}
                  {c.checks.uptime_30d === null
                    ? "–"
                    : c.checks.uptime_30d.toLocaleString(locale, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                  %
                </span>
              ) : (
                <span className="text-ink-2">{t("no checks")}</span>
              )}
            </Fact>
            <Fact label={t("LCP p75")}>
              {c.lcp_p75 === null ? (
                <span className="text-ink-2">–</span>
              ) : (
                <span className="flex items-center gap-1.5 font-semibold">
                  {(c.lcp_p75 / 1000).toLocaleString(locale, {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  })}{" "}
                  s<span className={`delta ${lcpVerdict(c.lcp_p75).cls}`}>{lcpVerdict(c.lcp_p75).t}</span>
                </span>
              )}
            </Fact>
          </dl>
          {c.errors_24h > 0 && (
            <p className="border-t border-line px-5 py-2 text-[12.5px] text-bad">
              {t("{n} JavaScript errors in the last 24 hours", { n: c.errors_24h })}
            </p>
          )}
          <p className="sr-only">{t("Last event {when}", { when: ago(c.last_event) })}</p>
        </>
      )}
    </article>
  );
}

/** "Yesterday 120 visitors, ↗ 12% vs Thursday · google.com +30 · /pricing −12". The slot is kept while the data is missing. */
function YesterdayLine({ changes }: { changes: Card["changes"] | undefined }) {
  if (changes && !changes.visitors.value && !changes.visitors.previous) return null;
  if (!changes) return <div className="min-h-[22px] px-5 pt-1.5" aria-hidden="true" />;
  const day = weekdayLong.format(new Date(`${changes.compared_with}T12:00:00`));
  return (
    <p className="flex min-h-[22px] min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-5 pt-1.5 text-[12.5px] text-ink-2">
      <span>{t("Yesterday {n} visitors,", { n: fmt(changes.visitors.value) })}</span>
      <Delta pct={changes.visitors.change_pct} />
      <span>{t("vs {day}", { day })}</span>
      {changes.drivers.slice(0, 2).map((d) => (
        <span key={`${d.dimension}:${d.value}`} className="flex min-w-0 items-center gap-1">
          <span className="truncate" title={driverLabel(d)}>
            {driverLabel(d)}
          </span>
          <span className={`t-num font-semibold ${d.change > 0 ? "text-good" : "text-bad"}`}>
            {d.change > 0 ? "+" : "−"}
            {fmt(Math.abs(d.change))}
          </span>
        </span>
      ))}
    </p>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[12px] text-ink-2">{label}</dt>
      <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[14px]">{children}</dd>
    </div>
  );
}

/** First run: the three things that take a new install from empty to its first visit, then what else is worth setting up. */
function Welcome() {
  const steps: { title: string; body: string; action?: React.ReactNode }[] = [
    {
      title: t("Add your site"),
      body: t("Its domain is enough. Pulse gives it an id and the line of code that counts its visits."),
      action: (
        <Link to="/add-site" className="btn btn-primary">
          <Plus size={16} aria-hidden="true" /> {t("Add site")}
        </Link>
      ),
    },
    {
      title: t("Paste the snippet before </head>"),
      body: t("On every page, or once in your layout. No cookies and no consent banner needed. Pulse checks the install for you."),
    },
    {
      title: t("Watch the first visit arrive"),
      body: t("It shows up in Live within seconds, and the site's overview fills in from there."),
    },
  ];
  const more: [string, string, string][] = [
    ["/settings/people", t("Invite people"), t("Owners, admins, or viewers of some sites")],
    ["/settings/notifications", t("Get alerts"), t("Email, Slack, Discord, Telegram, ntfy or a webhook")],
    ["/settings/keys", t("Connect an agent"), t("API keys and the MCP server for Claude and scripts")],
    ["/status", t("Watch your services"), t("Uptime and status checks for any URL")],
  ];
  return (
    <div className="w-full">
      <header className="mb-5">
        <h1 className="t-title">{t("Pulse is ready")}</h1>
        <p className="text-sm text-ink-2">{t("Private, cookieless analytics for your sites. Three steps to your first visit.")}</p>
      </header>
      <section className="panel max-w-[880px] p-6" aria-label={t("Get started")}>
        <ol className="flex flex-col">
          {steps.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-4 border-b border-line py-5 first:pt-0 last:border-0 last:pb-0">
              <span
                className="t-num flex h-8 w-8 items-center justify-center rounded-full border border-line-strong text-[14px] font-semibold"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <h2 className="t-heading">{s.title}</h2>
                <p className="mt-1 max-w-[62ch] text-sm text-ink-2">{s.body}</p>
                {s.action && <div className="mt-3">{s.action}</div>}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <h2 className="t-heading mb-3 mt-9">{t("When you're ready")}</h2>
      <ul className="grid max-w-[880px] gap-3 sm:grid-cols-2">
        {more.map(([to, title, body]) => (
          <li key={to}>
            <Link to={to as never} className="panel row-hover flex h-full flex-col px-5 py-4">
              <span className="font-semibold">{title}</span>
              <span className="text-sm text-ink-2">{body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddAnother() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ data: { email: string; role: string } }>("/auth/me"),
    retry: false,
    staleTime: 300_000,
  });
  if (me.data?.data.role === "viewer") return null;
  return (
    <section className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-[16px] border border-dashed border-line-strong px-6 py-5">
      <div className="max-w-[56ch]">
        <h2 className="t-heading">{t("Add another site")}</h2>
        <p className="text-sm text-ink-2">
          {t(
            "Paste one line before </head>. Pulse checks the install and tells you when the first visit lands.",
          )}
        </p>
      </div>
      <Link to="/add-site" className="btn btn-primary shrink-0">
        <Plus size={16} aria-hidden="true" /> {t("Add site")}
      </Link>
    </section>
  );
}

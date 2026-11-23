import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { DenseTable } from "../components/DenseTable.tsx";
import {
  Bug,
  DeviceIcon,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Flag,
  MousePointerClick,
  SourceIcon,
  type LucideIcon,
} from "../components/icons.tsx";
import { Toolbar } from "../components/Toolbar.tsx";
import { ago, Empty, ErrorBox, Section, Segmented, Sheet, Skeleton } from "../components/ui.tsx";
import { api, duration, fmt, rangeParams } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";
import { channelName, countryName, deviceName } from "../lib/labels.ts";
import { useFilters } from "../lib/state.ts";
import { SiteHeader } from "./overview.tsx";

interface SessionRow {
  id: string;
  started_at: string;
  entry_path: string | null;
  exit_path: string | null;
  pageviews: number;
  events: number;
  engaged_ms: number;
  duration_ms: number;
  bounced: boolean;
  channel: string | null;
  referrer_host: string | null;
  utm_campaign: string | null;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
}
interface Hit {
  ts: string;
  type: string;
  pathname: string | null;
  title: string | null;
  name: string | null;
  props: Record<string, unknown> | null;
  url: string | null;
  engaged_ms: number | null;
  scroll_pct: number | null;
}

const TYPE: Record<string, { label: string; Icon: LucideIcon }> = {
  pageview: { label: t("Viewed"), Icon: Eye },
  event: { label: t("Event"), Icon: MousePointerClick },
  engagement: { label: t("Read"), Icon: FileText },
  outbound: { label: t("Left to"), Icon: ExternalLink },
  download: { label: t("Downloaded"), Icon: Download },
  error: { label: t("Error"), Icon: Bug },
};

function Timeline({ site, s }: { site: string; s: SessionRow }) {
  const q = useQuery({
    queryKey: ["session", site, s.id],
    queryFn: () =>
      api.get<{ session: Record<string, unknown>; events: Hit[] }>(`/api/v1/sites/${site}/sessions/${s.id}`),
  });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton h={240} />;
  const t0 = Date.parse(q.data.events[0]?.ts ?? (q.data.session.started_at as string));
  const hits = q.data.events.filter((e) => e.type !== "vitals");
  const stats: [string, string][] = [
    [t("Pages"), fmt(s.pageviews)],
    [t("Events"), fmt(s.events)],
    [t("Duration"), duration(s.duration_ms / 1000)],
  ];
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-3 gap-2 text-center">
        {stats.map(([k, v]) => (
          <div key={k} className="rounded-lg bg-site-soft px-2 py-2">
            <dd className="t-num text-[22px] font-semibold leading-7">{v}</dd>
            <dt className="text-xs text-ink-3">{k}</dt>
          </div>
        ))}
      </dl>
      <ol className="relative flex flex-col gap-4">
        <span className="absolute bottom-3 left-[13px] top-3 w-px bg-line-strong" aria-hidden="true" />
        {hits.map((e, i) => {
          const ty = TYPE[e.type] ?? { label: e.type, Icon: Eye };
          const Icon = ty.Icon;
          const main =
            e.type === "event" || e.type === "error"
              ? e.name
              : e.type === "outbound" || e.type === "download"
                ? e.url
                : e.pathname;
          return (
            <li key={i} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 text-sm">
              <span
                className={`relative z-[1] flex h-7 w-7 items-center justify-center rounded-full border ${e.type === "pageview" ? "border-transparent bg-site text-surface" : e.type === "error" ? "border-bad bg-surface text-bad" : "border-line-strong bg-surface text-ink-2"}`}
                aria-hidden="true"
              >
                <Icon size={14} />
              </span>
              <div className="min-w-0 pt-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-ink-2">{ty.label}</span>
                  <span className="min-w-0 break-all font-medium">{main}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                  <span className="t-num">+{duration((Date.parse(e.ts) - t0) / 1000)}</span>
                  {e.type === "engagement" && (
                    <span>
                      {t("{time} on page, scrolled {pct}%", {
                        time: duration((e.engaged_ms ?? 0) / 1000),
                        pct: e.scroll_pct ?? 0,
                      })}
                    </span>
                  )}
                  {e.type === "pageview" && e.title && <span className="truncate">{e.title}</span>}
                </div>
                {e.props && Object.keys(e.props).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {Object.entries(e.props).map(([k, v]) => (
                      <span key={k} className="chip">
                        {k}: {String(v)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function SessionsPage() {
  const { site } = useParams({ strict: false }) as { site: string };
  const [f, setF] = useFilters();
  const [open, setOpen] = useState<SessionRow | null>(null);
  const [show, setShow] = useState<"all" | "events" | "bounced">("all");
  const q = useInfiniteQuery({
    queryKey: ["sessions", site, f],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get<{ sessions: SessionRow[]; next_before: number | null }>(
        `/api/v1/sites/${site}/sessions?${rangeParams(f)}&limit=50${pageParam ? `&before=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
  const all = q.data?.pages.flatMap((p) => p.sessions) ?? [];
  const rows = all.filter((s) => (show === "events" ? s.events > 0 : show === "bounced" ? s.bounced : true));
  return (
    <div className="flex flex-col gap-6 [&>header:first-child]:-mb-1">
      <SiteHeader site={site} />
      <Toolbar value={f} onChange={setF} showCompare={false} />
      <Section
        title={t("Sessions")}
        actions={
          <Segmented
            label={t("Show (loaded sessions)")}
            value={show}
            onChange={setShow}
            options={[
              { value: "all", label: t("All") },
              { value: "events", label: t("With events") },
              { value: "bounced", label: t("Bounced") },
            ]}
          />
        }
      >
        <p className="mb-3 px-2 text-sm text-ink-2">
          {t(
            "Anonymous visits, newest first. Visitor ids change every day, so a person returning tomorrow is a new visitor.",
          )}
        </p>
        {q.error ? (
          <ErrorBox error={q.error} />
        ) : q.isLoading ? (
          <Skeleton h={300} />
        ) : !rows.length ? (
          <Empty>
            {all.length
              ? t("None of the loaded sessions match this filter.")
              : t("No sessions match this range and these filters.")}
          </Empty>
        ) : (
          <DenseTable
            label={t("Sessions list")}
            minWidth={820}
            rows={rows}
            onRow={setOpen}
            rowLabel={(s) => t("Open session {when}", { when: ago(s.started_at) })}
            cols={[
              {
                key: "when",
                label: t("When"),
                render: (s) => <span className="whitespace-nowrap text-ink-2">{ago(s.started_at)}</span>,
              },
              {
                key: "journey",
                label: t("Journey"),
                render: (s) => (
                  <span className="block max-w-[300px] truncate font-medium">
                    {s.entry_path ?? t("(no page)")}
                    {s.exit_path && s.exit_path !== s.entry_path && (
                      <span className="font-normal text-ink-3"> → {s.exit_path}</span>
                    )}
                  </span>
                ),
              },
              {
                key: "source",
                label: t("Source"),
                render: (s) => (
                  <span className="flex max-w-[180px] items-center gap-1.5 text-ink-2">
                    <SourceIcon value={s.referrer_host ?? s.channel} size={14} />
                    <span className="truncate">{s.referrer_host ?? channelName(s.channel)}</span>
                  </span>
                ),
              },
              {
                key: "where",
                label: t("Where and on what"),
                render: (s) => (
                  <span className="flex max-w-[220px] items-center gap-1.5 text-ink-2">
                    {s.country && <Flag code={s.country} />}
                    {s.device && <DeviceIcon value={s.device} size={14} />}
                    <span className="truncate">
                      {[s.country ? countryName(s.country) : null, s.browser].filter(Boolean).join(", ")}
                    </span>
                  </span>
                ),
              },
              {
                key: "events",
                label: t("Events"),
                align: "right",
                className: "t-num text-[15px]",
                render: (s) => (s.events ? fmt(s.events) : <span className="text-ink-3">–</span>),
              },
              {
                key: "pages",
                label: t("Pages"),
                align: "right",
                render: (s) => (
                  <span className="t-num block whitespace-nowrap text-[15px]">
                    {s.pageviews}
                    <span className="block text-xs text-ink-3">
                      {s.bounced ? t("bounced") : duration(s.duration_ms / 1000)}
                    </span>
                  </span>
                ),
              },
            ]}
          />
        )}
        {q.hasNextPage && (
          <button
            type="button"
            className="btn mx-2 mt-3"
            onClick={() => void q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            {t("Show older sessions")}
          </button>
        )}
      </Section>
      <Sheet
        open={!!open}
        onOpenChange={(v) => !v && setOpen(null)}
        title={open ? t("Session {when}", { when: ago(open.started_at) }) : ""}
        description={
          open
            ? t("From {source}{place}, on {tech}", {
                source:
                  open.referrer_host ?? (open.channel ? channelName(open.channel) : t("a direct visit")),
                place:
                  open.city || open.country
                    ? t(", in {place}", {
                        place: [open.city, open.country ? countryName(open.country) : null]
                          .filter(Boolean)
                          .join(", "),
                      })
                    : "",
                tech: [open.device ? deviceName(open.device) : null, open.browser, open.os]
                  .filter(Boolean)
                  .join(", "),
              })
            : undefined
        }
      >
        {open && <Timeline site={site} s={open} />}
      </Sheet>
    </div>
  );
}

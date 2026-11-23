import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api } from "../lib/api.ts";
import { locale, t } from "../lib/i18n.ts";
import { CopyField, Empty, ErrorBox, Field, Section, Skeleton } from "./ui.tsx";

// ---------------------------------------------------------------- Filtered traffic

const REASONS = [
  "bot",
  "hosting",
  "dnt",
  "wrong_host",
  "excluded",
  "rate_limited",
  "over_cap",
  "invalid",
] as const;
type Reason = (typeof REASONS)[number];

interface IngestDay extends Record<Reason, number> {
  day: string;
  accepted: number;
}
interface IngestRes {
  days: IngestDay[];
  totals: Record<Reason | "accepted", number>;
  dropped_pct: number;
}

// Neutral ink shades for the routine reasons, warn/bad only for the ones that need a look.
const REASON_COLOR: Record<Reason, string> = {
  bot: "color-mix(in oklab, var(--ink) 85%, transparent)",
  hosting: "color-mix(in oklab, var(--ink) 64%, transparent)",
  dnt: "color-mix(in oklab, var(--ink) 46%, transparent)",
  excluded: "color-mix(in oklab, var(--ink) 32%, transparent)",
  wrong_host: "color-mix(in oklab, var(--ink) 20%, transparent)",
  invalid: "var(--bad)",
  rate_limited: "var(--warn)",
  over_cap: "color-mix(in oklab, var(--warn) 50%, transparent)",
};
const REASON_LABEL: Record<Reason, string> = {
  bot: t("Bots"),
  hosting: t("Hosting networks"),
  dnt: t("Do Not Track"),
  wrong_host: t("Wrong host"),
  excluded: t("Excluded"),
  rate_limited: t("Rate limited"),
  over_cap: t("Over the daily cap"),
  invalid: t("Invalid"),
};
const REASON_HELP: Record<Reason, string> = {
  bot: t("Known bot user agents."),
  hosting: t("Datacenter and cloud networks, where scrapers and monitors run."),
  dnt: t("Browsers sending Do Not Track, when the site respects it."),
  wrong_host: t("Hits from a domain that isn't in the site's list."),
  excluded: t("Your excluded paths, hosts or countries."),
  rate_limited: t("Too many hits from one source in a short time."),
  over_cap: t("Above the site's daily event cap."),
  invalid: t("Malformed beacons."),
};

const nf = (n: number) => n.toLocaleString(locale);
const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" });

/** Rounded top corners only. */
function topRounded(x: number, y: number, w: number, h: number, r0: number) {
  const r = Math.max(0, Math.min(r0, h, w / 2));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const W = 720;
const H = 120;
const GAP = 2;

function DailyBars({ days }: { days: IngestDay[] }) {
  const [hot, setHot] = useState<number | null>(null);
  const reasonsOf = (d: IngestDay) => REASONS.filter((r) => d[r] > 0);
  const total = (d: IngestDay) => REASONS.reduce((a, r) => a + d[r], 0);
  const max = Math.max(1, ...days.map(total));
  const bw = (W - GAP * (days.length - 1)) / days.length;
  const hd = hot !== null ? days[hot] : null;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={t("Filtered hits per day, by reason")}
        onPointerLeave={() => setHot(null)}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHot(
            Math.min(
              days.length - 1,
              Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * days.length)),
            ),
          );
        }}
      >
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--line)" />
        {days.map((d, i) => {
          const x = i * (bw + GAP);
          const parts = reasonsOf(d);
          let y = H;
          const lastIdx = parts.length - 1;
          return (
            <g key={d.day} opacity={hot === null || hot === i ? 1 : 0.55}>
              <rect x={x - GAP / 2} y={0} width={bw + GAP} height={H} fill="transparent" />
              {parts.map((r, k) => {
                const h = Math.max(1, (d[r] / max) * (H - 4));
                y -= h;
                return k === lastIdx ? (
                  <path key={r} d={topRounded(x, y, bw, h, 4)} fill={REASON_COLOR[r]} />
                ) : (
                  <rect key={r} x={x} y={y} width={bw} height={h} fill={REASON_COLOR[r]} />
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-ink-3">
        <span>{dayLabel(days[0]!.day)}</span>
        <span>{dayLabel(days[days.length - 1]!.day)}</span>
      </div>
      {hd && hot !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-52 rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] shadow-sm"
          style={{
            left: `${((hot + 0.5) / days.length) * 100}%`,
            transform: `translateX(${hot > days.length / 2 ? "calc(-100% - 8px)" : "8px"})`,
          }}
        >
          <div className="mb-1 font-medium">{dayLabel(hd.day)}</div>
          <div className="flex justify-between gap-3 text-ink-2">
            <span>{t("Counted")}</span>
            <span className="t-num text-ink">{nf(hd.accepted)}</span>
          </div>
          {reasonsOf(hd).map((r) => (
            <div key={r} className="flex items-center justify-between gap-3 text-ink-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ background: REASON_COLOR[r] }}
                />
                <span className="truncate">{REASON_LABEL[r]}</span>
              </span>
              <span className="t-num text-ink">{nf(hd[r])}</span>
            </div>
          ))}
          {!reasonsOf(hd).length && <div className="text-ink-3">{t("Nothing filtered")}</div>}
        </div>
      )}
    </div>
  );
}

export function FilteredTrafficSection({ site }: { site: string }) {
  const q = useQuery({
    queryKey: ["ingest-filtered", site],
    queryFn: () => api.get<IngestRes>(`/api/v1/sites/${site}/ingest?days=30`),
  });
  const d = q.data && q.data.totals && Array.isArray(q.data.days) ? q.data : undefined;
  const filtered = d ? REASONS.reduce((a, r) => a + (d.totals[r] ?? 0), 0) : 0;
  const has = !!d && d.days.length > 0 && filtered + (d.totals.accepted ?? 0) > 0;
  const pct = d ? (Math.round(d.dropped_pct * 10) / 10).toLocaleString(locale) : "";
  return (
    <Section id="filtered" className="scroll-mt-6" title={t("Filtered traffic")}>
      <div className="flex flex-col gap-4 px-2 pb-2">
        {q.isLoading ? (
          <Skeleton h={140} />
        ) : q.error ? (
          <ErrorBox error={q.error} />
        ) : !has || !d ? (
          <Empty>{t("No hits received in the last 30 days, so there is nothing to filter yet.")}</Empty>
        ) : (
          <>
            <p className="text-sm">
              {t("{pct}% of hits in the last 30 days were filtered out", { pct })}
              <span className="text-ink-2">
                {" "}
                · {t("{n} counted, {m} filtered", { n: nf(d.totals.accepted ?? 0), m: nf(filtered) })}
              </span>
            </p>
            <DailyBars days={d.days} />
            <ul className="flex flex-col">
              {REASONS.map((r) => (
                <li
                  key={r}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-line py-2.5 text-sm last:border-0"
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 translate-y-px rounded-[3px]"
                    style={{ background: REASON_COLOR[r] }}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{REASON_LABEL[r]}</span>
                    <span className="block text-[13px] text-ink-2">{REASON_HELP[r]}</span>
                  </span>
                  <span className="t-num text-[15px]">{nf(d.totals[r] ?? 0)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Campaign links

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const SOURCES = ["google", "newsletter", "twitter", "linkedin", "facebook", "instagram", "youtube", "reddit"];
const MEDIUMS = ["email", "cpc", "social", "referral", "organic", "qr", "banner", "affiliate"];

/** The page URL with its own query kept and the filled utm_* values added, URL-encoded. */
export function buildCampaignUrl(page: string, utm: Record<string, string>): string | null {
  const raw = page.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const keyOf = (p: string) => {
    try {
      return decodeURIComponent(p.split("=")[0]!);
    } catch {
      return p;
    }
  };
  const keep = u.search
    .slice(1)
    .split("&")
    .filter((p) => p && !(UTM_KEYS as readonly string[]).includes(keyOf(p)));
  const add = UTM_KEYS.filter((k) => utm[k]?.trim()).map((k) => `${k}=${encodeURIComponent(utm[k]!.trim())}`);
  const qs = [...keep, ...add].join("&");
  return `${u.origin}${u.pathname}${qs ? `?${qs}` : ""}${u.hash}`;
}

export function CampaignLinksSection({ domains }: { domains: string[] }) {
  const uid = useId();
  const [page, setPage] = useState(domains[0] ? `https://${domains[0]}/` : "https://");
  const [utm, setUtm] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setUtm((x) => ({ ...x, [k]: v }));
  const ready = !!utm.utm_source?.trim() && !!utm.utm_campaign?.trim();
  const out = ready ? buildCampaignUrl(page, utm) : null;
  const field = (k: (typeof UTM_KEYS)[number], label: string, hint?: string, list?: string) => (
    <Field label={label} hint={hint}>
      <input
        className="input"
        value={utm[k] ?? ""}
        onChange={(e) => set(k, e.target.value)}
        list={list}
        autoComplete="off"
      />
    </Field>
  );
  return (
    <Section id="campaigns" className="scroll-mt-6" title={t("Campaign links")}>
      <div className="flex flex-col gap-4 px-2 pb-2">
        <p className="text-sm text-ink-2">
          {t(
            "Tag a link with UTM parameters so its visits show up under that campaign in Sources. Nothing is stored; the link is built in your browser.",
          )}
        </p>
        <Field label={t("Page URL")}>
          <input
            className="input"
            type="url"
            value={page}
            onChange={(e) => setPage(e.target.value)}
            placeholder="https://example.com/offer"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {field("utm_source", t("Source (required)"), t("Where it comes from, e.g. newsletter"), `${uid}-s`)}
          {field("utm_medium", t("Medium"), t("The kind of channel, e.g. email"), `${uid}-m`)}
          {field("utm_campaign", t("Campaign (required)"), t("Your name for it, e.g. spring-sale"))}
          {field("utm_content", t("Content"), t("Tells two links in the same campaign apart"))}
          {field("utm_term", t("Term"), t("The paid keyword, if any"))}
        </div>
        <datalist id={`${uid}-s`}>
          {SOURCES.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <datalist id={`${uid}-m`}>
          {MEDIUMS.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        {out ? (
          <CopyField value={out} label={t("Copy link")} />
        ) : (
          <p className="text-sm text-ink-3">
            {ready ? t("Enter a valid page URL.") : t("Fill in the source and the campaign to get the link.")}
          </p>
        )}
      </div>
    </Section>
  );
}

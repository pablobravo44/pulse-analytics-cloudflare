import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, RefreshCw } from "../components/icons.tsx";
import { SavedNote, SideNav, useActiveSection } from "../components/SideNav.tsx";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CampaignLinksSection, FilteredTrafficSection } from "../components/siteTools.tsx";
import { ChannelPicker } from "../components/ChannelPicker.tsx";
import { dimLabel } from "../components/Toolbar.tsx";
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
  Switch,
  useToast,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { locale, t, tn } from "../lib/i18n.ts";
import { SiteHeader } from "./overview.tsx";
import { DomainsInput, InstallCheck, SnippetTabs, TimezoneSelect } from "./sites.tsx";

interface SiteFull {
  id: string;
  name: string;
  domains: string[];
  timezone: string;
  retention_months: number;
  settings: {
    features: {
      outbound: boolean;
      downloads: boolean;
      engagement: boolean;
      vitals: boolean;
      errors: boolean;
    };
    query_allowlist: string[];
    respect_dnt: boolean;
    block_hosting: boolean;
    hidden: boolean;
    exclude_paths: string[];
    exclude_hosts: string[];
    include_in_digest: boolean;
    search_params: string[];
    block_referrers: string[];
    block_countries: string[];
    revenue_currency: string;
    daily_event_cap: number;
    color: SiteColor | null;
    primary_goal: string | null;
  };
}

const SITE_COLORS = [
  "violet",
  "teal",
  "amber",
  "magenta",
  "blue",
  "olive",
  "coral",
  "indigo",
  "emerald",
  "plum",
  "cyan",
  "slate",
] as const;
type SiteColor = (typeof SITE_COLORS)[number];
const COLOR_NAMES: Record<SiteColor, string> = {
  violet: t("violet"),
  teal: t("teal"),
  amber: t("amber"),
  magenta: t("magenta"),
  blue: t("blue"),
  olive: t("olive"),
  coral: t("coral"),
  indigo: t("indigo"),
  emerald: t("emerald"),
  plum: t("plum"),
  cyan: t("cyan"),
  slate: t("slate"),
};

/** The twelve site colours as swatches; "Automatic" keeps the one given by creation order. */
function ColorPicker({
  value,
  auto,
  onChange,
}: {
  value: SiteColor | null;
  auto: string | undefined;
  onChange: (v: SiteColor | null) => void;
}) {
  return (
    <div role="radiogroup" aria-label={t("Site colour")} className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        onClick={() => onChange(null)}
        className={`chip ${value === null ? "chip-mark font-semibold" : ""}`}
        data-site={auto}
      >
        <span className="swatch" aria-hidden="true" /> {t("Automatic")}
      </button>
      {SITE_COLORS.map((c, i) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          onClick={() => onChange(c)}
          data-site={`s${i + 1}`}
          className={`chip capitalize ${value === c ? "chip-mark font-semibold" : ""}`}
        >
          <span className="swatch" aria-hidden="true" /> {COLOR_NAMES[c]}
        </button>
      ))}
    </div>
  );
}

const FEATURES: [keyof SiteFull["settings"]["features"], string, string][] = [
  ["engagement", t("Engaged time and scroll depth"), t("Sent when a visitor leaves a page")],
  ["outbound", t("Outbound links"), t("Clicks to other sites, mailto and tel links")],
  ["downloads", t("File downloads"), t("pdf, zip, docx, xlsx, csv, mp4, ics, apk")],
  ["vitals", t("Core Web Vitals"), t("LCP, INP and CLS from real visits")],
  ["errors", t("JavaScript errors"), t('Also needs data-errors="true" on the snippet')],
];

const navItems = [
  { id: "snippet", label: t("Tracking snippet") },
  { id: "general", label: t("General") },
  { id: "collect", label: t("What to collect") },
  { id: "alerts", label: t("Alerts") },
  { id: "shares", label: t("Share links") },
  { id: "links", label: t("Links") },
  { id: "campaigns", label: t("Campaign links") },
  { id: "filtered", label: t("Filtered traffic") },
  { id: "remove", label: t("Remove visits") },
  { id: "export", label: t("Export or delete data") },
  { id: "archive", label: t("Archive or delete") },
];

const list = (s: string) =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function SiteSettingsPage() {
  const { site } = useParams({ strict: false }) as { site: string };
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["site", site],
    queryFn: () => api.get<{ data: SiteFull & { color?: string } }>(`/api/v1/sites/${site}`),
  });
  const goals = useQuery({
    queryKey: ["goals-list", site],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>(`/api/v1/sites/${site}/goals`),
  });
  const me = useQuery({
    queryKey: ["apime"],
    queryFn: () => api.get<{ data: { can_admin: boolean; scopes: string[] } }>("/api/v1/me"),
  });
  const [draft, setDraft] = useState<SiteFull | null>(null);
  const [paths, setPaths] = useState("");
  const [params, setParams] = useState("");
  const [search, setSearch] = useState("");
  const [blockRefs, setBlockRefs] = useState("");
  const [blockCountries, setBlockCountries] = useState("");
  const [hosts, setHosts] = useState("");
  const [domainDraft, setDomainDraft] = useState("");
  useEffect(() => {
    if (q.data) {
      setDraft(q.data.data);
      setPaths(q.data.data.settings.exclude_paths.join("\n"));
      setParams(q.data.data.settings.query_allowlist.join(", "));
      setSearch(q.data.data.settings.search_params.join(", "));
      setBlockRefs(q.data.data.settings.block_referrers.join("\n"));
      setBlockCountries(q.data.data.settings.block_countries.join(", "));
      setHosts(q.data.data.settings.exclude_hosts.join(", "));
      setDomainDraft("");
    }
  }, [q.data]);
  const extra = () => ({
    exclude_paths: list(paths),
    exclude_hosts: list(hosts),
    query_allowlist: list(params),
    search_params: list(search),
    block_referrers: list(blockRefs),
    block_countries: list(blockCountries).map((c) => c.toUpperCase()),
  });
  const effectiveDomains = () => {
    const clean = domainDraft.trim();
    return clean && !draft!.domains.includes(clean) ? [...draft!.domains, clean] : draft!.domains;
  };
  const [savedAt, setSavedAt] = useState(0);
  const save = useMutation({
    mutationFn: () =>
      api.patch<{ data: SiteFull }>(`/api/v1/sites/${site}`, {
        name: draft!.name,
        domains: effectiveDomains(),
        timezone: draft!.timezone,
        retention_months: draft!.retention_months,
        settings: { ...draft!.settings, ...extra() },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["site", site] });
      void qc.invalidateQueries({ queryKey: ["sites"] });
      toast(t("Site settings saved"));
      setSavedAt(Date.now());
    },
  });
  const navIds = [
    "snippet",
    "general",
    "collect",
    "alerts",
    "shares",
    "links",
    "campaigns",
    "filtered",
    "remove",
    "export",
    "archive",
  ];
  const [active, setActive] = useActiveSection(navIds);
  const [confirm, setConfirm] = useState<null | "archive" | "purge" | "delete-range">(null);
  const archive = useMutation({
    mutationFn: () => api.del(`/api/v1/sites/${site}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sites"] });
      toast(t("Site archived"));
      void navigate({ to: "/" });
    },
  });
  const purge = useMutation({
    mutationFn: () => api.del(`/api/v1/sites/${site}?purge=true&confirm=${encodeURIComponent(site)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sites"] });
      toast(t("Site and its data deleted"));
      void navigate({ to: "/" });
    },
  });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const exportCsv = useMutation({
    mutationFn: () => api.download("GET", `/api/v1/sites/${site}/export?${new URLSearchParams({ from, to, format: "csv" }).toString()}`),
  });
  const delRange = useMutation({
    mutationFn: () =>
      api.post<{ data: { events_deleted: number } }>(`/api/v1/sites/${site}/delete-data`, {
        from,
        to,
        confirm: true,
      }),
    onSuccess: (r) => toast(tn(r.data.events_deleted, "Deleted {n} event", "Deleted {n} events")),
  });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!draft) return <Skeleton h={400} />;
  const set = (p: Partial<SiteFull>) => setDraft({ ...draft, ...p });
  const setS = (p: Partial<SiteFull["settings"]>) =>
    setDraft({ ...draft, settings: { ...draft.settings, ...p } });
  const orig = q.data!.data;
  const goTo = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  };
  const dirty =
    Boolean(domainDraft.trim()) ||
    JSON.stringify({ ...draft, settings: { ...draft.settings, ...extra() } }) !== JSON.stringify(orig);
  const admin = me.data?.data.can_admin ?? false;
  return (
    <div>
      <SiteHeader site={site} />
      <div className="grid gap-5 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8">
        <SideNav
          items={navItems.filter((i) => admin || i.id !== "remove")}
          active={active}
          label={t("Site settings sections")}
          onSelect={(id) => goTo(id)}
          item={(it, cls, content) => (
            <a
              key={it.id}
              href={`#${it.id}`}
              className={cls}
              aria-current={it.id === active ? "true" : undefined}
              onClick={(e) => (e.preventDefault(), goTo(it.id))}
            >
              {content}
            </a>
          )}
        />
        <div className="flex min-w-0 max-w-[1180px] flex-col gap-6">
          <Section id="snippet" className="scroll-mt-6" title={t("Tracking snippet")}>
            <div className="flex flex-col gap-6">
              <SnippetTabs site={site} />
              <InstallCheck site={site} />
            </div>
          </Section>

          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Section id="general" className="scroll-mt-6" title={t("General")}>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={t("Name")}>
                  <input
                    className="input"
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                    required
                  />
                </Field>
                <Field label={t("Time zone")} hint={t("Where a day starts and ends in reports")}>
                  <TimezoneSelect value={draft.timezone} onChange={(v) => set({ timezone: v })} />
                </Field>
                <Field
                  group
                  label={t("Domains")}
                  hint={t("Hits from other hostnames are dropped (the install check shows them)")}
                  className="sm:col-span-2"
                >
                  <DomainsInput value={draft.domains} onChange={(v) => set({ domains: v })} onDraftChange={setDomainDraft} />
                </Field>
                <Field label={t("Keep raw events for")} hint={t("Older days are kept as daily totals")}>
                  <div className="flex items-center gap-2">
                    <input
                      className="input w-24"
                      type="number"
                      min={1}
                      max={120}
                      value={draft.retention_months}
                      onChange={(e) => set({ retention_months: Number(e.target.value) })}
                    />
                    <span className="text-sm text-ink-2">{t("months")}</span>
                  </div>
                </Field>
                <Field
                  group
                  label={t("Colour")}
                  hint={t("Follows the site everywhere: sidebar, home card, charts and bars")}
                  className="sm:col-span-2"
                >
                  <ColorPicker
                    value={draft.settings.color}
                    auto={orig.settings.color ? undefined : (orig as { color?: string }).color}
                    onChange={(v) => setS({ color: v })}
                  />
                </Field>
                <Field label={t("Main goal")} hint={t("Shown on the home card and first in reports")}>
                  <select
                    className="input"
                    value={draft.settings.primary_goal ?? ""}
                    onChange={(e) => setS({ primary_goal: e.target.value || null })}
                  >
                    <option value="">{t("None")}</option>
                    {(goals.data?.data ?? []).map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="flex flex-col divide-y divide-rule sm:col-span-2">
                  <Switch
                    checked={draft.settings.include_in_digest}
                    onChange={(v) => setS({ include_in_digest: v })}
                    label={t("Include in reports that cover all sites")}
                  />
                  <Switch
                    checked={draft.settings.hidden}
                    onChange={(v) => setS({ hidden: v })}
                    label={t("Internal site")}
                    hint={t("Hidden from the sites board, the digest and connector consent (for test sites)")}
                  />
                </div>
              </div>
            </Section>

            <Section id="collect" className="scroll-mt-6" title={t("What to collect")}>
              <div className="flex flex-col divide-y divide-rule">
                {FEATURES.map(([k, label, hint]) => (
                  <Switch
                    key={k}
                    checked={draft.settings.features[k]}
                    onChange={(v) => setS({ features: { ...draft.settings.features, [k]: v } })}
                    label={label}
                    hint={hint}
                  />
                ))}
                <Switch
                  checked={draft.settings.respect_dnt}
                  onChange={(v) => setS({ respect_dnt: v })}
                  label={t("Respect Do Not Track")}
                  hint={t("Drop visits from browsers that send DNT or Global Privacy Control")}
                />
                <Switch
                  checked={draft.settings.block_hosting}
                  onChange={(v) => setS({ block_hosting: v })}
                  label={t("Block hosting networks")}
                  hint={t("Drop visits from datacenter and cloud networks (bots with browser user agents)")}
                />
              </div>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <Field
                  label={t("Query parameters to keep")}
                  hint={t("Everything else is stripped from page URLs. Comma-separated.")}
                >
                  <input className="input" value={params} onChange={(e) => setParams(e.target.value)} />
                </Field>
                <Field
                  label={t("Paths to ignore")}
                  hint={t("One per line; * matches anything, e.g. /admin/*")}
                >
                  <textarea
                    className="input font-mono text-[13px]"
                    value={paths}
                    onChange={(e) => setPaths(e.target.value)}
                    rows={3}
                  />
                </Field>
                <Field
                  label={t("Site search parameters")}
                  hint={t("Query parameters that hold a search, e.g. q, s. Shown under Pages → Site search.")}
                >
                  <input
                    className="input"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="q"
                  />
                </Field>
                <Field label={t("Revenue currency")} hint={t("For the revenue property on events")}>
                  <input
                    className="input w-24"
                    value={draft.settings.revenue_currency}
                    onChange={(e) => setS({ revenue_currency: e.target.value.toUpperCase().slice(0, 3) })}
                  />
                </Field>
                <Field
                  label={t("Daily event cap")}
                  hint={t(
                    "After this many events in a day (UTC), collection pauses until midnight UTC and you get an email. 0 = no cap.",
                  )}
                >
                  <input
                    className="input w-32"
                    type="number"
                    min={0}
                    step={1000}
                    value={draft.settings.daily_event_cap ?? 200000}
                    onChange={(e) =>
                      setS({ daily_event_cap: Math.max(0, Math.round(Number(e.target.value) || 0)) })
                    }
                  />
                </Field>
                <Field
                  label={t("Block referrers")}
                  hint={t(
                    "Visits from these sites are dropped as spam (one per line). A built-in spam list applies too.",
                  )}
                >
                  <textarea
                    className="input font-mono text-[13px]"
                    value={blockRefs}
                    onChange={(e) => setBlockRefs(e.target.value)}
                    rows={3}
                    placeholder="spam.example"
                  />
                </Field>
                <Field label={t("Block countries")} hint={t("Two-letter codes, comma-separated")}>
                  <input
                    className="input"
                    value={blockCountries}
                    onChange={(e) => setBlockCountries(e.target.value)}
                    placeholder={t("e.g. CN, RU")}
                  />
                </Field>
                <Field
                  label={t("Ignore hostnames")}
                  hint={t(
                    "Hits from these hostnames are dropped even if they match a domain; * is a wildcard",
                  )}
                >
                  <input
                    className="input"
                    value={hosts}
                    onChange={(e) => setHosts(e.target.value)}
                    placeholder="staging.*, preview-*.example.com"
                  />
                </Field>
              </div>
              <p className="mt-4 text-sm text-ink-2">
                {t("Ignore your own visits in this browser:")}{" "}
                {draft.domains
                  .filter((d) => !d.startsWith("*"))
                  .map((d) => (
                    <span key={d} className="mr-3 inline-block">
                      <a className="link" href={`https://${d}/#pulse-ignore`} target="_blank" rel="noopener">
                        {t("ignore on {d}", { d })}
                      </a>{" "}
                      <a
                        className="link text-ink-3"
                        href={`https://${d}/#pulse-unignore`}
                        target="_blank"
                        rel="noopener"
                      >
                        {t("(undo)")}
                      </a>
                    </span>
                  ))}
              </p>
            </Section>

            <div
              className={`flex flex-wrap items-center gap-3 rounded-[14px] px-4 py-3 ${
                dirty
                  ? "sticky bottom-[68px] z-20 border border-line bg-surface/95 shadow-[var(--shadow)] backdrop-blur lg:bottom-4"
                  : "border border-line bg-surface"
              }`}
            >
              <button className="btn btn-primary" type="submit" disabled={!dirty || save.isPending}>
                {t("Save changes")}
              </button>
              {dirty && (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    setDraft(orig);
                    setPaths(orig.settings.exclude_paths.join("\n"));
                    setParams(orig.settings.query_allowlist.join(", "));
                    setSearch(orig.settings.search_params.join(", "));
                    setBlockRefs(orig.settings.block_referrers.join("\n"));
                    setBlockCountries(orig.settings.block_countries.join(", "));
                    setHosts(orig.settings.exclude_hosts.join(", "));
                    setDomainDraft("");
                  }}
                >
                  {t("Discard")}
                </button>
              )}
              <SavedNote at={savedAt} />
              {save.error && <ErrorBox error={save.error} />}
            </div>
          </form>

          <AlertsSection site={site} />
          <div id="shares" className="scroll-mt-6">
            <SharesSection site={site} />
          </div>
          <div id="links" className="scroll-mt-6">
            <LinksSection site={site} />
          </div>
          <CampaignLinksSection domains={orig.domains} />
          <FilteredTrafficSection site={site} />
          {admin && (
            <div id="remove" className="scroll-mt-6">
              <RemoveVisits site={site} />
            </div>
          )}

          <Section id="export" className="scroll-mt-6" title={t("Export or delete data")}>
            <p className="mb-3 max-w-[68ch] px-2 text-sm text-ink-2">
              {t("Raw events of the chosen days as CSV. For reports by page, source or day, use Export on the site view.")}
            </p>
            {exportCsv.error && <ErrorBox error={exportCsv.error} />}
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t("From")}>
                <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label={t("To")}>
                <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <button
                type="button"
                className="btn"
                disabled={!from || !to || exportCsv.isPending}
                onClick={() => exportCsv.mutate()}
              >
                <Download size={15} aria-hidden="true" /> {exportCsv.isPending ? t("Preparing…") : t("Export CSV")}
              </button>
              {admin && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!from || !to}
                  onClick={() => setConfirm("delete-range")}
                >
                  {t("Delete events in range")}
                </button>
              )}
            </div>
          </Section>

          <Section id="archive" className="scroll-mt-6" title={t("Archive or delete")}>
            <div className="flex flex-col gap-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-ink-2">
                  {t(
                    "Archiving stops collecting and hides the site. Its data stays and you can restore it from Settings → Sites.",
                  )}
                </span>
                <button type="button" className="btn" onClick={() => setConfirm("archive")}>
                  {t("Archive site")}
                </button>
              </div>
              {admin && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <span className="text-ink-2">
                    {t(
                      "Delete the site with every event, session, goal, funnel and annotation. This can't be undone.",
                    )}
                  </span>
                  <button type="button" className="btn btn-danger" onClick={() => setConfirm("purge")}>
                    {t("Delete site and data")}
                  </button>
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>

      <Confirm
        open={confirm === "archive"}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={t("Archive {name}?", { name: orig.name })}
        body={t("Pulse stops collecting data for it. You can restore it later.")}
        confirm={t("Archive site")}
        danger={false}
        onConfirm={() => archive.mutate()}
      />
      <Confirm
        open={confirm === "purge"}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={t("Delete {name} and all its data?", { name: orig.name })}
        body={t(
          "Events, sessions, goals, funnels and annotations are deleted permanently. Status checks stay and are unlinked.",
        )}
        confirm={t("Delete site and data")}
        requireText={site}
        onConfirm={() => purge.mutate()}
      />
      <Confirm
        open={confirm === "delete-range"}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={t("Delete events in this range?")}
        body={t("Every event and session from {from} to {to} is deleted permanently.", { from, to })}
        confirm={t("Delete events")}
        requireText={site}
        onConfirm={() => delRange.mutate()}
      />
    </div>
  );
}

// ---------- Alerts ----------

interface Alert {
  id: string;
  name: string;
  kind: string;
  metric: string;
  event_name: string | null;
  filters: [string, string, string[]][];
  window_min: number;
  threshold: number;
  cooldown_min: number;
  channel_ids: string[] | null;
  enabled: boolean;
  last_value: number | null;
  last_checked_at: string | null;
  last_fired_at: string | null;
}
const ALERT_KINDS: [string, string][] = [
  ["below", t("Drops below a number")],
  ["above", t("Goes above a number")],
  ["change_pct", t("Changes by a % vs last week")],
  ["no_data", t("No pageviews at all")],
  ["event", t("An event happens")],
  ["new_error", t("A new JavaScript error")],
];
const WINDOWS = [15, 30, 60, 180, 360, 720, 1440];
const span = (m: number) =>
  m < 60
    ? t("{n} min", { n: m })
    : m === 60
      ? t("1 hour")
      : m === 1440
        ? t("1 day")
        : t("{n} hours", { n: m / 60 });

function describe(a: Alert): string {
  const w = span(a.window_min);
  switch (a.kind) {
    case "above":
      return t("{metric} above {n} in {w}", { metric: a.metric.replace(/_/g, " "), n: a.threshold, w });
    case "below":
      return t("{metric} below {n} in {w}", { metric: a.metric.replace(/_/g, " "), n: a.threshold, w });
    case "change_pct":
      return a.threshold < 0
        ? t("{metric} drops {n}% vs last week ({w})", {
            metric: a.metric.replace(/_/g, " "),
            n: Math.abs(a.threshold),
            w,
          })
        : t("{metric} rises {n}% vs last week ({w})", {
            metric: a.metric.replace(/_/g, " "),
            n: Math.abs(a.threshold),
            w,
          });
    case "no_data":
      return t("no pageviews for {w}", { w });
    case "event":
      return a.threshold > 1
        ? t("“{name}” happens {n}+ times in {w}", { name: a.event_name ?? "", n: a.threshold, w })
        : t("“{name}” happens in {w}", { name: a.event_name ?? "", w });
    default:
      return t("a new JavaScript error in {w}", { w });
  }
}

function AlertsSection({ site }: { site: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["alerts", site],
    queryFn: () =>
      api.get<{ data: Alert[]; history: { id: string; ts: string; message: string }[] }>(
        `/api/v1/sites/${site}/alerts`,
      ),
  });
  const [edit, setEdit] = useState<Partial<Alert> | null>(null);
  const [del, setDel] = useState<Alert | null>(null);
  const search = useSearch({ strict: false }) as { f?: string };
  // "Alert me when…" on the overview links here with #new-alert and the view's filters.
  useEffect(() => {
    if (location.hash !== "#new-alert") return;
    let filters: Alert["filters"] = [];
    try {
      filters = search.f ? (JSON.parse(search.f) as Alert["filters"]) : [];
    } catch {
      filters = [];
    }
    setEdit({
      name: "",
      kind: "change_pct",
      metric: "visitors",
      window_min: 60,
      threshold: -50,
      cooldown_min: 60,
      enabled: true,
      filters,
    });
    history.replaceState(null, "", location.pathname + location.search);
    document.getElementById("alerts")?.scrollIntoView({ block: "start" });
    // Once, on arrival.
  }, []);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["alerts", site] });
  const save = useMutation({
    mutationFn: (a: Partial<Alert>) =>
      a.id
        ? api.patch(`/api/v1/sites/${site}/alerts/${a.id}`, a)
        : api.post(`/api/v1/sites/${site}/alerts`, a),
    onSuccess: () => (toast(t("Alert saved")), setEdit(null), refresh()),
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { value: number; fire: boolean; message: string } }>(
        `/api/v1/sites/${site}/alerts/${id}/test`,
      ),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/sites/${site}/alerts/${id}`),
    onSuccess: () => (toast(t("Alert deleted")), refresh()),
  });
  const a = edit;
  return (
    <Section
      id="alerts"
      title={t("Alerts")}
      actions={
        <button
          className="btn"
          onClick={() =>
            setEdit({
              kind: "below",
              metric: "visitors",
              window_min: 60,
              threshold: 1,
              cooldown_min: 60,
              enabled: true,
              filters: [],
            })
          }
        >
          <Plus size={15} aria-hidden="true" /> {t("Add alert")}
        </button>
      }
    >
      <p className="mb-3 text-sm text-ink-2">
        {t(
          "Get told when traffic does something unusual. Checked every 5 minutes; alerts go to your notification channels.",
        )}
      </p>
      {!q.data?.data.length ? (
        <Empty>
          {t(
            "No alerts yet. A good first one: “no pageviews for 3 hours”, which catches a broken snippet or a site that's down.",
          )}
        </Empty>
      ) : (
        <ul className="flex flex-col">
          {q.data.data.map((r) => (
            <li key={r.id} className={`border-b border-line last:border-0 ${r.enabled ? "" : "opacity-60"}`}>
              <button
                type="button"
                className="row-hover grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-2 py-3 text-left text-sm"
                onClick={() => setEdit(r)}
              >
                <span className="min-w-0">
                  <span className="font-medium">{r.name}</span>
                  <span className="block truncate text-[13px] text-ink-2">{describe(r)}</span>
                </span>
                <span className="text-right text-xs text-ink-3">
                  {r.last_fired_at ? t("fired {ago}", { ago: ago(r.last_fired_at) }) : t("never fired")}
                  {r.last_value !== null && (
                    <span className="block">{t("last value {n}", { n: r.last_value })}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!q.data?.history.length && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-ink-2">
            {t("Recent alerts ({n})", { n: q.data.history.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {q.data.history.map((h) => (
              <li key={h.id} className="text-ink-2">
                <span className="text-ink-3">{new Date(h.ts).toLocaleString(locale)}:</span> {h.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Sheet
        open={!!a}
        onOpenChange={(v) => !v && setEdit(null)}
        title={a?.id ? t("Edit {name}", { name: a.name ?? "" }) : t("Add an alert")}
      >
        {a && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(a);
            }}
          >
            <Field label={t("Name")}>
              <input
                className="input"
                value={a.name ?? ""}
                onChange={(e) => setEdit({ ...a, name: e.target.value })}
                placeholder={t("Traffic stopped")}
                required
                autoFocus
              />
            </Field>
            <Field label={t("Tell me when")}>
              <select
                className="input"
                value={a.kind}
                onChange={(e) =>
                  setEdit({
                    ...a,
                    kind: e.target.value,
                    threshold:
                      e.target.value === "change_pct" ? -50 : e.target.value === "event" ? 1 : a.threshold,
                  })
                }
              >
                {ALERT_KINDS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              {(a.kind === "above" || a.kind === "below" || a.kind === "change_pct") && (
                <Field label={t("Metric")}>
                  <select
                    className="input"
                    value={a.metric}
                    onChange={(e) => setEdit({ ...a, metric: e.target.value })}
                  >
                    {["visitors", "pageviews", "sessions", "events", "bounce_rate", "revenue"].map((m) => (
                      <option key={m} value={m}>
                        {m.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {a.kind === "event" && (
                <Field label={t("Event name")}>
                  <input
                    className="input"
                    value={a.event_name ?? ""}
                    onChange={(e) => setEdit({ ...a, event_name: e.target.value })}
                    placeholder="purchase"
                    required
                  />
                </Field>
              )}
              {a.kind !== "no_data" && a.kind !== "new_error" && (
                <Field
                  label={
                    a.kind === "change_pct"
                      ? t("Change (%)")
                      : a.kind === "event"
                        ? t("At least (times)")
                        : t("Number")
                  }
                  hint={a.kind === "change_pct" ? t("Negative for a drop, e.g. -50") : undefined}
                >
                  <input
                    className="input"
                    type="number"
                    value={a.threshold ?? 0}
                    onChange={(e) => setEdit({ ...a, threshold: Number(e.target.value) })}
                  />
                </Field>
              )}
              <Field label={t("Over the last")}>
                <select
                  className="input"
                  value={a.window_min}
                  onChange={(e) => setEdit({ ...a, window_min: Number(e.target.value) })}
                >
                  {WINDOWS.map((w) => (
                    <option key={w} value={w}>
                      {span(w)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t("Don't repeat for")} hint={t("Minimum time between two alerts from this rule")}>
              <select
                className="input w-auto"
                value={a.cooldown_min}
                onChange={(e) => setEdit({ ...a, cooldown_min: Number(e.target.value) })}
              >
                {[30, 60, 180, 720, 1440].map((m) => (
                  <option key={m} value={m}>
                    {span(m)}
                  </option>
                ))}
              </select>
            </Field>
            {!!a.filters?.length && (
              <p className="text-sm text-ink-2">
                {t("Only visits where {filters}.", {
                  filters: a.filters
                    .map(([op, d, v]) => `${dimLabel(d)} ${op.replace("_", " ")} ${v.join(", ")}`)
                    .join(t(" and ")),
                })}
              </p>
            )}
            <ChannelPicker
              value={a.channel_ids ?? null}
              onChange={(channel_ids) => setEdit({ ...a, channel_ids })}
            />
            <Switch
              checked={a.enabled !== false}
              onChange={(v) => setEdit({ ...a, enabled: v })}
              label={t("Watch this every 5 minutes")}
            />
            {test.data && (
              <p className="border-l-2 border-ink px-3 py-1.5 text-sm">
                {test.data.data.fire
                  ? t("Would fire now: {message}", { message: test.data.data.message })
                  : t("Wouldn't fire now: {message}", { message: test.data.data.message })}
              </p>
            )}
            {save.error && <ErrorBox error={save.error} />}
            <div className="flex flex-wrap justify-end gap-2">
              {a.id && (
                <>
                  <button type="button" className="btn btn-danger mr-auto" onClick={() => setDel(a as Alert)}>
                    {t("Delete alert")}
                  </button>
                  <button type="button" className="btn" onClick={() => test.mutate(a.id!)}>
                    <RefreshCw size={14} aria-hidden="true" /> {t("Check now")}
                  </button>
                </>
              )}
              <button className="btn btn-primary" type="submit" disabled={save.isPending}>
                {a.id ? t("Save changes") : t("Add alert")}
              </button>
            </div>
          </form>
        )}
        <Confirm
          open={!!del}
          onOpenChange={(v) => !v && setDel(null)}
          title={t("Delete {name}?", { name: del?.name ?? t("this alert") })}
          body={t("Its history is deleted too.")}
          confirm={t("Delete alert")}
          onConfirm={() => del && (remove.mutate(del.id), setEdit(null))}
        />
      </Sheet>
    </Section>
  );
}

// ---------- Share links ----------

interface Share {
  id: string;
  name: string;
  view_id: string | null;
  embed_origins: string[];
  has_password: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked: boolean;
}

function SharesSection({ site }: { site: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["shares", site],
    queryFn: () => api.get<{ data: Share[] }>(`/api/v1/sites/${site}/shares`),
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("");
  const [viewId, setViewId] = useState("");
  const [origins, setOrigins] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [embed, setEmbed] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Share | null>(null);
  const views = useQuery({
    queryKey: ["views", site],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>(`/api/v1/sites/${site}/views`),
  });
  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: { url: string; embed?: string } }>(`/api/v1/sites/${site}/shares`, {
        name,
        ...(password ? { password } : {}),
        ...(days ? { expires_in_days: Number(days) } : {}),
        ...(viewId ? { view_id: viewId } : {}),
        ...(origins.trim() ? { embed_origins: list(origins) } : {}),
      }),
    onSuccess: (r) => {
      setUrl(r.data.url);
      setEmbed(r.data.embed ?? null);
      void qc.invalidateQueries({ queryKey: ["shares", site] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/sites/${site}/shares/${id}`),
    onSuccess: () => (toast(t("Share link revoked")), qc.invalidateQueries({ queryKey: ["shares", site] })),
  });
  const live = (q.data?.data ?? []).filter((s) => !s.revoked);
  return (
    <Section
      title={t("Share links")}
      actions={
        <button className="btn" onClick={() => setOpen(true)}>
          <Plus size={15} aria-hidden="true" /> {t("Create link")}
        </button>
      }
    >
      <p className="mb-3 text-sm text-ink-2">
        {t(
          "A read-only link to this site's overview for a client or a teammate without an account. They can't see other sites, settings or status.",
        )}
      </p>
      {!live.length ? (
        <Empty>{t("No share links.")}</Empty>
      ) : (
        <ul className="flex flex-col">
          {live.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-2 py-2.5 text-sm last:border-0"
            >
              <span>
                <span className="font-medium">{s.name}</span>
                <span className="block text-[13px] text-ink-2">
                  {s.view_id
                    ? t("view “{name}”, ", {
                        name: views.data?.data.find((v) => v.id === s.view_id)?.name ?? t("deleted"),
                      })
                    : ""}
                  {s.has_password ? t("password") : t("no password")}
                  {s.embed_origins.length
                    ? t(", embeddable on {origins}", {
                        origins: s.embed_origins.map((o) => o.replace(/^https:\/\//, "")).join(", "),
                      })
                    : ""}
                  {s.expires_at ? t(", expires {ago}", { ago: ago(s.expires_at) }) : ""}
                  {t(", opened {ago}", { ago: ago(s.last_used_at, t("never")) })}
                </span>
              </span>
              <button className="btn btn-sm btn-quiet btn-danger" onClick={() => setRevoke(s)}>
                {t("Revoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Sheet
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            setOpen(false);
            setUrl(null);
            setName("");
            setPassword("");
            setDays("");
            setViewId("");
            setOrigins("");
            setEmbed(null);
          }
        }}
        title={url ? t("Your share link") : t("Create a share link")}
      >
        {url ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-2">
              {password
                ? t(
                    "Anyone with this link can see the overview after entering the password. It's shown once; revoke it here any time.",
                  )
                : t("Anyone with this link can see the overview. It's shown once; revoke it here any time.")}
            </p>
            <CopyField value={url} />
            {embed && (
              <Field label={t("Embed code")} hint={t("Paste it into a page on the sites you allowed")}>
                <CopyField value={embed} />
              </Field>
            )}
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label={t("Name")} hint={t("Who it's for")}>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("Monthly report for Ana")}
                required
                autoFocus
              />
            </Field>
            <Field label={t("Password (optional)")} hint={t("At least 6 characters")}>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
              />
            </Field>
            <Field label={t("Expires after (days, optional)")}>
              <input
                className="input w-28"
                type="number"
                min={1}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </Field>
            <Field
              label={t("Only show a saved view (optional)")}
              hint={t("Its filters apply to everything the link shows and can't be removed by the viewer")}
            >
              <select className="input" value={viewId} onChange={(e) => setViewId(e.target.value)}>
                <option value="">{t("The whole site")}</option>
                {(views.data?.data ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("Allow embedding on (optional)")}
              hint={t(
                "https origins, comma-separated, e.g. https://blog.example.com. Leave empty to block embedding.",
              )}
            >
              <input
                className="input"
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
                placeholder="https://example.com"
              />
            </Field>
            {create.error && <ErrorBox error={create.error} />}
            <button className="btn btn-primary self-end" type="submit" disabled={create.isPending}>
              {t("Create link")}
            </button>
          </form>
        )}
      </Sheet>
      <Confirm
        open={!!revoke}
        onOpenChange={(v) => !v && setRevoke(null)}
        title={t("Revoke {name}?", { name: revoke?.name ?? t("this link") })}
        body={t("It stops working immediately.")}
        confirm={t("Revoke link")}
        onConfirm={() => revoke && del.mutate(revoke.id)}
      />
    </Section>
  );
}

// ---------- Short links ----------

interface ShortLink {
  slug: string;
  target: string;
  campaign: string | null;
  url: string;
  clicks: number;
}

function LinksSection({ site }: { site: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["links", site],
    queryFn: () => api.get<{ data: ShortLink[] }>(`/api/v1/sites/${site}/links`),
  });
  const [target, setTarget] = useState("");
  const [slug, setSlug] = useState("");
  const [campaign, setCampaign] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/sites/${site}/links`, {
        target,
        ...(slug ? { slug } : {}),
        ...(campaign ? { campaign } : {}),
      }),
    onSuccess: () => {
      toast(t("Short link created"));
      setTarget("");
      setSlug("");
      setCampaign("");
      void qc.invalidateQueries({ queryKey: ["links", site] });
    },
  });
  const del = useMutation({
    mutationFn: (s: string) => api.del(`/api/v1/sites/${site}/links/${s}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["links", site] }),
  });
  return (
    <Section title={t("Short links")}>
      <p className="mb-3 text-sm text-ink-2">
        {t(
          "Links for newsletters, QR codes and bios. Each click is counted as a link_click event, then the visitor is sent on.",
        )}
      </p>
      <form
        className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input
          className="input"
          type="url"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="https://example.com/offer"
          aria-label={t("Destination")}
          required
        />
        <input
          className="input"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
          placeholder={t("short name (optional)")}
          aria-label={t("Short name")}
        />
        <input
          className="input"
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
          placeholder={t("campaign (optional)")}
          aria-label={t("Campaign")}
        />
        <button className="btn btn-primary" type="submit" disabled={create.isPending}>
          {t("Create")}
        </button>
      </form>
      {create.error && <ErrorBox error={create.error} />}
      <ul className="flex flex-col">
        {(q.data?.data ?? []).map((l) => (
          <li
            key={l.slug}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-2 py-2.5 text-sm last:border-0"
          >
            <span className="min-w-0">
              <code className="text-[13px]">{l.url}</code>
              <span className="block truncate text-[13px] text-ink-2">
                → {l.target}
                {l.campaign ? ` (${l.campaign})` : ""}
              </span>
            </span>
            <span className="flex items-center gap-3">
              <span className="t-num text-[15px]">{tn(l.clicks, "{n} click", "{n} clicks")}</span>
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => void navigator.clipboard.writeText(l.url).then(() => toast(t("Copied")))}
              >
                {t("Copy")}
              </button>
              <button className="btn btn-sm btn-quiet btn-danger" onClick={() => del.mutate(l.slug)}>
                {t("Delete")}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------- Remove unwanted visits ----------

function RemoveVisits({ site }: { site: string }) {
  const toast = useToast();
  const [dim, setDim] = useState("referrer_host");
  const [value, setValue] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<{ sessions: number; events: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const body = () => ({ from, to, filters: [["is", dim, [value]]] });
  const dry = useMutation({
    mutationFn: () =>
      api.post<{ data: { sessions: number; events: number } }>(`/api/v1/sites/${site}/delete-data`, {
        ...body(),
        dry_run: true,
      }),
    onSuccess: (r) => setPreview(r.data),
  });
  const run = useMutation({
    mutationFn: () =>
      api.post<{ data: { sessions_deleted: number } }>(`/api/v1/sites/${site}/delete-data`, {
        ...body(),
        confirm: true,
      }),
    onSuccess: (r) => {
      toast(tn(r.data.sessions_deleted, "Removed {n} visit", "Removed {n} visits"));
      setPreview(null);
    },
  });
  return (
    <Section title={t("Remove unwanted visits")}>
      <p className="mb-3 text-sm text-ink-2">
        {t(
          "Delete the visits that match a value, e.g. a spam referrer or your own testing, and keep everything else. D1 Time Travel can restore the last 30 days if needed.",
        )}
      </p>
      <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto_auto_auto] sm:items-end">
        <select
          className="input"
          value={dim}
          onChange={(e) => (setDim(e.target.value), setPreview(null))}
          aria-label={t("Where")}
        >
          {["referrer_host", "page", "country", "browser", "utm_source", "utm_campaign", "hostname"].map(
            (d) => (
              <option key={d} value={d}>
                {t("{dim} is", { dim: dimLabel(d) })}
              </option>
            ),
          )}
        </select>
        <input
          className="input"
          value={value}
          onChange={(e) => (setValue(e.target.value), setPreview(null))}
          placeholder="spam.example"
          aria-label={t("Value")}
        />
        <input
          className="input"
          type="date"
          value={from}
          onChange={(e) => (setFrom(e.target.value), setPreview(null))}
          aria-label={t("From")}
        />
        <input
          className="input"
          type="date"
          value={to}
          onChange={(e) => (setTo(e.target.value), setPreview(null))}
          aria-label={t("To")}
        />
        <button
          className="btn"
          disabled={!value || !from || !to || dry.isPending}
          onClick={() => dry.mutate()}
        >
          {t("Preview")}
        </button>
      </div>
      {preview && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span>
            {t("{sessions} visits ({events} events) match.", {
              sessions: preview.sessions,
              events: preview.events,
            })}
          </span>
          {preview.sessions > 0 && (
            <button className="btn btn-danger btn-sm" onClick={() => setConfirm(true)}>
              {tn(preview.sessions, "Remove {n} visit", "Remove {n} visits")}
            </button>
          )}
        </div>
      )}
      {(dry.error || run.error) && <ErrorBox error={dry.error ?? run.error} />}
      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title={tn(preview?.sessions ?? 0, "Remove {n} visit?", "Remove {n} visits?")}
        body={t("Every visit where {dim} is “{value}” between {from} and {to} is deleted.", {
          dim: dimLabel(dim),
          value,
          from,
          to,
        })}
        confirm={t("Remove visits")}
        requireText={site}
        onConfirm={() => run.mutate()}
      />
    </Section>
  );
}

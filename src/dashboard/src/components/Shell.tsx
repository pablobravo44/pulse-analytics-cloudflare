import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  BookOpen,
  Bug,
  ChartSpline,
  Filter,
  Gauge,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Radio,
  Repeat,
  Route,
  Settings,
  SidebarSimple,
  SlidersHorizontal,
  StickyNote,
  Sun,
  Target,
  Translate,
  UsersRound,
  type LucideIcon,
} from "./icons.tsx";
import { Dialog, Tooltip } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, fmt } from "../lib/api.ts";
import { lang, setLang, t, tn, type Lang } from "../lib/i18n.ts";
import { prefetchOverview } from "../lib/overview.ts";
import { carrySearch } from "../lib/state.ts";
import { PRESETS } from "./Toolbar.tsx";
import { Sheet, StatusGlyph, type Health } from "./ui.tsx";

export interface SiteInfo {
  id: string;
  name: string;
  domains: string[];
  timezone: string;
  /** Colour slot s1…s12 (follows the site everywhere). */
  color?: string;
  settings: {
    hidden: boolean;
    revenue_currency?: string;
    color?: string | null;
    primary_goal?: string | null;
  };
  data_range: { first_event?: string | null; last_event: string | null };
}

export interface StatusMonitor {
  id: string;
  name: string;
  site_id: string | null;
  status: Health;
}

export const SITE_SECTIONS: readonly (readonly [string, string, LucideIcon])[] = [
  ["", t("Overview"), ChartSpline],
  ["/realtime", t("Realtime"), Radio],
  ["/goals", t("Goals"), Target],
  ["/funnels", t("Funnels"), Filter],
  ["/paths", t("Journeys"), Route],
  ["/sessions", t("Sessions"), UsersRound],
  ["/retention", t("Retention"), Repeat],
  ["/vitals", t("Web vitals"), Gauge],
  ["/errors", t("Errors"), Bug],
  ["/annotations", t("Annotations"), StickyNote],
  ["/settings", t("Site settings"), SlidersHorizontal],
];

export function useSites() {
  return useQuery({
    queryKey: ["sites"],
    queryFn: () => api.get<{ data: SiteInfo[] }>("/api/v1/sites"),
    staleTime: 60_000,
  });
}

export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.get<{ summary: string; monitors: StatusMonitor[] }>("/api/v1/ops/status"),
    staleTime: 300_000,
  });
}

/** A tiny trace on graph paper. */
// `fluid` stretches the line to the container's width.
export function Spark({
  values,
  width = 64,
  height = 20,
  fluid = false,
}: {
  values: number[];
  width?: number;
  height?: number;
  fluid?: boolean;
}) {
  const max = Math.max(...values, 1);
  const pts = values
    .map(
      (v, i) =>
        `${((i / Math.max(values.length - 1, 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      width={fluid ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fluid ? "none" : undefined}
      aria-hidden="true"
      className="shrink-0 overflow-visible"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ---------- Preferences (per viewer, in this browser) ----------
type ThemePref = "system" | "light" | "dark";
function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem("pulse-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
export function applyTheme(t: ThemePref = readTheme()) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [theme, setTheme] = useState<ThemePref>(readTheme);
  const set = (next: ThemePref) => {
    try {
      if (next === "system") localStorage.removeItem("pulse-theme");
      else localStorage.setItem("pulse-theme", next);
    } catch {
      /* storage blocked */
    }
    applyTheme(next);
    setTheme(next);
  };
  return [theme, set];
}

/** The sidebar folds to a rail of icons; the choice is remembered in this browser. */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem("pulse-rail") === "collapsed";
  } catch {
    return false;
  }
}
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("pulse-rail", c ? "expanded" : "collapsed");
      } catch {
        /* storage blocked */
      }
      return !c;
    });
  return [collapsed, toggle];
}

/** A label beside an icon-only control (the folded rail, the preference buttons). */
function Tip({
  label,
  children,
  side = "right",
}: {
  label: string;
  children: ReactNode;
  side?: "right" | "top";
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={8}
          className="anim-fade z-50 rounded-[7px] bg-ink px-2 py-1 text-[12px] font-medium text-fog shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const THEMES: [ThemePref, string, LucideIcon][] = [
  ["light", t("Light"), Sun],
  ["dark", t("Dark"), Moon],
  ["system", t("Like the system"), Monitor],
];
const LANGS: [Lang, string, string][] = [
  ["es", "ES", "Español"],
  ["en", "EN", "English"],
];

const railIcon =
  "grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-ink-2 transition-colors hover:bg-hover hover:text-ink";

/** Language, theme and sign-out: one compact block at the foot of the sidebar, each control an icon with its name. */
function Preferences({ collapsed, email }: { collapsed: boolean; email?: string }) {
  const [theme, setTheme] = useTheme();
  const signOut = () => void api.post("/auth/logout").finally(() => location.assign("/login"));
  if (collapsed) {
    const cur = THEMES.find(([k]) => k === theme)!;
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]!;
    const here = LANGS.find(([k]) => k === lang)!;
    const other = LANGS.find(([k]) => k !== lang)!;
    const CurIcon = cur[2];
    return (
      <div className="flex flex-col items-center gap-1">
        <Tip label={`${here[2]} · ${t("switch to {name}", { name: other[2] })}`}>
          <button
            type="button"
            className={railIcon}
            onClick={() => setLang(other[0])}
            aria-label={`${t("Language")}: ${here[2]}`}
          >
            <span className="text-[11.5px] font-bold tracking-wide">{here[1]}</span>
          </button>
        </Tip>
        <Tip label={`${cur[1]} · ${t("switch to {name}", { name: next[1].toLowerCase() })}`}>
          <button
            type="button"
            className={railIcon}
            onClick={() => setTheme(next[0])}
            aria-label={`${t("Theme")}: ${cur[1]}`}
          >
            <CurIcon size={17} aria-hidden="true" />
          </button>
        </Tip>
        {email && (
          <Tip label={t("Sign out {email}", { email })}>
            <button type="button" className={railIcon} onClick={signOut} aria-label={t("Sign out")}>
              <LogOut size={17} aria-hidden="true" />
            </button>
          </Tip>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-[11px] border border-line bg-surface p-2">
      {email && (
        <div className="flex items-center gap-2 pl-1">
          <span
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-line-2 text-[11px] font-bold uppercase text-ink-2"
            aria-hidden="true"
          >
            {email[0]}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2" title={email}>
            {email}
          </span>
          <Tip label={t("Sign out")} side="top">
            <button
              type="button"
              className="btn btn-quiet btn-sm h-7 w-7 shrink-0 p-0 text-ink-2"
              onClick={signOut}
              aria-label={t("Sign out")}
            >
              <LogOut size={16} aria-hidden="true" />
            </button>
          </Tip>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label={t("Language")} className="seg seg-compact">
          {LANGS.map(([k, short, name]) => (
            <Tip key={k} label={name} side="top">
              <button
                type="button"
                aria-pressed={lang === k}
                aria-label={`${short} (${name})`}
                onClick={() => lang !== k && setLang(k)}
              >
                {k === lang && <Translate size={13} aria-hidden="true" />}
                {short}
              </button>
            </Tip>
          ))}
        </div>
        <div role="group" aria-label={t("Theme")} className="seg seg-compact">
          {THEMES.map(([k, name, Icon]) => (
            <Tip key={k} label={name} side="top">
              <button type="button" aria-pressed={theme === k} aria-label={name} onClick={() => setTheme(k)}>
                <Icon size={15} aria-hidden="true" />
              </button>
            </Tip>
          ))}
        </div>
      </div>
    </div>
  );
}

function NavLink({
  to,
  children,
  active,
  onNavigate,
  trailing,
  carry,
  icon: Icon,
  collapsed,
  badge,
}: {
  to: string;
  children: string;
  active: boolean;
  onNavigate?: () => void;
  trailing?: ReactNode;
  carry?: boolean;
  icon: LucideIcon;
  collapsed?: boolean;
  /** A dot on the folded icon (something is down). */
  badge?: boolean;
}) {
  if (collapsed)
    return (
      <Tip label={children}>
        <Link
          to={to as never}
          search={carry ? (carrySearch as never) : undefined}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          aria-label={children}
          className={`relative ${railIcon} ${active ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : ""}`}
        >
          <Icon size={18} weight={active ? "fill" : "regular"} aria-hidden="true" />
          {badge && (
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-down" aria-hidden="true" />
          )}
        </Link>
      </Tip>
    );
  return (
    <Link
      to={to as never}
      search={carry ? (carrySearch as never) : undefined}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-[30px] items-center justify-between gap-2 rounded-[8px] px-2 text-[13.5px] ${active ? "bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
    >
      <span className="inline-flex min-w-0 items-center gap-2.5">
        <Icon
          size={16}
          weight={active ? "fill" : "regular"}
          aria-hidden="true"
          className={`shrink-0 ${active ? "text-ink" : "text-ink-3"}`}
        />
        <span className="truncate">{children}</span>
      </span>
      {trailing}
    </Link>
  );
}

function Rail({
  onNavigate,
  collapsed = false,
  onToggle,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  /** Fold or unfold the sidebar (desktop only). */
  onToggle?: () => void;
}) {
  const { site } = useParams({ strict: false }) as { site?: string };
  const path = useRouterState({ select: (s) => s.location.pathname });
  const sites = useSites();
  const status = useStatus();
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ data: { email: string; role: string } }>("/auth/me"),
    retry: false,
    staleTime: 300_000,
  });
  const list = (sites.data?.data ?? []).filter((s) => !s.settings?.hidden);
  // The same request as the home page's default view, so the sidebar costs nothing extra there.
  const summary = useQuery({
    queryKey: ["sites-summary", "7d"],
    queryFn: () =>
      api.get<{ sites: { id: string; series: { visitors: number }[]; visitors: { value: number } }[] }>(
        "/api/v1/sites/summary?date_range=7d",
      ),
    staleTime: 60_000,
  });
  const sparks = list.map((s) => {
    const c = summary.data?.sites.find((x) => x.id === s.id);
    return c ? { data: { series: c.series, total: c.visitors.value } } : undefined;
  });
  const monitors = status.data?.monitors ?? [];
  const down = monitors.filter((m) => m.status === "down");
  const activeMonitors = monitors.filter((m) => m.status !== "paused");
  const allUnknown = activeMonitors.length > 0 && activeMonitors.every((m) => m.status === "unknown");
  const isViewer = me.data?.data.role === "viewer";
  const current = list.find((s) => s.id === site) ?? (sites.data?.data ?? []).find((s) => s.id === site);
  return (
    <nav
      aria-label={t("Main")}
      className={`flex h-full flex-col ${collapsed ? "items-center px-2" : "px-3"}`}
    >
      {/* Sites and sections scroll; the foot (status, settings, docs, preferences) stays at the bottom. */}
      <div
        className={`no-scrollbar flex min-h-0 w-full flex-1 flex-col gap-3.5 overflow-y-auto py-3 ${collapsed ? "items-center" : ""}`}
      >
        <div className={`flex items-center ${collapsed ? "flex-col gap-2" : "justify-between gap-2"}`}>
          <Link
            to="/"
            onClick={onNavigate}
            className="flex min-h-9 items-center gap-2 px-2"
            aria-label="Pulse"
          >
            <img src="/favicon.svg" alt="" width={22} height={22} />
            {!collapsed && <span className="t-wide text-[17px] font-semibold">Pulse</span>}
          </Link>
          {onToggle && (
            <Tip label={`${collapsed ? t("Expand sidebar") : t("Collapse sidebar")}  [`}>
              <button
                type="button"
                className={railIcon}
                onClick={onToggle}
                aria-label={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
                aria-expanded={!collapsed}
              >
                <SidebarSimple size={18} aria-hidden="true" />
              </button>
            </Tip>
          )}
        </div>

        <div className={`flex flex-col gap-0.5 ${collapsed ? "items-center" : ""}`}>
          <NavLink to="/" active={path === "/"} onNavigate={onNavigate} icon={Activity} collapsed={collapsed}>
            {t("All sites")}
          </NavLink>
          <NavLink
            to="/live"
            active={path === "/live"}
            onNavigate={onNavigate}
            icon={Radio}
            collapsed={collapsed}
          >
            {t("Live")}
          </NavLink>
        </div>

        <div className={`flex flex-col ${collapsed ? "items-center gap-1" : "gap-0.5"}`}>
          {!collapsed && (
            <div className="flex items-center justify-between px-2 pb-1 text-xs text-ink-3">
              <span>{t("Sites")}</span>
              <span>{t("visitors, 7 days")}</span>
            </div>
          )}
          {sites.isLoading && (
            <div className="flex flex-col gap-0.5" aria-hidden="true">
              <div className={`skeleton my-[5px] h-6 ${collapsed ? "w-7" : "mx-2"}`} />
              <div className={`skeleton my-[5px] h-6 ${collapsed ? "w-7" : "mx-2"}`} />
            </div>
          )}
          {list.map((s, i) => {
            const d = sparks[i]?.data;
            const siteDown = monitors.some((m) => m.site_id === s.id && m.status === "down");
            const active = s.id === site;
            const common = {
              to: "/sites/$site" as const,
              params: { site: s.id },
              search: carrySearch as never,
              onClick: onNavigate,
              onMouseEnter: () => prefetchOverview(qc, s.id),
              onFocus: () => prefetchOverview(qc, s.id),
              "aria-current": active && path === `/sites/${s.id}` ? ("page" as const) : undefined,
              "data-site": s.color,
            };
            if (collapsed)
              return (
                <Tip
                  key={s.id}
                  label={d ? `${s.name} · ${t("{n} visitors, 7 days", { n: fmt(d.total) })}` : s.name}
                >
                  <Link
                    {...common}
                    aria-label={s.name}
                    className={`relative ${railIcon} ${active ? "bg-surface shadow-[0_0_0_1px_var(--line)]" : ""}`}
                  >
                    <span
                      className="grid h-6 w-6 place-items-center rounded-[7px] bg-site text-[11.5px] font-bold uppercase text-white"
                      aria-hidden="true"
                    >
                      {s.name.trim()[0]}
                    </span>
                    {siteDown && (
                      <span
                        className="absolute right-1 top-1 h-2 w-2 rounded-full bg-down ring-2 ring-paper"
                        aria-hidden="true"
                      />
                    )}
                  </Link>
                </Tip>
              );
            return (
              <Link
                key={s.id}
                {...common}
                className={`flex min-h-[34px] items-center gap-2 rounded-[9px] px-2 ${active ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
              >
                {siteDown ? <StatusGlyph status="down" /> : <span className="swatch" aria-hidden="true" />}
                <span className={`min-w-0 flex-1 truncate text-[13.5px] ${active ? "font-semibold" : ""}`}>
                  {s.name}
                </span>
                {d && (
                  <span className="text-site">
                    <Spark values={d.series.map((r) => r.visitors)} width={44} height={16} />
                  </span>
                )}
                <span className="t-num w-9 text-right text-[13px] text-ink">{d ? fmt(d.total) : ""}</span>
              </Link>
            );
          })}
          {!isViewer &&
            (collapsed ? (
              <Tip label={t("Add site")}>
                <Link to="/add-site" onClick={onNavigate} className={railIcon} aria-label={t("Add site")}>
                  <Plus size={16} aria-hidden="true" />
                </Link>
              </Tip>
            ) : (
              <Link
                to="/add-site"
                onClick={onNavigate}
                className="flex min-h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13.5px] text-ink-2 hover:bg-hover hover:text-ink"
              >
                <Plus size={14} aria-hidden="true" className="ml-px" /> {t("Add site")}
              </Link>
            ))}
        </div>

        {current && (
          <div
            className={`flex flex-col gap-0.5 ${collapsed ? "items-center border-t border-rule pt-3" : ""}`}
          >
            {!collapsed && <div className="truncate px-2 pb-0.5 text-xs text-ink-3">{current.name}</div>}
            {SITE_SECTIONS.filter(([suffix]) => !isViewer || suffix !== "/settings").map(([suffix, label, Icon]) => (
              <NavLink
                key={suffix}
                to={`/sites/${current.id}${suffix}`}
                active={path === `/sites/${current.id}${suffix}`}
                onNavigate={onNavigate}
                icon={Icon}
                collapsed={collapsed}
                carry
              >
                {label}
              </NavLink>
            ))}
          </div>
        )}
      </div>

      <div
        className={`flex w-full shrink-0 flex-col gap-0.5 border-t border-rule pb-3 pt-2.5 ${collapsed ? "items-center" : ""}`}
      >
        <NavLink
          to="/status"
          active={path === "/status"}
          onNavigate={onNavigate}
          icon={Activity}
          collapsed={collapsed}
          badge={down.length > 0}
          trailing={
            down.length ? (
              <span className="text-xs font-medium text-down">✕ {tn(down.length, "{n} check down", "{n} down")}</span>
            ) : activeMonitors.length && !allUnknown ? (
              <span className="text-xs text-ink-3">{t("all up")}</span>
            ) : null
          }
        >
          {t("Status")}
        </NavLink>
        {!isViewer && (
          <NavLink
            to="/settings"
            active={path.startsWith("/settings")}
            onNavigate={onNavigate}
            icon={Settings}
            collapsed={collapsed}
          >
            {t("Settings")}
          </NavLink>
        )}
        {collapsed ? (
          <Tip label={t("Docs")}>
            <a href="/docs" className={railIcon} aria-label={t("Docs")}>
              <BookOpen size={18} aria-hidden="true" />
            </a>
          </Tip>
        ) : (
          <a
            href="/docs"
            className="flex min-h-[32px] items-center gap-2.5 rounded-[8px] px-2 text-[13.5px] text-ink-2 hover:bg-hover hover:text-ink"
          >
            <BookOpen size={16} aria-hidden="true" className="text-ink-3" /> {t("Docs")}
          </a>
        )}
        <div className={collapsed ? "mt-2 border-t border-rule pt-2" : "mt-3"}>
          <Preferences collapsed={collapsed} email={me.data?.data.email} />
        </div>
      </div>
    </nav>
  );
}

function Shortcuts({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const keys: [string, string][] = [
    ...PRESETS.filter(([, , k]) => k).map(([, label, k]): [string, string] => [k.toUpperCase(), label]),
    ["← →", t("Previous or next period")],
    ["X", t("Compare with the previous period")],
    ["/", t("Add a filter")],
    ["1–9", t("Go to the first nine sites in the sidebar")],
    ["[", t("Collapse or expand the sidebar")],
    ["Esc", t("Clear filters")],
    ["?", t("This list")],
  ];
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("Keyboard shortcuts")}
      description={t("Report shortcuts work on any page with a date range, while no field has focus.")}
    >
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {keys.map(([k, label]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="chip font-medium">{k}</kbd>
            </dt>
            <dd className="text-ink-2">{label}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [shortcuts, setShortcuts] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const { site } = useParams({ strict: false }) as { site?: string };
  const sites = useSites();
  const current = (sites.data?.data ?? []).find((s) => s.id === site);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const siteList = (sites.data?.data ?? []).filter((s) => !s.settings?.hidden);
  // The key listener is registered once; it reads the current sites and location from here.
  const latest = useRef({ siteList, site, path, navigate, toggleCollapsed });
  latest.current = { siteList, site, path, navigate, toggleCollapsed };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing =
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
        t.isContentEditable ||
        !!document.querySelector("[role=dialog]");
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setShortcuts(true);
      } else if (e.key === "[") {
        e.preventDefault();
        latest.current.toggleCollapsed();
      } else if (/^[1-9]$/.test(e.key)) {
        // 1–9: the nth site in the rail, keeping the current section.
        const { siteList: list, site: cur, path: at, navigate: go } = latest.current;
        const target = list[Number(e.key) - 1];
        if (!target) return;
        e.preventDefault();
        const section = cur ? at.slice(`/sites/${cur}`.length) : "";
        void go({ to: `/sites/${target.id}${section}` as never, search: carrySearch as never });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={100}>
      <div
        className={`min-h-screen lg:grid lg:transition-[grid-template-columns] lg:duration-200 ${collapsed ? "lg:grid-cols-[60px_minmax(0,1fr)]" : "lg:grid-cols-[248px_minmax(0,1fr)]"}`}
      >
        <aside
          className="sticky top-0 hidden h-screen overflow-hidden border-r border-rule lg:block"
          data-collapsed={collapsed || undefined}
        >
          <Rail collapsed={collapsed} onToggle={toggleCollapsed} />
        </aside>
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-rule bg-paper/95 px-4 py-2 backdrop-blur lg:hidden">
          <Dialog.Root open={drawer} onOpenChange={setDrawer}>
            <Dialog.Trigger className="btn btn-quiet btn-sm" aria-label={t("Open navigation")}>
              <Menu size={18} aria-hidden="true" />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="anim-fade fixed inset-0 z-40 bg-[rgba(17,23,21,0.32)]" />
              <Dialog.Content className="anim-sheet fixed inset-y-0 left-0 z-50 w-[min(300px,86vw)] border-r border-rule bg-paper">
                <Dialog.Title className="sr-only">{t("Navigation")}</Dialog.Title>
                <Dialog.Description className="sr-only">
                  {t("Sites, sections and settings")}
                </Dialog.Description>
                <Rail onNavigate={() => setDrawer(false)} />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <img src="/favicon.svg" alt="" width={20} height={20} />
            <span className="t-wide truncate font-semibold">{current?.name ?? "Pulse"}</span>
          </Link>
        </header>
        {/* Inside a site everything takes the site's colour (bars, highlights, chart, focus). */}
        <main
          data-site={current?.color}
          className={`w-full min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7 2xl:px-10 ${current ? "pb-24 lg:pb-7" : ""}`}
        >
          <div key={path}>{children}</div>
        </main>
        {current && (
          // On phones a site's main sections sit in a bar at the bottom, within thumb reach; "More" opens the full menu.
          <nav
            aria-label={t("Site sections")}
            data-site={current.color}
            className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
          >
            {BOTTOM.map(([suffix, label, Icon]) => {
              const to = `/sites/${current.id}${suffix}`;
              const active = path === to;
              return (
                <Link
                  key={suffix}
                  to={to as never}
                  search={carrySearch as never}
                  aria-current={active ? "page" : undefined}
                  className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active ? "font-semibold text-[var(--site-ink)]" : "text-ink-2"}`}
                >
                  <Icon size={21} weight={active ? "fill" : "regular"} aria-hidden="true" />
                  {label}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => setDrawer(true)}
              className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-ink-2"
            >
              <Menu size={21} aria-hidden="true" />
              {t("More")}
            </button>
          </nav>
        )}
        <Shortcuts open={shortcuts} onOpenChange={setShortcuts} />
      </div>
    </Tooltip.Provider>
  );
}

const BOTTOM: readonly (readonly [string, string, LucideIcon])[] = [
  ["", t("Overview"), ChartSpline],
  ["/realtime", t("Live"), Radio],
  ["/goals", t("Goals"), Target],
  ["/paths", t("Journeys"), Route],
];

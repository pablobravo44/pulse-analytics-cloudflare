// The site's main chart (uPlot, canvas: fast with thousands of hourly points), drawn to docs/DESIGN.md:
// - the series in the site's colour, a monotone curve (never overshoots the data) over a soft gradient, no markers
//   except under the cursor; with little traffic (under ~5 a day) rounded bars instead;
// - the comparison as a thin dashed ghost, aligned row by row (the API fills and aligns both periods);
// - today (an unfinished day or hour) as a dashed last segment, so it doesn't read as a drop;
// - weekends shaded faintly on daily charts, three soft grid lines, local short dates on the axis;
// - annotations as small markers in a lane above the plot (grouped when they would touch, one colour per kind);
//   a marker opens its notes in a popover that never leaves the screen, and the cursor's tooltip lists the notes of
//   the point under it; which kinds show is the viewer's choice (NotesMenu, remembered in this browser);
// - an HTML tooltip (date, value, previous, change, notes) that follows the cursor or the arrow keys.
import { Popover } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { fmt, type Row } from "../lib/api.ts";
import {
  Check,
  ExternalLink,
  FlagBanner,
  Megaphone,
  NoteBlank,
  RocketLaunch,
  StickyNote,
  WarningCircle,
  type LucideIcon,
} from "./icons.tsx";
import { reducedMotion } from "./motion.tsx";
import { locale, t } from "../lib/i18n.ts";

/** Annotation kinds as the chart shows them: icon, colour and the name in the notes menu. */
export const NOTE_KINDS: { id: string; label: string; icon: LucideIcon; color: string }[] = [
  { id: "deploy", label: t("Deploys"), icon: RocketLaunch, color: "var(--site-ink, var(--ink))" },
  { id: "incident", label: t("Incidents"), icon: WarningCircle, color: "var(--bad)" },
  { id: "data", label: t("Data changes"), icon: FlagBanner, color: "var(--warn)" },
  { id: "campaign", label: t("Campaigns"), icon: Megaphone, color: "var(--good)" },
  { id: "content", label: t("Content"), icon: StickyNote, color: "var(--ink-2)" },
  { id: "other", label: t("Notes"), icon: NoteBlank, color: "var(--ink-2)" },
];
export function noteKind(category?: string | null) {
  return NOTE_KINDS.find((k) => k.id === category) ?? NOTE_KINDS[NOTE_KINDS.length - 1]!;
}

function readHiddenKinds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("pulse-notes-hidden") ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Which kinds of annotation the chart shows; remembered in this browser. */
export function useNoteKinds(): [string[], (hidden: string[]) => void] {
  const [hidden, setHidden] = useState(readHiddenKinds);
  const set = (next: string[]) => {
    try {
      localStorage.setItem("pulse-notes-hidden", JSON.stringify(next));
    } catch {
      /* storage blocked */
    }
    setHidden(next);
  };
  return [hidden, set];
}

/** The chart's "Notes" button: show or hide each kind of annotation (with how many fall in the range). */
export function NotesMenu({
  annotations,
  hidden,
  onChange,
}: {
  annotations: Annotation[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
}) {
  const counts = new Map<string, number>();
  for (const a of annotations)
    counts.set(noteKind(a.category).id, (counts.get(noteKind(a.category).id) ?? 0) + 1);
  const kinds = NOTE_KINDS.filter((k) => counts.has(k.id));
  const shown = annotations.filter((a) => !hidden.includes(noteKind(a.category).id)).length;
  if (!annotations.length) return null;
  const allHidden = kinds.every((k) => hidden.includes(k.id));
  return (
    <Popover.Root>
      <Popover.Trigger
        className="btn btn-sm"
        title={t("Notes on the chart: {n} of {total} shown", { n: shown, total: annotations.length })}
      >
        <StickyNote size={15} aria-hidden="true" />
        {t("Notes")}
        <span className={`t-num text-[12px] ${shown ? "text-ink-2" : "text-ink-3 line-through"}`}>
          {shown}
        </span>
        <span className="sr-only">
          {" "}
          ({t("{n} of {total} shown", { n: shown, total: annotations.length })})
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="anim-pop floating z-40 w-[min(260px,calc(100vw-32px))] p-1.5 outline-none"
        >
          <div className="px-2.5 pb-1.5 pt-1 text-xs text-ink-3">{t("Show on the chart")}</div>
          <ul className="flex flex-col">
            {kinds.map((k) => {
              const on = !hidden.includes(k.id);
              const Icon = k.icon;
              return (
                <li key={k.id}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => onChange(on ? [...hidden, k.id] : hidden.filter((h) => h !== k.id))}
                    className="row-hover flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-left text-sm"
                  >
                    <span
                      className={`grid h-4 w-4 place-items-center rounded-[4px] border ${on ? "border-ink bg-ink text-fog" : "border-line"}`}
                      aria-hidden="true"
                    >
                      {on && <Check size={11} weight="bold" />}
                    </span>
                    <Icon size={14} weight="fill" aria-hidden="true" style={{ color: k.color }} />
                    <span className="flex-1">{k.label}</span>
                    <span className="t-num text-xs text-ink-3">{counts.get(k.id)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 border-t border-line px-1 pt-1">
            <button
              type="button"
              className="row-hover w-full rounded-[7px] px-2 py-1.5 text-left text-sm text-ink-2"
              onClick={() => onChange(allHidden ? [] : kinds.map((k) => k.id))}
            >
              {allHidden ? t("Show all notes") : t("Hide all notes")}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Notes of one marker: identical titles (a check that failed every night) collapse into one line with a count. */
function NoteList({ items }: { items: Annotation[] }) {
  const groups: { a: Annotation; n: number; last: Annotation }[] = [];
  for (const a of items) {
    const g = groups.find((x) => x.a.title === a.title && x.a.category === a.category);
    if (g) {
      g.n += 1;
      g.last = a;
    } else groups.push({ a, n: 1, last: a });
  }
  const when = (a: Annotation) =>
    new Date(a.ts).toLocaleString(locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <ul className="flex max-h-[min(320px,50vh)] flex-col overflow-y-auto">
      {groups.map(({ a, n, last }, j) => {
        const k = noteKind(a.category);
        const Icon = k.icon;
        return (
          <li key={j} className={`flex gap-2.5 px-1 py-2 ${j ? "border-t border-line" : ""}`}>
            <Icon
              size={15}
              weight="fill"
              aria-hidden="true"
              className="mt-0.5 shrink-0"
              style={{ color: k.color }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold leading-snug">
                  {a.title}
                  {n > 1 && <span className="ml-1.5 font-normal text-ink-2">×{n}</span>}
                </div>
                {a.url && /^https?:\/\//i.test(a.url) && n === 1 && (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={t("Open link")}
                    title={a.url}
                    className="mt-0.5 shrink-0 text-ink-3 hover:text-ink"
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-2">
                <span>{n > 1 ? `${when(a)} – ${when(last)}` : when(a)}</span>
                <span aria-hidden="true">·</span>
                <span style={{ color: k.color }} className="font-medium">
                  {k.label}
                </span>
              </div>
              {a.body && n === 1 && <p className="mt-1 line-clamp-4 text-[12.5px] text-ink-2">{a.body}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export interface Annotation {
  ts: string;
  title: string;
  category?: string | null;
  body?: string | null;
  url?: string | null;
}

interface Props {
  rows: Row[];
  compareRows?: Row[] | null;
  compareLabel?: string;
  xKey: "day" | "hour" | "datehour" | "week" | "month" | "minute_ago";
  metric: string;
  label: string;
  annotations?: Annotation[];
  height?: number;
  /** Draw bars instead of a line (little traffic). */
  bars?: boolean;
  /** Metrics where lower is better (bounce rate): the tooltip's change is green when it falls. */
  invert?: boolean;
  animateKey?: string;
}

/** Re-render charts when the theme changes (system or the toggle). */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", bump);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", bump);
      mo.disconnect();
    };
  }, []);
  return v;
}

function rgba(color: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (m) {
    const n = parseInt(m[1]!, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return `color-mix(in oklab, ${color} ${Math.round(a * 100)}%, transparent)`;
}

/** Seconds (UTC midnight of the local day) for date keys; plain numbers for hours. */
function xValue(v: string | number | null | undefined, key: Props["xKey"]): number {
  if (key === "hour" || key === "minute_ago") return Number(v);
  const s = String(v);
  if (key === "datehour") return Date.parse(`${s.slice(0, 10)}T${s.slice(11, 13)}:00:00Z`) / 1000;
  return Date.parse(`${key === "month" ? `${s}-01` : s}T00:00:00Z`) / 1000;
}

const shortDate = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat(locale, {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const monthName = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" });

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function xLabel(v: string | number | null | undefined, key: Props["xKey"], long = false): string {
  if (v === null || v === undefined) return "";
  if (key === "hour") return `${String(v).padStart(2, "0")}:00`;
  if (key === "minute_ago") return Number(v) === 0 ? t("now") : t("{n} min ago", { n: Math.abs(Number(v)) });
  const s = String(v);
  if (key === "datehour")
    return `${longDate.format(new Date(`${s.slice(0, 10)}T12:00:00Z`))} ${s.slice(11, 13)}:00`;
  if (key === "month") return monthName.format(new Date(`${s}-15T12:00:00Z`));
  const d = new Date(`${s}T12:00:00Z`);
  if (key === "week") return `${long ? `${t("Week of")} ` : ""}${shortDate.format(d)}`;
  if (s === localToday()) return t("Today");
  return (long ? longDate : shortDate).format(d);
}

/** A round top for the axis (1, 2, 2.5 or 5 × 10^n) so the three grid lines carry round numbers. */
function niceTop(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function delta(cur: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

const NONE: Annotation[] = [];
/** Height of the lane above the plot that holds the note markers, and a marker's size (px). */
const LANE = 32;
const MARKER = 24;

interface FlagGroup {
  left: number;
  items: Annotation[];
  showLabel: boolean;
}

export function TimeChart({
  rows,
  compareRows,
  compareLabel = t("previous period"),
  xKey,
  metric,
  label,
  annotations = NONE,
  height = 280,
  bars = false,
  invert = false,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const theme = useThemeVersion();
  const [cursor, setCursor] = useState<{ i: number; left: number } | null>(null);
  const [hoverFlag, setHoverFlag] = useState<number | null>(null);
  const [openFlag, setOpenFlag] = useState<number | null>(null);
  const [flags, setFlags] = useState<FlagGroup[]>([]);
  const [plotBounds, setPlotBounds] = useState<{ top: number; bottom: number; left: number; right: number } | null>(
    null,
  );
  const flagKey = useRef("");
  const lastData = useRef<uPlot.AlignedData | null>(null);

  const xs = useMemo(() => rows.map((r) => xValue(r[xKey], xKey)), [rows, xKey]);
  const ys = useMemo(
    () => rows.map((r) => (r[metric] === null || r[metric] === undefined ? null : Number(r[metric]))),
    [rows, metric],
  );
  const cmp = useMemo(
    () =>
      compareRows
        ? rows.map((_, i) =>
            compareRows[i]?.[metric] === null || compareRows[i]?.[metric] === undefined
              ? null
              : Number(compareRows[i]![metric]),
          )
        : null,
    [rows, compareRows, metric],
  );
  // The last point is unfinished when it is today (or the current hour of today).
  const partial = useMemo(() => {
    const last = rows[rows.length - 1]?.[xKey];
    if (last === undefined || last === null) return false;
    const today = localToday();
    if (xKey === "day") return String(last) === today;
    if (xKey === "datehour") return String(last).slice(0, 10) === today;
    if (xKey === "hour") return true;
    if (xKey === "week" || xKey === "month") return true;
    return false;
  }, [rows, xKey]);
  const timeX = xKey !== "hour" && xKey !== "minute_ago";

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const v = (n: string) => style.getPropertyValue(n).trim();
    const site = v("--site") || v("--ink-2");
    const ghost = v("--ghost");
    const font = `11.5px "Instrument Sans Variable", system-ui`;
    const max = Math.max(...ys.map((y) => y ?? 0), ...(cmp ?? []).map((y) => y ?? 0), 0);
    const top = niceTop(max * 1.05);
    const n = ys.length;
    // Split the series so its last segment can be dashed (unfinished period).
    const done = partial && n > 1 ? ys.map((y, i) => (i < n - 1 ? y : null)) : ys;
    const tail = partial && n > 1 ? ys.map((y, i) => (i >= n - 2 ? y : null)) : ys.map(() => null);
    const spline = uPlot.paths.spline!();
    const series: uPlot.Series[] = [
      {},
      bars
        ? {
            label,
            stroke: site,
            fill: site,
            width: 0,
            paths: uPlot.paths.bars!({ size: [0.62, 28], radius: 0.25, gap: 2 }),
            points: { show: false },
          }
        : {
            label,
            stroke: site,
            width: 2.5,
            paths: spline,
            fill: (u: uPlot) => {
              const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
              g.addColorStop(0, rgba(site, 0.26));
              g.addColorStop(1, rgba(site, 0));
              return g;
            },
            points: { show: false },
          },
      {
        label: t("today so far"),
        stroke: site,
        width: 2.5,
        dash: [5, 5],
        paths: spline,
        points: { show: false },
        show: !bars,
      },
    ];
    if (cmp)
      series.push({
        label: compareLabel,
        stroke: ghost,
        width: 1.5,
        dash: [4, 4],
        paths: bars ? undefined : spline,
        points: { show: false },
      });
    const ann = timeX
      ? annotations
          .map((a) => ({ ...a, x: Date.parse(a.ts) / 1000 }))
          .filter((a) => xs.length && a.x >= xs[0]! - 43200 && a.x <= xs[xs.length - 1]! + 86400)
      : [];

    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      padding: [ann.length ? LANE + 8 : 12, 26, 0, 0],
      legend: { show: false },
      cursor: {
        y: false,
        points: { size: 9, width: 2, fill: v("--surface"), stroke: site },
        drag: { x: false, y: false },
        focus: { prox: 30 },
      },
      scales: { x: { time: timeX }, y: { range: () => [0, top] } },
      axes: [
        {
          stroke: v("--ink-3"),
          grid: { show: false },
          ticks: { show: false },
          font,
          gap: 8,
          values: (_u, vals) =>
            vals.map((x) => {
              if (xKey === "hour") return `${String(x).padStart(2, "0")}:00`;
              if (xKey === "minute_ago") return x === 0 ? t("now") : `${Math.abs(x)}m`;
              const d = new Date(x * 1000);
              const key = d.toISOString().slice(0, 10);
              if (xKey === "month") return monthName.format(d);
              if (xKey === "datehour")
                return d.getUTCHours() === 0
                  ? shortDate.format(d)
                  : `${String(d.getUTCHours()).padStart(2, "0")}:00`;
              return key === localToday() ? t("Today") : shortDate.format(d);
            }),
        },
        {
          stroke: v("--ink-3"),
          grid: { stroke: v("--line-2"), width: 1 },
          ticks: { show: false },
          font,
          size: 46,
          gap: 6,
          splits: () => [0, top / 2, top],
          values: (_u, vals) => vals.map((x) => fmt(x, metric)),
        },
      ],
      series,
      hooks: {
        drawClear: [
          (u) => {
            // Weekends, faintly, on daily charts.
            if (xKey !== "day" || xs.length < 2) return;
            const ctx = u.ctx;
            const step = (u.valToPos(xs[1]!, "x", true) - u.valToPos(xs[0]!, "x", true)) / 2;
            ctx.save();
            ctx.fillStyle = rgba(v("--ink") || "#171a2e", 0.025);
            xs.forEach((x) => {
              const day = new Date(x * 1000).getUTCDay();
              if (day !== 0 && day !== 6) return;
              const cx = u.valToPos(x, "x", true);
              ctx.fillRect(cx - step, u.bbox.top, step * 2, u.bbox.height);
            });
            ctx.restore();
          },
        ],
        draw: [
          (u) => {
            // Markers in the lane above the plot, grouped when closer than a marker's width.
            const pLeft = u.bbox.left / devicePixelRatio;
            const pRight = (u.bbox.left + u.bbox.width) / devicePixelRatio;
            const pTop = u.bbox.top / devicePixelRatio;
            const pBottom = (u.bbox.top + u.bbox.height) / devicePixelRatio;
            const raw: { left: number; first: number; items: Annotation[] }[] = [];
            for (const a of [...ann].sort((p, q) => p.x - q.x)) {
              const left = Math.max(pLeft, Math.min(pRight, u.valToPos(a.x, "x") + pLeft));
              const g = raw[raw.length - 1];
              if (g && left - g.first < MARKER + 10) {
                g.items.push(a);
              } else raw.push({ left, first: left, items: [a] });
            }
            const wideEnough = pRight - pLeft >= 440;
            const groups: FlagGroup[] = raw.map((g, idx) => {
              const prevLeft = idx > 0 ? raw[idx - 1]!.left : pLeft;
              const nextLeft = idx < raw.length - 1 ? raw[idx + 1]!.left : pRight;
              // Expand a single marker into a compact labelled pill only when it has clear breathing room.
              const clearanceLeft = g.left - prevLeft;
              const clearanceRight = nextLeft - g.left;
              const showLabel =
                wideEnough &&
                g.items.length === 1 &&
                clearanceLeft >= 78 &&
                clearanceRight >= 78;
              return { left: g.left, items: g.items, showLabel };
            });
            // Only when the flags or plot bounds moved: a state change re-renders, and a re-render must not loop.
            const key = JSON.stringify([
              Math.round(pTop),
              Math.round(pBottom),
              Math.round(pLeft),
              Math.round(pRight),
              groups.map((g) => [Math.round(g.left), g.items.length, g.showLabel]),
            ]);
            if (key !== flagKey.current) {
              flagKey.current = key;
              setFlags(groups);
              setPlotBounds({ top: pTop, bottom: pBottom, left: pLeft, right: pRight });
            }
          },
        ],
        setCursor: [
          (u) => {
            const i = u.cursor.idx;
            setCursor(
              i === null || i === undefined || (u.cursor.left ?? -1) < 0
                ? null
                : { i, left: (u.cursor.left ?? 0) + u.bbox.left / devicePixelRatio },
            );
          },
        ],
      },
    };
    const data: uPlot.AlignedData = cmp ? [xs, done, tail, cmp] : [xs, done, tail];
    // Morph: a chart with the same points as before starts from the old values and eases to the new ones
    // (data duration), instead of blinking; a different shape is drawn directly.
    const old = lastData.current;
    const morph = !!old && old.length === data.length && old[0]!.length === xs.length && !reducedMotion();
    const plot = new uPlot(opts, morph ? old! : data, el);
    plotRef.current = plot;
    lastData.current = data;
    let raf = 0;
    if (morph) {
      const t0 = performance.now();
      const lerp = (a: (number | null)[], b: (number | null)[], k: number) =>
        b.map((v, i) => (v === null || a[i] === null || a[i] === undefined ? v : a[i]! + (v - a[i]!) * k));
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 480);
        const k = 1 - (1 - p) ** 3;
        plot.setData(
          [
            xs,
            ...data.slice(1).map((s, j) => lerp(old![j + 1] as (number | null)[], s as (number | null)[], k)),
          ] as uPlot.AlignedData,
          false,
        );
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [xs, ys, cmp, partial, compareLabel, xKey, metric, label, annotations, height, theme, bars, timeX]);

  // Arrow keys move the cursor point by point (the chart is focusable).
  const onKey = (e: React.KeyboardEvent) => {
    const u = plotRef.current;
    if (
      !u ||
      !rows.length ||
      (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End")
    )
      return;
    e.preventDefault();
    const cur = cursor?.i ?? (e.key === "ArrowLeft" ? rows.length : -1);
    const i =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, cur + (e.key === "ArrowLeft" ? -1 : 1)));
    u.setCursor({ left: u.valToPos(xs[i]!, "x"), top: u.bbox.top / devicePixelRatio + 10 });
  };

  const row = cursor ? rows[cursor.i] : null;
  const value = row ? Number(row[metric] ?? 0) : 0;
  const prev = cursor && cmp ? cmp[cursor.i] : null;
  const d = row && cmp ? delta(value, prev) : null;
  const good = d !== null && (invert ? d < 0 : d > 0);
  const width = host.current?.clientWidth ?? 600;
  // Notes inside the point under the cursor (from its start to the next point's).
  const pointNotes =
    cursor && timeX && annotations.length
      ? annotations.filter((a) => {
          const x = Date.parse(a.ts) / 1000;
          const from = xs[cursor.i]!;
          const to = xs[cursor.i + 1] ?? from + (xKey === "datehour" ? 3600 : 86400);
          return x >= from && x < to;
        })
      : [];
  const total = rows.reduce((a, r) => a + Number(r[metric] ?? 0), 0);
  return (
    <div className="relative">
      {cmp && (
        <div className="mb-1 flex items-center gap-4 px-1 text-[12.5px] text-ink-2" aria-hidden="true">
          <span className="flex items-center gap-1.5">
            <span className="h-[2.5px] w-4 rounded-full bg-site" /> {label}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-[1.5px] border-dashed border-ghost" />{" "}
            {compareLabel.replace(/^\w/, (c) => c.toUpperCase())}
          </span>
        </div>
      )}
      <div className="relative">
        <div
          ref={host}
          data-chart-mode={bars ? "bars" : "line"}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => plotRef.current?.setCursor({ left: -10, top: -10 })}
          className="rounded-[8px] focus-visible:outline-2"
          style={{ minHeight: height }}
          role="img"
          aria-label={`${t("{label}: {n} points", { label, n: rows.length })}${["visitors", "pageviews", "sessions", "events"].includes(metric) ? `, ${t("total {total}", { total: fmt(total) })}` : ""}. ${t("Use the arrow keys to read each point.")}`}
        />
        {/* Subtle vertical guide stems connect every annotation marker cleanly down to the timeline. */}
        {plotBounds &&
          flags.map((g, k) => {
            const kinds = [...new Set(g.items.map((a) => noteKind(a.category).id))];
            const kind = noteKind(
              kinds.length === 1
                ? kinds[0]
                : g.items.some((a) => a.category === "incident")
                  ? "incident"
                  : kinds[0],
            );
            const active = hoverFlag === k || openFlag === k;
            const stemTop = MARKER + 4;
            const stemHeight = Math.max(0, plotBounds.bottom - stemTop);
            return (
              <div
                key={`stem-${k}`}
                className="pointer-events-none absolute z-[1] transition-opacity duration-150"
                style={{
                  left: g.left,
                  top: stemTop,
                  height: stemHeight,
                  opacity: active ? 1 : 0.42,
                }}
                aria-hidden="true"
              >
                <span
                  className="block h-full -translate-x-1/2"
                  style={{
                    borderLeft: `${active ? 1.5 : 1}px dashed ${kind.color}`,
                  }}
                />
                <span
                  className="absolute bottom-0 left-0 block h-[5px] w-[5px] -translate-x-1/2 translate-y-1/2 rounded-full"
                  style={{ background: kind.color }}
                />
              </div>
            );
          })}
        {/* Markers sit beside the chart image, not inside it: they are buttons. */}
        {flags.map((g, k) => {
          const kinds = [...new Set(g.items.map((a) => noteKind(a.category).id))];
          const kind = noteKind(
            kinds.length === 1
              ? kinds[0]
              : g.items.some((a) => a.category === "incident")
                ? "incident"
                : kinds[0],
          );
          const Icon = kind.icon;
          const active = hoverFlag === k || openFlag === k;
          const grouped = g.items.length > 1;
          return (
            <Popover.Root key={k} onOpenChange={(o) => setOpenFlag(o ? k : openFlag === k ? null : openFlag)}>
              <Popover.Trigger
                className={`absolute top-1 z-[2] inline-flex h-[24px] -translate-x-1/2 items-center justify-center gap-1.5 rounded-full border transition-all duration-150 focus-visible:outline-2 ${
                  g.showLabel ? "max-w-[146px] px-2" : grouped ? "px-2" : "w-[24px] px-0"
                }`}
                style={{
                  left: g.left,
                  color: kind.color,
                  background: active
                    ? `color-mix(in oklab, ${kind.color} 16%, var(--surface))`
                    : `color-mix(in oklab, ${kind.color} 9%, var(--surface))`,
                  borderColor: active
                    ? `color-mix(in oklab, ${kind.color} 60%, var(--line))`
                    : `color-mix(in oklab, ${kind.color} 32%, var(--line))`,
                  boxShadow: active ? "0 2px 6px rgba(0, 0, 0, 0.14)" : "0 1px 2px rgba(0, 0, 0, 0.06)",
                }}
                onMouseEnter={() => setHoverFlag(k)}
                onMouseLeave={() => setHoverFlag(null)}
                onFocus={() => setHoverFlag(k)}
                onBlur={() => setHoverFlag(null)}
                aria-label={
                  grouped
                    ? t("{n} notes", { n: g.items.length })
                    : `${kind.label}: ${g.items[0]!.title}`
                }
              >
                <Icon size={12} weight="fill" aria-hidden="true" className="shrink-0" />
                {g.showLabel && (
                  <span className="truncate text-[11.5px] font-medium leading-none text-ink">
                    {g.items[0]!.title}
                  </span>
                )}
                {grouped && (
                  <span className="t-num text-[11px] font-semibold leading-none text-ink">
                    {g.items.length}
                  </span>
                )}
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="bottom"
                  sideOffset={6}
                  collisionPadding={12}
                  className="anim-pop floating z-40 w-[min(320px,calc(100vw-32px))] px-3 py-1.5 text-[13px] outline-none"
                >
                  <NoteList items={g.items} />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          );
        })}
      </div>
      {row && cursor && (
        <div
          className="floating pointer-events-none absolute top-8 z-[3] min-w-[170px] px-3 py-2 text-[12.5px]"
          style={{ left: Math.max(4, Math.min(cursor.left + 14, width - 190)) }}
          role="status"
        >
          <div className="mb-1 text-ink-2">{xLabel(row[xKey], xKey, true)}</div>
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span className="swatch" aria-hidden="true" />
              {label}
            </span>
            <strong className="tabular">{fmt(row[metric], metric)}</strong>
          </div>
          {cmp && (
            <div className="mt-0.5 flex items-center justify-between gap-4 text-ink-2">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 border-t-[1.5px] border-dashed border-ghost" aria-hidden="true" />
                {t("Previous")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="tabular">{fmt(prev, metric)}</span>
                {d !== null && (
                  <span className={`delta ${d === 0 ? "delta-flat" : good ? "delta-up" : "delta-down"}`}>
                    {d > 0 ? "↗" : d < 0 ? "↘" : "→"} {fmt(Math.abs(d), "change_pct")}
                  </span>
                )}
              </span>
            </div>
          )}
          {pointNotes.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-0.5 border-t border-line pt-1.5">
              {pointNotes.slice(0, 3).map((a, j) => {
                const k = noteKind(a.category);
                const Icon = k.icon;
                return (
                  <li key={j} className="flex items-center gap-1.5 text-[12px] text-ink-2">
                    <Icon
                      size={12}
                      weight="fill"
                      aria-hidden="true"
                      className="shrink-0"
                      style={{ color: k.color }}
                    />
                    <span className="truncate">{a.title}</span>
                  </li>
                );
              })}
              {pointNotes.length > 3 && (
                <li className="text-[11.5px] text-ink-3">
                  {t("and {n} more", { n: pointNotes.length - 3 })}
                </li>
              )}
            </ul>
          )}
          {partial && cursor.i === rows.length - 1 && (
            <div className="mt-1 text-[11.5px] text-ink-3">{t("So far: this period isn't over")}</div>
          )}
        </div>
      )}
    </div>
  );
}

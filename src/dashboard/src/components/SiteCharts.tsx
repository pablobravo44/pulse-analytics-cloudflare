// Small SVG charts of the home page. Marks follow docs/DESIGN.md: 2 px lines in the site's colour, a soft area under
// them, the comparison as a thin dashed ghost, a 2 px surface gap between stacked fills, three faint grid lines, and a
// hover layer (crosshair + tooltip) on every plot. Curves are monotone, so they never overshoot the data.
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmt } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";

type Pt = [number, number];

/** Monotone cubic (Fritsch–Carlson) path through points sorted by x. */
export function monotonePath(pts: Pt[]): string {
  const n = pts.length;
  if (!n) return "";
  if (n === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    m.push((pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1));
  }
  const tan: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++)
    tan.push(
      m[i - 1]! * m[i]! <= 0
        ? 0
        : (3 * (dx[i - 1]! + dx[i]!)) /
            ((2 * dx[i]! + dx[i - 1]!) / m[i - 1]! + (dx[i]! + 2 * dx[i - 1]!) / m[i]!),
    );
  tan.push(m[n - 2]!);
  let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${(x0 + h).toFixed(1)},${(y0 + tan[i]! * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - tan[i + 1]! * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/** A "nice" top for the y axis (1, 2 or 5 × 10^n), so grid labels are round. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x + 12, 0), width - 190);
  return (
    <div
      className="floating pointer-events-none absolute top-2 z-10 w-[180px] px-3 py-2 text-[12.5px]"
      style={{ left }}
      role="status"
    >
      {children}
    </div>
  );
}

export interface RiverSeries {
  id: string;
  name: string;
  color: string; // s1…s12
  values: number[]; // 24 hours
}

/**
 * Today's visitors per hour, stacked by site in each site's colour, with yesterday's total as a dashed ghost line and
 * a mark at the current hour.
 */
/** The element's width in CSS pixels, so SVG text stays at its real size (11 px) on any screen. */
function useWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function River({
  series,
  yesterday,
  nowHour,
  height = 220,
}: {
  series: RiverSeries[];
  yesterday: number[];
  nowHour: number;
  height?: number;
}) {
  const [box, W] = useWidth(720);
  const H = height;
  const pad = { l: 30, r: 12, t: 16, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const [hover, setHover] = useState<number | null>(null);
  const totals = Array.from({ length: 24 }, (_, h) =>
    series.reduce((a, s) => a + (h <= nowHour ? (s.values[h] ?? 0) : 0), 0),
  );
  const max = niceMax(Math.max(...totals, ...yesterday, 1));
  const x = (h: number) => pad.l + (h / 23) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const hours = Array.from({ length: nowHour + 1 }, (_, h) => h);
  // Bottom-up stacks in the sites' fixed order.
  const stacks = useMemo(() => {
    const base = new Array(24).fill(0) as number[];
    return series.map((s) => {
      const lower = hours.map((h) => base[h]!);
      const upper = hours.map((h) => (base[h] = base[h]! + (s.values[h] ?? 0)));
      return { s, lower, upper };
    });
  }, [series, nowHour]);
  const area = (lower: number[], upper: number[]) => {
    const top = monotonePath(hours.map((h, i) => [x(h), y(upper[i]!)]));
    const bottom = monotonePath(
      [...hours].reverse().map((h, i) => [x(h), y(lower[hours.length - 1 - i]!)]),
    ).replace(/^M/, "L");
    return `${top} ${bottom} Z`;
  };
  const onMove = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const h = Math.round((((e.clientX - r.left) / r.width) * W - pad.l) / (iw / 23));
    setHover(h >= 0 && h <= 23 ? h : null);
  };
  return (
    <div ref={box} className="relative" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block max-w-full"
        role="img"
        aria-label={t(
          "Visitors per hour today by site, with yesterday as a dashed line. Now: {n} this hour.",
          { n: totals[nowHour] ?? 0 },
        )}
      >
        {[0, max / 2, max].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} stroke="var(--line-2)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(g) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
              {fmt(g)}
            </text>
          </g>
        ))}
        {(W < 420 ? [0, 12, 23] : [0, 6, 12, 18, 23]).map((h) => (
          <text
            key={h}
            x={x(h)}
            y={H - 6}
            textAnchor={h === 0 ? "start" : h === 23 ? "end" : "middle"}
            className="fill-ink-3 text-[11px]"
          >
            {String(h).padStart(2, "0")}:00
          </text>
        ))}
        {stacks.map(({ s, lower, upper }) => (
          <g key={s.id} data-site={s.color}>
            <path d={area(lower, upper)} fill="var(--site)" fillOpacity={0.85} />
            {/* 2 px surface gap above each band so neighbours read apart. */}
            <path
              d={monotonePath(hours.map((h, i) => [x(h), y(upper[i]!)]))}
              fill="none"
              stroke="var(--surface)"
              strokeWidth={2}
            />
          </g>
        ))}
        <path
          d={monotonePath(yesterday.map((v, h) => [x(h), y(v)]))}
          fill="none"
          stroke="var(--ghost)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
        <line
          x1={x(nowHour)}
          x2={x(nowHour)}
          y1={pad.t - 6}
          y2={pad.t + ih}
          stroke="var(--ink)"
          strokeWidth={1.5}
        />
        <circle cx={x(nowHour)} cy={pad.t - 6} r={3.5} fill="var(--ink)" />
        <text
          x={x(nowHour) + (x(nowHour) > W - 48 ? -7 : 7)}
          y={pad.t - 2}
          textAnchor={x(nowHour) > W - 48 ? "end" : "start"}
          className="fill-ink text-[11px] font-semibold"
        >
          {t("now")}
        </text>
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={pad.t}
            y2={pad.t + ih}
            stroke="var(--line-strong)"
            strokeWidth={1}
          />
        )}
      </svg>
      {hover !== null && (
        <Tooltip x={(x(hover) / W) * (box.current?.clientWidth ?? W)} width={box.current?.clientWidth ?? W}>
          <div className="mb-1 font-semibold">
            {String(hover).padStart(2, "0")}:00–{String(hover).padStart(2, "0")}:59
          </div>
          {series.map((s) => (
            <div key={s.id} data-site={s.color} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <span className="swatch" aria-hidden="true" />
                {s.name}
              </span>
              <span className="font-semibold">{hover <= nowHour ? fmt(s.values[hover] ?? 0) : "–"}</span>
            </div>
          ))}
          <div className="mt-1 flex justify-between border-t border-line pt-1 text-ink-2">
            <span>{t("Yesterday")}</span>
            <span>{fmt(yesterday[hover] ?? 0)}</span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * A site's card chart: the period as an area in the site's colour with the previous period as a dashed ghost; with
 * little traffic (`bars`), rounded bars instead, which read "one visit on Tuesday" better than a flat line.
 */
export function CardChart({
  values,
  previous,
  labels,
  bars,
  height = 84,
}: {
  values: number[];
  previous: number[];
  labels: string[];
  bars: boolean;
  height?: number;
}) {
  const W = 400;
  const H = height;
  const pad = 4;
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const gid = `g${useId().replace(/:/g, "")}`;
  const n = values.length;
  const max = Math.max(...values, ...previous, 1);
  // Bars sit in equal slots (centre of slot i); the line runs edge to edge.
  const x = (i: number) => (bars ? ((i + 0.5) / n) * W : n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const onMove = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    const i = bars ? Math.floor(rel * n) : Math.round(rel * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const line = monotonePath(values.map((v, i) => [x(i), y(v)]));
  return (
    <div ref={box} className="relative" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height: H }}
        role="img"
        aria-label={t("Visitors: {n} in the period", { n: values.reduce((a, b) => a + b, 0) })}
      >
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--site)" stopOpacity={0.26} />
            <stop offset="1" stopColor="var(--site)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {bars ? null : (
          <>
            <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${gid})`} />
            <path
              d={monotonePath(previous.map((v, i) => [x(i), y(v)]))}
              fill="none"
              stroke="var(--ghost)"
              strokeWidth={1.25}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={line}
              fill="none"
              stroke="var(--site)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        {hover !== null && !bars && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={0}
            y2={H}
            stroke="var(--line-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {bars && (
        // HTML, not the stretched SVG: bars keep round corners and even gaps at any card width.
        <div className="absolute inset-0 flex items-end gap-[6px] px-1 pb-1" aria-hidden="true">
          {values.map((v, i) => (
            <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center">
              <span
                // A day with no visitors keeps a hairline, so it reads as zero rather than as a missing day.
                className={`block w-full max-w-[44px] transition-opacity ${v ? "rounded-t-[5px] rounded-b-[2px] bg-site" : "rounded-[1px] bg-line-strong"}`}
                style={{
                  height: v ? `max(3px, ${(v / max) * 100}%)` : 2,
                  opacity: hover === null || hover === i ? 1 : 0.5,
                }}
              />
            </div>
          ))}
        </div>
      )}
      {hover !== null && (
        <Tooltip x={(x(hover) / W) * (box.current?.clientWidth ?? W)} width={box.current?.clientWidth ?? W}>
          <div className="mb-1 font-semibold">{labels[hover]}</div>
          <div className="flex justify-between">
            <span>{t("Visitors")}</span>
            <span className="font-semibold">{fmt(values[hover])}</span>
          </div>
          <div className="flex justify-between text-ink-2">
            <span>{t("Before")}</span>
            <span>{fmt(previous[hover] ?? 0)}</span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

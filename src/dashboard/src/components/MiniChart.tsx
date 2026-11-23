// A small series chart for rows: a 2 px monotone line with a soft area (rounded bars when there are few points), a hover
// tooltip and an end dot. The colour is the site's, or the "bad" tone for errors (always paired with text, never alone).
import { useId, useRef, useState } from "react";
import { fmt } from "../lib/api.ts";
import { monotonePath } from "./SiteCharts.tsx";
import { t } from "../lib/i18n.ts";

export function MiniChart({
  values,
  labels,
  unit = "",
  tone = "site",
  height = 40,
  className = "",
}: {
  values: number[];
  labels?: string[];
  unit?: string;
  tone?: "site" | "bad";
  height?: number;
  className?: string;
}) {
  const W = 200;
  const H = height;
  const pad = 4;
  const gid = `m${useId().replace(/:/g, "")}`;
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const color = tone === "bad" ? "var(--bad)" : "var(--site)";
  const n = values.length;
  if (!n) return <span className="text-ink-3">–</span>;
  const max = Math.max(...values, 1);
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const bars = n < 8;
  const line = monotonePath(values.map((v, i) => [x(i), y(v)]));
  const onMove = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    const i = bars ? Math.floor(f * n) : Math.round(f * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <div
      ref={box}
      className={`relative ${className}`}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full overflow-visible"
        style={{ height: H }}
        role="img"
        aria-label={t("{total} over {n} points", { total: `${fmt(total)}${unit ? ` ${unit}` : ""}`, n })}
      >
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity={0.22} />
            <stop offset="1" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {bars ? (
          values.map((v, i) => {
            const slot = W / n;
            const bw = Math.min(slot - 4, 22);
            const h = v ? Math.max(3, H - pad - y(v)) : 0;
            return (
              <rect
                key={i}
                x={slot * i + (slot - bw) / 2}
                y={H - pad - h}
                width={bw}
                height={h}
                rx={Math.min(4, bw / 2)}
                fill={color}
                opacity={hover === null || hover === i ? 1 : 0.5}
              />
            );
          })
        ) : (
          <>
            <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${gid})`} />
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {hover !== null && (
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
          </>
        )}
      </svg>
      {hover !== null && (
        <div
          className="floating pointer-events-none absolute -top-1 z-10 whitespace-nowrap px-2.5 py-1.5 text-[12px]"
          style={{
            left: `${Math.min(Math.max((bars ? (hover + 0.5) / n : hover / Math.max(n - 1, 1)) * 100, 12), 88)}%`,
            transform: "translate(-50%, -100%)",
          }}
          role="status"
        >
          {labels?.[hover] && <span className="mr-2 text-ink-2">{labels[hover]}</span>}
          <span className="font-semibold">{fmt(values[hover])}</span>
          {unit ? ` ${unit}` : ""}
        </div>
      )}
    </div>
  );
}

// Small charts: weekday × hour heat grid, journeys flow.
import { fmt, type Row } from "../lib/api.ts";
import { locale, t } from "../lib/i18n.ts";

// Weekday names from Intl in the interface language, Monday first (2024-01-01 was a Monday).
const DAYS = Array.from({ length: 7 }, (_, i) =>
  new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + i))),
);

/** When visitors come: weekday (0 = Sunday) × hour cells in ink opacity. */
export function HeatGrid({ rows, metric = "visitors" }: { rows: Row[]; metric?: string }) {
  const grid = new Map<string, number>();
  for (const r of rows) grid.set(`${r.weekday}-${r.hour}`, Number(r[metric] ?? 0));
  const max = Math.max(1, ...grid.values());
  const peak = [...grid.entries()].sort((a, b) => b[1] - a[1])[0];
  const peakText = peak
    ? `${DAYS[(Number(peak[0].split("-")[0]) + 6) % 7]} ${peak[0].split("-")[1]}:00`
    : null;
  return (
    <div>
      <div className="overflow-x-auto">
        <table
          className="w-full border-separate border-spacing-[2px] text-[11px]"
          aria-label={t("Visitors by weekday and hour")}
        >
          <thead>
            <tr>
              <th>
                <span className="sr-only">{t("Day")}</span>
              </th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="font-normal text-ink-3">
                  {h % 3 === 0 ? h : <span className="sr-only">{h}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
              <tr key={wd}>
                <th className="pr-2 text-left font-normal text-ink-2">{DAYS[(wd + 6) % 7]}</th>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = grid.get(`${wd}-${h}`) ?? 0;
                  // One hue (the site's), light to dark with the count; an empty hour is the faint base.
                  return (
                    <td
                      key={h}
                      className="h-5 min-w-[10px] rounded-[4px]"
                      style={{
                        background: v
                          ? `color-mix(in oklab, var(--site, var(--ink-2)) ${Math.round(14 + 86 * (v / max))}%, var(--line-2))`
                          : "var(--line-2)",
                      }}
                      title={`${DAYS[(wd + 6) % 7]} ${h}:00, ${fmt(v, metric)}`}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {peakText && (
        <p className="mt-2 text-[13px] text-ink-2">{t("Busiest hour: {when}.", { when: peakText })}</p>
      )}
    </div>
  );
}

/** Journeys as columns of steps: each path "a → b → c" contributes its count to every step it passes. */
export function JourneyFlow({ start, paths }: { start: string; paths: { path: string; count: number }[] }) {
  const cols: Map<string, number>[] = [new Map([[start, paths.reduce((a, p) => a + p.count, 0)]])];
  const links: Map<string, number>[] = [];
  for (const p of paths) {
    const steps = p.path.split(" → ");
    let prev = start;
    steps.forEach((s, i) => {
      (cols[i + 1] ??= new Map()).set(s, (cols[i + 1]!.get(s) ?? 0) + p.count);
      (links[i] ??= new Map()).set(`${prev}\u0000${s}`, (links[i]!.get(`${prev}\u0000${s}`) ?? 0) + p.count);
      prev = s;
    });
  }
  const top = cols.map((c) => [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
  const colW = 200;
  const gap = 70;
  const rowH = 36;
  const height = Math.max(...top.map((c) => c.length)) * (rowH + 8) + 8;
  const pos = (ci: number, name: string) => {
    const i = top[ci]!.findIndex(([n]) => n === name);
    return i < 0 ? null : { x: ci * (colW + gap), y: 8 + i * (rowH + 8) };
  };
  const total = top[0]![0]?.[1] ?? 1;
  return (
    <div className="overflow-x-auto">
      <svg width={top.length * (colW + gap) - gap} height={height} role="img" aria-label={t("Journeys flow")}>
        {links.map((l, ci) =>
          [...l.entries()].map(([k, n]) => {
            const [a, b] = k.split("\u0000") as [string, string];
            const p1 = pos(ci, a);
            const p2 = pos(ci + 1, b);
            if (!p1 || !p2) return null;
            const x1 = p1.x + colW;
            const y1 = p1.y + rowH / 2;
            const x2 = p2.x;
            const y2 = p2.y + rowH / 2;
            return (
              <path
                key={`${ci}-${k}`}
                d={`M${x1},${y1} C${x1 + gap / 2},${y1} ${x2 - gap / 2},${y2} ${x2},${y2}`}
                fill="none"
                stroke="var(--ink)"
                strokeOpacity={0.12 + 0.5 * (n / total)}
                strokeWidth={Math.max(1.5, 14 * (n / total))}
              />
            );
          }),
        )}
        {top.map((col, ci) =>
          col.map(([name, n], i) => (
            <g key={`${ci}-${name}`} transform={`translate(${ci * (colW + gap)},${8 + i * (rowH + 8)})`}>
              <rect
                width={colW}
                height={rowH}
                rx={4}
                fill={ci === 0 ? "var(--ink)" : "var(--sheet)"}
                stroke="var(--rule)"
              />
              <rect
                width={colW * (n / total)}
                height={3}
                y={rowH - 3}
                fill={ci === 0 ? "var(--mark)" : "var(--ink)"}
                opacity={0.6}
              />
              <text x={10} y={rowH / 2 + 4} fontSize={12.5} fill={ci === 0 ? "var(--paper)" : "var(--ink)"}>
                {name.length > 22 ? `${name.slice(0, 21)}…` : name}
              </text>
              <text
                x={colW - 8}
                y={rowH / 2 + 4}
                fontSize={12}
                textAnchor="end"
                fill={ci === 0 ? "var(--paper)" : "var(--ink-2)"}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {n}
              </text>
            </g>
          )),
        )}
      </svg>
    </div>
  );
}

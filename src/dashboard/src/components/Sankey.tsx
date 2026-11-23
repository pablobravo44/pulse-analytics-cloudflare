// A light SVG Sankey of journeys. Each path "a → b → c" (as the paths API returns it) adds its count to every step it
// passes; columns are steps, node height and flow width are sessions, in the site's colour at reduced opacity. Hovering a
// flow or a node lifts it and shows a tooltip. "previous" journeys read right to left, ending at the start page.
import { useMemo, useRef, useState } from "react";
import { fmt } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";

interface PathRow {
  path: string;
  count: number;
}
interface SNode {
  id: string;
  col: number;
  name: string;
  total: number;
  y: number;
  h: number;
  x: number;
  kind: "page" | "other" | "end";
  out: number;
  inn: number;
}
interface Merged {
  from: SNode;
  to: SNode;
  n: number;
}
interface SLink extends Merged {
  key: string;
  sy: number;
  ty: number;
}

const MAX_PER_COL = 6;
const NODE_W = 12;
const STEP = 230;
const TAIL = 170;
const HEIGHT = 360;
const GAP = 10;
const OTHER = "\u0001other";

const END_NAMES = new Set(["(exit)", "(entrance)"]);
const nice = (name: string) =>
  name === "(exit)" ? t("Leaves the site") : name === "(entrance)" ? t("Entered here") : name;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function Sankey({
  start,
  paths,
  direction,
  occurrences,
}: {
  start: string;
  paths: PathRow[];
  direction: "next" | "previous";
  occurrences: number;
}) {
  const [hover, setHover] = useState<{ type: "link"; key: string } | { type: "node"; id: string } | null>(
    null,
  );
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const g = useMemo(() => {
    const rev = direction === "previous";
    const cols: Map<string, number>[] = [new Map([[start, paths.reduce((a, p) => a + p.count, 0)]])];
    const edges = new Map<string, { c: number; a: string; b: string; n: number }>();
    for (const p of paths) {
      const steps = p.path.split(" → ");
      let prev = start;
      steps.forEach((s, i) => {
        const c = (cols[i + 1] ??= new Map());
        c.set(s, (c.get(s) ?? 0) + p.count);
        const k = `${i}\u0000${prev}\u0000${s}`;
        const e = edges.get(k) ?? { c: i, a: prev, b: s, n: 0 };
        e.n += p.count;
        edges.set(k, e);
        prev = s;
      });
    }
    // Keep the biggest pages per column; the rest share one "Other pages" node so the flows stay honest.
    const keep = cols.map((c, ci) => {
      if (ci === 0) return new Set([start]);
      const sorted = [...c.entries()].sort((a, b) => b[1] - a[1]);
      const real = sorted.filter(([n]) => !END_NAMES.has(n)).slice(0, MAX_PER_COL);
      const ends = sorted.filter(([n]) => END_NAMES.has(n));
      return new Set([...real, ...ends].map(([n]) => n));
    });
    const nodes = new Map<string, SNode>();
    const nodeFor = (ci: number, name: string): SNode => {
      const nm = keep[ci]?.has(name) ? name : OTHER;
      const id = `${ci}\u0000${nm}`;
      let n = nodes.get(id);
      if (!n) {
        n = {
          id,
          col: ci,
          name: nm,
          total: 0,
          y: 0,
          h: 0,
          x: 0,
          kind: nm === OTHER ? "other" : END_NAMES.has(nm) ? "end" : "page",
          out: 0,
          inn: 0,
        };
        nodes.set(id, n);
      }
      return n;
    };
    const root = nodeFor(0, start);
    const merged = new Map<string, Merged>();
    for (const e of edges.values()) {
      const from = nodeFor(e.c, e.a);
      const to = nodeFor(e.c + 1, e.b);
      const k = `${from.id}>${to.id}`;
      const m = merged.get(k) ?? { from, to, n: 0 };
      m.n += e.n;
      merged.set(k, m);
    }
    for (const m of merged.values()) {
      m.from.out += m.n;
      m.to.inn += m.n;
    }
    root.total = Math.max(root.out, 1);
    for (const n of nodes.values()) if (n.col > 0) n.total = n.inn;
    const nCols = cols.length;
    const byCol: SNode[][] = Array.from({ length: nCols }, () => []);
    for (const n of nodes.values()) byCol[n.col]?.push(n);
    const rank = (n: SNode) => (n.kind === "other" ? 2 : n.kind === "end" ? 1 : 0);
    for (const c of byCol) c.sort((a, b) => rank(a) - rank(b) || b.total - a.total);
    const scale = Math.min(
      ...byCol
        .filter((c) => c.length)
        .map(
          (c) =>
            (HEIGHT - 20 - GAP * (c.length - 1)) /
            Math.max(
              1,
              c.reduce((a, n) => a + n.total, 0),
            ),
        ),
    );
    const offset = rev ? TAIL : 0;
    byCol.forEach((c, ci) => {
      const colH = c.reduce((a, n) => a + Math.max(2, n.total * scale), 0) + GAP * Math.max(0, c.length - 1);
      let y = (HEIGHT - colH) / 2;
      for (const n of c) {
        n.h = Math.max(2, n.total * scale);
        n.y = y;
        n.x = offset + (rev ? nCols - 1 - ci : ci) * STEP;
        y += n.h + GAP;
      }
    });
    // Stack the flows inside each node, ordered by the node at the other end so they do not cross needlessly.
    const outs = new Map<string, Merged[]>();
    const ins = new Map<string, Merged[]>();
    for (const m of merged.values()) {
      outs.set(m.from.id, [...(outs.get(m.from.id) ?? []), m]);
      ins.set(m.to.id, [...(ins.get(m.to.id) ?? []), m]);
    }
    const sy = new Map<Merged, number>();
    const ty = new Map<Merged, number>();
    for (const [id, list] of outs) {
      let y = nodes.get(id)?.y ?? 0;
      for (const m of [...list].sort((a, b) => a.to.y - b.to.y)) {
        sy.set(m, y);
        y += m.n * scale;
      }
    }
    for (const [id, list] of ins) {
      let y = nodes.get(id)?.y ?? 0;
      for (const m of [...list].sort((a, b) => a.from.y - b.from.y)) {
        ty.set(m, y);
        y += m.n * scale;
      }
    }
    const links: SLink[] = [...merged].map(([key, m]) => ({
      ...m,
      key,
      sy: sy.get(m) ?? m.from.y,
      ty: ty.get(m) ?? m.to.y,
    }));
    return {
      nodes: [...nodes.values()],
      links,
      scale,
      width: offset + (nCols - 1) * STEP + NODE_W + TAIL,
      rev,
    };
  }, [start, paths, direction]);

  const total = Math.max(1, occurrences);
  const hotLink = (l: SLink) =>
    hover?.type === "link"
      ? hover.key === l.key
      : hover?.type === "node"
        ? l.from.id === hover.id || l.to.id === hover.id
        : null;
  const label = (n: SNode) => (n.kind === "other" ? t("Other pages") : nice(n.name));
  const active = hover?.type === "link" ? g.links.find((l) => l.key === hover.key) : undefined;
  const activeNode = hover?.type === "node" ? g.nodes.find((n) => n.id === hover.id) : undefined;
  const pct = (n: number) => fmt(Math.round((n / total) * 1000) / 10);

  return (
    <div
      className="overflow-x-auto px-1"
      tabIndex={0}
      role="region"
      aria-label={t("Journeys flow. The list view has the same data as text.")}
    >
      <div
        ref={box}
        className="relative"
        style={{ width: g.width, height: HEIGHT }}
        onPointerMove={(e) => {
          const r = box.current?.getBoundingClientRect();
          if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top });
        }}
        onPointerLeave={() => (setHover(null), setTip(null))}
      >
        <svg
          width={g.width}
          height={HEIGHT}
          role="img"
          aria-label={
            direction === "next"
              ? t("Journeys after {start}", { start })
              : t("Journeys before {start}", { start })
          }
        >
          {g.links.map((l) => {
            const [a, b] = g.rev ? [l.to, l.from] : [l.from, l.to];
            const [ya, yb] = g.rev ? [l.ty, l.sy] : [l.sy, l.ty];
            const w = Math.max(1.5, l.n * g.scale);
            const x1 = a.x + NODE_W;
            const x2 = b.x;
            const y1 = ya + w / 2;
            const y2 = yb + w / 2;
            const hot = hotLink(l);
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={l.key}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                fill="none"
                stroke={l.to.kind === "end" ? "var(--ghost)" : "var(--site)"}
                strokeWidth={w}
                strokeOpacity={hot === null ? 0.28 : hot ? 0.6 : 0.1}
                style={{ transition: "stroke-opacity var(--motion-quick)" }}
                onPointerEnter={() => setHover({ type: "link", key: l.key })}
              />
            );
          })}
          {g.nodes.map((n) => {
            const right = !g.rev || n.col === 0;
            const lx = right ? n.x + NODE_W + 8 : n.x - 8;
            const anchor = right ? "start" : "end";
            // Two lines of label need ~30 px: smaller nodes show theirs on hover or focus, so labels never collide.
            const labelled = n.col === 0 || n.h + GAP >= 30 || (hover?.type === "node" && hover.id === n.id);
            return (
              <g
                key={n.id}
                role="img"
                onPointerEnter={() => setHover({ type: "node", id: n.id })}
                onFocus={() => setHover({ type: "node", id: n.id })}
                onBlur={() => setHover(null)}
                aria-label={t("{name}: {n} sessions", { name: label(n), n: n.total })}
              >
                <rect
                  x={n.x}
                  y={n.y}
                  width={NODE_W}
                  height={n.h}
                  rx={3}
                  fill={n.kind === "end" ? "var(--ghost)" : "var(--site)"}
                  opacity={n.col === 0 ? 1 : n.kind === "other" ? 0.45 : 0.85}
                />
                {labelled && (
                  <>
                    <text
                      x={lx}
                      y={n.y + n.h / 2 - 8}
                      fontSize={12.5}
                      fontWeight={600}
                      fill="var(--ink)"
                      textAnchor={anchor}
                      dominantBaseline="middle"
                      stroke="var(--surface)"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {clip(label(n), 24)}
                    </text>
                    <text
                      x={lx}
                      y={n.y + n.h / 2 + 8}
                      fontSize={11.5}
                      fill="var(--ink-2)"
                      textAnchor={anchor}
                      dominantBaseline="middle"
                      stroke="var(--surface)"
                      strokeWidth={3}
                      paintOrder="stroke"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {fmt(n.total)} · {Math.round((n.total / total) * 100)}%
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (active || activeNode) && (
          <div
            className="floating pointer-events-none absolute z-10 max-w-[260px] px-3 py-2 text-[12.5px]"
            style={{ left: Math.max(0, Math.min(tip.x + 14, g.width - 270)), top: Math.max(tip.y - 56, 0) }}
            role="status"
          >
            {active ? (
              <>
                <div className="font-semibold">
                  {clip(label(g.rev ? active.to : active.from), 28)} →{" "}
                  {clip(label(g.rev ? active.from : active.to), 28)}
                </div>
                <div className="text-ink-2">
                  {t("{n} sessions · {pct}% of visits", { n: fmt(active.n), pct: pct(active.n) })}
                </div>
              </>
            ) : (
              activeNode && (
                <>
                  <div className="font-semibold">{clip(label(activeNode), 40)}</div>
                  <div className="text-ink-2">
                    {t("{n} sessions · {pct}% of visits", {
                      n: fmt(activeNode.total),
                      pct: pct(activeNode.total),
                    })}
                  </div>
                </>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

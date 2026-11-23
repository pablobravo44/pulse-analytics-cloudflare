// Motion answers something that happened (a new range, a new visit, another tab) or doesn't happen at all
// (docs/DESIGN.md). Durations come from the CSS tokens: quick 120 ms, base 220 ms, data 450–520 ms.
// With prefers-reduced-motion everything here jumps straight to its end state.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export const DATA_MS = 450;

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * A number that counts from its previous value to the new one (450 ms, easing out), never from zero: the first value
 * shows as it is. Text width is reserved by tabular figures, so the layout doesn't move while it counts.
 */
export function CountUp({
  value,
  format,
}: {
  value: number | null | undefined;
  format: (v: number | null | undefined) => string;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (
      value === null ||
      value === undefined ||
      start === null ||
      start === undefined ||
      start === value ||
      reducedMotion() ||
      !Number.isFinite(value) ||
      !Number.isFinite(start)
    ) {
      setShown(value);
      return;
    }
    // Keep decimals when the value has them (1.9 views per session), whole numbers otherwise.
    const decimals = Number.isInteger(value) && Number.isInteger(start) ? 0 : 1;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / DATA_MS);
      const v = start + (value - start) * easeOut(p);
      setShown(p < 1 ? Number(v.toFixed(decimals)) : value);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(shown)}</>;
}

/**
 * FLIP for lists: when the items reorder, each moves from where it was to where it is now (base duration) instead of
 * jumping. Items carry data-flip="<stable key>".
 */
export function useFlip(container: RefObject<HTMLElement | null>, deps: unknown[]) {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>("[data-flip]")];
    const now = new Map(items.map((n) => [n.dataset.flip!, n.getBoundingClientRect().top]));
    if (!reducedMotion()) {
      for (const n of items) {
        const before = last.current.get(n.dataset.flip!);
        const after = now.get(n.dataset.flip!)!;
        if (before === undefined || Math.abs(before - after) < 1) continue;
        n.animate([{ transform: `translateY(${before - after}px)` }, { transform: "none" }], {
          duration: 220,
          easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
        });
      }
    }
    last.current = now;
  }, deps);
}

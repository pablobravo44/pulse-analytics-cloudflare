import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "./icons.tsx";
import { t } from "../lib/i18n.ts";

export interface SideNavItem {
  id: string;
  label: string;
  icon?: LucideIcon;
}

const base =
  "flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left text-[13.5px] transition-colors";
const on = "bg-surface font-semibold text-ink ring-1 ring-line";
const off = "text-ink-2 hover:bg-hover hover:text-ink";

/**
 * Section navigation: a sticky list beside the content on desktop, a select on narrow screens.
 * `item` renders each entry (a router Link or an anchor) with the classes and content to use.
 */
export function SideNav({
  items,
  active,
  label,
  onSelect,
  item,
}: {
  items: SideNavItem[];
  active: string;
  label: string;
  onSelect: (id: string) => void;
  item: (it: SideNavItem, className: string, content: ReactNode, current: boolean) => ReactNode;
}) {
  return (
    <>
      <select
        className="input lg:hidden"
        aria-label={t("{label}, jump to", { label })}
        value={active}
        onChange={(e) => onSelect(e.target.value)}
      >
        {items.map((it) => (
          <option key={it.id} value={it.id}>
            {it.label}
          </option>
        ))}
      </select>
      <nav
        aria-label={label}
        className="hidden lg:sticky lg:top-6 lg:flex lg:flex-col lg:gap-0.5 lg:self-start"
      >
        {items.map((it) => {
          const current = it.id === active;
          const Icon = it.icon;
          return item(
            it,
            `${base} ${current ? on : off}`,
            <>
              {Icon && (
                <Icon
                  size={16}
                  aria-hidden="true"
                  className={`shrink-0 ${current ? "text-ink" : "text-ink-3"}`}
                />
              )}
              <span className="truncate">{it.label}</span>
            </>,
            current,
          );
        })}
      </nav>
    </>
  );
}

/** Follows the scroll: which of the sections (by element id) is nearest the top. */
export function useActiveSection(ids: string[]): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0] ?? "");
  const key = ids.join("|");
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Infinity);
        const first = [...seen.entries()]
          .filter(([, t]) => t !== Infinity)
          .sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0];
        if (first) setActive(first[0]);
      },
      { rootMargin: "0px 0px -55% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [key]);
  return [active, setActive];
}

/** A quiet "Saved" that appears after a change is stored and fades away. */
export function SavedNote({ at }: { at: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!at) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 2200);
    return () => clearTimeout(t);
  }, [at]);
  return (
    <span
      role="status"
      aria-live="polite"
      className={`text-xs text-good transition-opacity duration-300 ${show ? "opacity-100" : "opacity-0"}`}
    >
      {show ? `✓ ${t("Saved")}` : ""}
    </span>
  );
}

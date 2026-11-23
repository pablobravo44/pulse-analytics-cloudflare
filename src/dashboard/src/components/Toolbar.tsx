import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { CalendarDays, ChevronDown, Plus, X } from "./icons.tsx";
import { Popover } from "radix-ui";
import { useDeferredValue, useEffect, useState } from "react";
import { api, rangeParams, type Compare, type Filters, type Row } from "../lib/api.ts";
import { locale, t } from "../lib/i18n.ts";

export const PRESETS: [string, string, string][] = [
  ["today", t("Today"), "d"],
  ["yesterday", t("Yesterday"), "e"],
  ["7d", t("Last 7 days"), "w"],
  ["28d", t("Last 28 days"), "f"],
  ["30d", t("Last 30 days"), "t"],
  ["90d", t("Last 90 days"), ""],
  ["mtd", t("Month to date"), "m"],
  ["last_month", t("Last month"), "n"],
  ["ytd", t("Year to date"), "y"],
  ["12mo", t("Last 12 months"), "l"],
  ["all", t("All time"), "a"],
];

export function rangeLabel(r: string): string {
  if (r.includes(",")) {
    const [a, b] = r.split(",");
    const f = (d: string) =>
      new Date(`${d}T00:00:00`).toLocaleDateString(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    return a === b ? f(a!) : `${f(a!)} – ${f(b!)}`;
  }
  return PRESETS.find(([k]) => k === r)?.[1] ?? r;
}

const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The explicit from/to of a range in the browser's calendar (close enough to the site's for navigation). */
export function explicitRange(r: string): [string, string] {
  if (r.includes(",")) return r.split(",") as [string, string];
  const now = new Date();
  const back = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  switch (r) {
    case "today":
      return [day(now), day(now)];
    case "yesterday":
      return [day(back(1)), day(back(1))];
    case "mtd":
      return [day(new Date(now.getFullYear(), now.getMonth(), 1)), day(now)];
    case "last_month":
      return [
        day(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        day(new Date(now.getFullYear(), now.getMonth(), 0)),
      ];
    case "ytd":
      return [day(new Date(now.getFullYear(), 0, 1)), day(now)];
    case "12mo":
      return [day(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)), day(now)];
    default: {
      const n = Number(/^(\d+)d$/.exec(r)?.[1] ?? 28);
      return [day(back(n - 1)), day(now)];
    }
  }
}

export function shiftRange(r: string, dir: -1 | 1): string | null {
  if (r === "all") return null;
  const [a, b] = explicitRange(r);
  const from = new Date(`${a}T00:00:00`);
  const to = new Date(`${b}T00:00:00`);
  const len = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  from.setDate(from.getDate() + dir * len);
  to.setDate(to.getDate() + dir * len);
  if (dir === 1 && from > new Date()) return null;
  return `${day(from)},${day(to)}`;
}

const DIMENSION_GROUPS: [string, [string, string][]][] = [
  [
    t("Pages"),
    [
      ["page", t("Page")],
      ["entry_page", t("Entry page")],
      ["exit_page", t("Exit page")],
      ["hostname", t("Hostname")],
    ],
  ],
  [
    t("Sources"),
    [
      ["channel", t("Channel")],
      ["source_name", t("Source")],
      ["referrer_host", t("Referrer domain")],
      ["utm_source", t("UTM source")],
      ["utm_medium", t("UTM medium")],
      ["utm_campaign", t("UTM campaign")],
    ],
  ],
  [
    t("Location"),
    [
      ["country", t("Country")],
      ["region", t("Region")],
      ["city", t("City")],
    ],
  ],
  [
    t("Technology"),
    [
      ["device", t("Device")],
      ["browser", t("Browser")],
      ["os", t("Operating system")],
      ["language", t("Language")],
    ],
  ],
  [
    t("Events"),
    [
      ["event_name", t("Event name")],
      ["outbound_url", t("Outbound link")],
      ["download_url", t("Download")],
    ],
  ],
  [t("Conversions"), [["goal", t("Converted on goal")]]],
];
const OPS: [string, string][] = [
  ["is", t("is")],
  ["is_not", t("is not")],
  ["contains", t("contains")],
  ["not_contains", t("doesn't contain")],
  ["starts_with", t("starts with")],
  ["matches", t("matches (* wildcard)")],
  ["not_matches", t("doesn't match")],
];
const GOAL_OPS: [string, string][] = [
  ["is", t("is")],
  ["is_not", t("is not")],
];

/** Goal names for chips and the goal picker. */
function useGoals(site: string | undefined) {
  return useQuery({
    queryKey: ["goals", site],
    enabled: !!site,
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>(`/api/v1/sites/${site}/goals`),
    staleTime: 60_000,
  });
}
export const dimLabel = (d: string) =>
  DIMENSION_GROUPS.flatMap(([, x]) => x).find(([k]) => k === d)?.[1] ??
  (d.startsWith("event_prop:")
    ? `${t("property")} ${d.slice(11).replace(/_/g, " ")}`
    : t(d.replace(/_/g, " ")));

function FilterBuilder({ value, onChange }: { value: Filters; onChange: (p: Partial<Filters>) => void }) {
  const { site } = useParams({ strict: false }) as { site?: string };
  const [open, setOpen] = useState(false);
  const [dim, setDim] = useState("page");
  const [op, setOp] = useState("is");
  const [val, setVal] = useState("");
  const goals = useGoals(site);
  const isGoal = dim === "goal";
  // Suggestions come from the dimension's top values, narrowed by what's typed (breakdown ?search=).
  const typed = useDeferredValue(
    op === "is" || op === "is_not" ? (val.split(",").pop() ?? "").trim() : val.trim(),
  );
  const suggestions = useQuery({
    queryKey: ["suggest", site, dim, value.range, typed],
    enabled: open && !!site && !isGoal,
    queryFn: () => {
      const p = new URLSearchParams(rangeParams({ ...value, filters: [], compare: null }));
      p.set("metrics", "visitors");
      p.set("limit", "20");
      if (typed) p.set("search", typed);
      return api.get<{ rows: Row[] }>(`/api/v1/sites/${site}/breakdown/${encodeURIComponent(dim)}?${p}`);
    },
    staleTime: 60_000,
  });
  const ops = isGoal ? GOAL_OPS : OPS;
  const add = () => {
    if (!val.trim()) return;
    const values =
      op === "is" || op === "is_not"
        ? val
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
        : [val.trim()];
    onChange({ filters: [...value.filters.filter(([, d]) => d !== dim), [op, dim, values]] });
    setVal("");
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="btn" data-filter-trigger="">
        <Plus size={15} aria-hidden="true" /> {t("Filter")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="anim-pop floating z-40 w-[min(360px,calc(100vw-32px))] p-4"
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                className="input"
                value={dim}
                onChange={(e) => {
                  setDim(e.target.value);
                  setVal("");
                  if (e.target.value === "goal" && op !== "is" && op !== "is_not") setOp("is");
                }}
                aria-label={t("Dimension")}
              >
                {DIMENSION_GROUPS.map(([g, items]) => (
                  <optgroup key={g} label={g}>
                    {items.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <select
                className="input w-auto"
                value={op}
                onChange={(e) => setOp(e.target.value)}
                aria-label={t("Operator")}
              >
                {ops.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            {isGoal ? (
              <select
                className="input"
                value={val}
                onChange={(e) => setVal(e.target.value)}
                aria-label={t("Goal")}
                required
              >
                <option value="">{t("Pick a goal…")}</option>
                {(goals.data?.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                list="filter-suggestions"
                placeholder={
                  op.startsWith("is")
                    ? t("Value (comma-separate several)")
                    : op.includes("matches")
                      ? "/blog/*"
                      : t("Text")
                }
                value={val}
                onChange={(e) => setVal(e.target.value)}
                aria-label={t("Value")}
                autoFocus
              />
            )}
            {isGoal && !goals.data?.data.length && (
              <p className="text-xs text-ink-3">
                {t("No goals yet. Add one under Goals to segment by conversion.")}
              </p>
            )}
            <datalist id="filter-suggestions">
              {(suggestions.data?.rows ?? []).map((r, i) => (
                <option key={i} value={String(r[dim] ?? "(none)")} />
              ))}
            </datalist>
            {!isGoal && !!suggestions.data?.rows.length && (
              <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                {suggestions.data.rows.slice(0, 12).map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    className="chip hover:bg-mark-soft"
                    onClick={() => {
                      const pick = String(r[dim] ?? "(none)");
                      // With is / is not, clicking adds to the comma-separated list.
                      setVal(
                        op === "is" || op === "is_not"
                          ? [
                              ...val
                                .split(",")
                                .slice(0, -1)
                                .map((x) => x.trim())
                                .filter(Boolean),
                              pick,
                            ].join(", ")
                          : pick,
                      );
                    }}
                  >
                    {String(r[dim] ?? "(none)")}
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <button className="btn btn-primary" type="submit" disabled={!val.trim()}>
                {t("Add filter")}
              </button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function compareLabel(c: Compare): string {
  if (!c) return t("No comparison");
  if (c === "previous_period") return t("vs previous period");
  if (c === "previous_year") return t("vs previous year");
  return t("vs {range}", { range: rangeLabel(c) });
}

function CompareMenu({ value, onChange }: { value: Filters; onChange: (p: Partial<Filters>) => void }) {
  const [open, setOpen] = useState(false);
  const custom = value.compare?.includes(",") ? (value.compare.split(",") as [string, string]) : null;
  const [[from, to], setDays] = useState<[string, string]>(
    () => custom ?? explicitRange(shiftRange(value.range, -1) ?? value.range),
  );
  useEffect(() => {
    if (open) setDays(custom ?? explicitRange(shiftRange(value.range, -1) ?? value.range));
  }, [open]);
  const options: [Compare, string][] = [
    ["previous_period", t("Previous period")],
    ["previous_year", t("Same period last year")],
    [null, t("No comparison")],
  ];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="btn justify-between">
        <span className="sr-only">{t("Compare with")} </span>
        {compareLabel(value.compare)}
        <ChevronDown size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="anim-pop floating z-40 w-[min(300px,calc(100vw-32px))] p-2"
        >
          <ul className="flex flex-col">
            {options.map(([k, l]) => (
              <li key={String(k)}>
                <button
                  type="button"
                  className={`row-hover flex w-full items-center justify-between rounded-[6px] px-3 py-1.5 text-left text-sm ${value.compare === k ? "bg-mark-soft font-semibold" : ""}`}
                  onClick={() => {
                    onChange({ compare: k });
                    setOpen(false);
                  }}
                >
                  {l}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex flex-col gap-2 border-t border-rule p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (from && to) {
                onChange({ compare: from <= to ? `${from},${to}` : `${to},${from}` });
                setOpen(false);
              }
            }}
          >
            <span className="text-xs text-ink-3">{t("Compare with specific days")}</span>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="input"
                type="date"
                aria-label={t("Compare from")}
                value={from}
                onChange={(e) => setDays([e.target.value, to])}
                required
              />
              <input
                className="input"
                type="date"
                aria-label={t("Compare to")}
                value={to}
                onChange={(e) => setDays([from, e.target.value])}
                required
              />
            </div>
            <button className="btn" type="submit">
              {t("Compare")}
            </button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RangePicker({ value, onChange }: { value: Filters; onChange: (p: Partial<Filters>) => void }) {
  const [open, setOpen] = useState(false);
  const [[from, to], setCustom] = useState<[string, string]>(() => explicitRange(value.range));
  useEffect(() => {
    if (open) setCustom(explicitRange(value.range));
  }, [open, value.range]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="btn justify-between gap-1.5" title={t("All ranges and custom dates")}>
        <span className="flex items-center gap-2">
          <CalendarDays size={15} aria-hidden="true" />
          <span className="range-label">{rangeLabel(value.range)}</span>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="anim-pop floating z-40 w-[min(320px,calc(100vw-32px))] p-2"
        >
          <ul className="flex flex-col">
            {PRESETS.map(([k, l, key]) => (
              <li key={k}>
                <button
                  type="button"
                  className={`row-hover flex w-full items-center justify-between rounded-[6px] px-3 py-1.5 text-left text-sm ${value.range === k ? "bg-mark-soft font-semibold" : ""}`}
                  onClick={() => {
                    onChange({ range: k });
                    setOpen(false);
                  }}
                >
                  {l}
                  {key && <kbd className="text-xs text-ink-3">{key.toUpperCase()}</kbd>}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex flex-col gap-2 border-t border-rule p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (from && to) {
                onChange({ range: from <= to ? `${from},${to}` : `${to},${from}` });
                setOpen(false);
              }
            }}
          >
            <span className="text-xs text-ink-3">{t("Custom range")}</span>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="input"
                type="date"
                aria-label={t("From")}
                value={from}
                onChange={(e) => setCustom([e.target.value, to])}
                required
              />
              <input
                className="input"
                type="date"
                aria-label={t("To")}
                value={to}
                onChange={(e) => setCustom([from, e.target.value])}
                required
              />
            </div>
            <button className="btn" type="submit">
              {t("Apply range")}
            </button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Date range, comparison, filters and keyboard shortcuts for every report page. */
/** One-click ranges; `wide` ones only show from 640 px (on phones they stay in the calendar menu). */
const QUICK: { value: string; label: string; title: string; wide?: boolean }[] = [
  { value: "today", label: t("Today"), title: t("Today (D)") },
  { value: "yesterday", label: t("Yesterday"), title: t("Yesterday (E)") },
  { value: "7d", label: "7d", title: t("Last 7 days") },
  { value: "28d", label: "28d", title: t("Last 28 days") },
  { value: "90d", label: "90d", title: t("Last 90 days"), wide: true },
  { value: "12mo", label: t("12mo"), title: t("Last 12 months"), wide: true },
];

/**
 * Range as a segmented control (one click), with the calendar for every other range; comparison; filters as chips
 * in the same row; `trailing` (saved views) on the right.
 */
export function Toolbar({
  value,
  onChange,
  showCompare = true,
  trailing,
}: {
  value: Filters;
  onChange: (p: Partial<Filters>) => void;
  showCompare?: boolean;
  trailing?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
        el.isContentEditable ||
        document.querySelector("[role=dialog]")
      )
        return;
      const k = e.key.toLowerCase();
      const preset = PRESETS.find(([, , key]) => key && key === k);
      if (preset) onChange({ range: preset[0] });
      else if (e.key === "/") document.querySelector<HTMLButtonElement>("[data-filter-trigger]")?.click();
      else if (k === "x" && showCompare) onChange({ compare: value.compare ? null : "previous_period" });
      else if (e.key === "Escape" && value.filters.length) onChange({ filters: [] });
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const next = shiftRange(value.range, e.key === "ArrowLeft" ? -1 : 1);
        if (next) onChange({ range: next });
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [value, onChange, showCompare]);
  const { site } = useParams({ strict: false }) as { site?: string };
  const goals = useGoals(value.filters.some(([, d]) => d === "goal") ? site : undefined);
  const goalNames = new Map((goals.data?.data ?? []).map((g) => [g.id, g.name]));
  const quick = QUICK.some((q) => q.value === value.range);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <div role="group" aria-label={t("Date range")} className="seg">
          {QUICK.map((q) => (
            <button
              key={q.value}
              type="button"
              aria-pressed={value.range === q.value}
              title={q.title}
              className={q.wide && value.range !== q.value ? "max-sm:hidden" : undefined}
              onClick={() => onChange({ range: q.value })}
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className={quick ? "[&_.range-label]:sr-only" : ""}>
          <RangePicker value={value} onChange={onChange} />
        </div>
      </div>
      {showCompare && <CompareMenu value={value} onChange={onChange} />}
      <FilterBuilder value={value} onChange={onChange} />
      {value.filters.length > 0 && (
        <>
          {value.filters.map(([op, dim, vals]) => (
            <span key={dim} className="chip chip-mark">
              <span className="text-ink-2">{dimLabel(dim)}</span>{" "}
              {OPS.find(([k]) => k === op)?.[1]?.replace(/ \(\*.*\)$/, "") ?? op}{" "}
              <strong className="font-semibold">
                {dim === "goal" ? vals.map((v) => goalNames.get(String(v)) ?? v).join(", ") : vals.join(", ")}
              </strong>
              <button
                type="button"
                aria-label={t("Remove {dimension} filter", { dimension: dimLabel(dim) })}
                className="ml-0.5 rounded-[4px] p-0.5 text-ink-2 hover:bg-bar hover:text-ink"
                onClick={() => onChange({ filters: value.filters.filter(([, d]) => d !== dim) })}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          {value.filters.length > 1 && (
            <button
              type="button"
              className="btn btn-quiet btn-sm text-ink-2"
              onClick={() => onChange({ filters: [] })}
            >
              {t("Clear all")}
            </button>
          )}
        </>
      )}
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

import { Check, Copy, Download, ListFilter, X, type LucideIcon } from "./icons.tsx";
import { AlertDialog, Dialog, Switch as RSwitch } from "radix-ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { download, fmt, toCsv, type Row } from "../lib/api.ts";
import { RowGlyph } from "./glyphs.tsx";
import { useFlip } from "./motion.tsx";
import { locale, t } from "../lib/i18n.ts";

/** A panel: a titled surface (16 px corners, a hairline, no shadow) with its actions on the heading row. */
export function Section({
  title,
  icon: Icon,
  actions,
  children,
  className = "",
  id,
}: {
  title?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  // Named by its heading, so assistive tech (and tests) find "the Pages panel" as a region.
  const headingId = useId();
  return (
    <section
      className={`panel min-w-0 px-2 pb-3 pt-1 ${className}`}
      id={id}
      aria-labelledby={title ? headingId : undefined}
    >
      {(title || actions) && (
        <header className="section-head px-2 pt-2">
          {title && (
            <h2 id={headingId} className="t-heading flex min-w-[6rem] items-center gap-2 truncate">
              {Icon && <Icon size={17} aria-hidden="true" className="shrink-0 text-ink-2" />}
              <span className="truncate">{title}</span>
            </h2>
          )}
          <div className="flex min-w-0 max-w-full flex-nowrap items-center justify-end gap-1">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

/** Kept for pages that still use it; renders as a section. */
export const Card = Section;

export function Skeleton({ h = 16, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} aria-hidden="true" />;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 px-2 py-6 text-sm text-ink-2">
      <p>{children}</p>
      {action}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <p role="alert" className="border-l-2 border-down py-1 pl-3 text-sm text-down">
      {(error as Error)?.message ?? t("Something went wrong")}
    </p>
  );
}

/**
 * Change against the comparison as a pill: green or red only for good or bad, always with an arrow (never colour
 * alone); `invert` for metrics where down is good (bounce rate). `note` explains a missing change.
 */
export function Delta({
  pct,
  invert = false,
  unit = "%",
  note,
}: {
  pct: number | null | undefined;
  invert?: boolean;
  unit?: string;
  note?: string;
}) {
  if (pct === null || pct === undefined)
    return (
      <span
        className="delta delta-flat"
        title={note ? t("Not comparable: {note}", { note }) : t("No comparison")}
      >
        –
      </span>
    );
  const good = invert ? pct < 0 : pct > 0;
  const glyph = pct > 0 ? "↗" : pct < 0 ? "↘" : "→";
  const amount = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs(pct))}${unit}`;
  const label =
    pct > 0
      ? t("up {amount}", { amount })
      : pct < 0
        ? t("down {amount}", { amount })
        : t("no change {amount}", { amount });
  return (
    <span
      className={`delta ${pct === 0 ? "delta-flat" : good ? "delta-up" : "delta-down"}`}
      aria-label={label}
    >
      <span aria-hidden="true">{glyph}</span>
      {amount}
    </span>
  );
}

/** A segmented control: one click between a few options (ranges, intervals). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`seg ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type Health = "up" | "down" | "degraded" | "paused" | "unknown";
const GLYPH: Record<Health, { g: string; cls: string; label: string }> = {
  up: { g: "●", cls: "text-live", label: t("Up") },
  degraded: { g: "▲", cls: "text-warn", label: t("Slow") },
  down: { g: "✕", cls: "text-down", label: t("Down") },
  paused: { g: "‖", cls: "text-ink-3", label: t("Paused") },
  unknown: { g: "○", cls: "text-ink-3", label: t("No data yet") },
};
export function StatusGlyph({ status, withLabel = false }: { status: Health; withLabel?: boolean }) {
  const s = GLYPH[status];
  return (
    <span className={`inline-flex items-center gap-1.5 ${s.cls}`} title={s.label}>
      <span aria-hidden="true" className="inline-block w-3 text-center font-semibold">
        {s.g}
      </span>
      {withLabel ? <span className="text-sm">{s.label}</span> : <span className="sr-only">{s.label}</span>}
    </span>
  );
}

/** Ruled rows with an inline bar; the row is the click target (adds a filter). */
export function BarList({
  rows,
  dimension,
  metric,
  secondary,
  onSelect,
  formatLabel,
  limit = 8,
}: {
  rows: Row[];
  dimension: string;
  metric: string;
  secondary?: string;
  onSelect?: (value: string | number | null) => void;
  formatLabel?: (v: string | number | null) => string;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  useFlip(list, [rows, dimension]);
  if (!rows.length) return <Empty>{t("No data for this range.")}</Empty>;
  const shown = all ? rows : rows.slice(0, limit);
  const max = Math.max(...rows.map((r) => Number(r[metric] ?? 0)), 1);
  const total = rows.reduce((a, r) => a + Number(r[metric] ?? 0), 0);
  return (
    <div>
      <div className="mb-1 flex justify-between px-2 text-xs text-ink-3">
        <span>{t(dimension.replace(/_/g, " ").replace("event prop:", "property "))}</span>
        <span className="flex gap-3">
          <span>{t(metric.replace(/_/g, " "))}</span>
          {secondary && <span className="w-12 text-right">{t(secondary.replace(/_/g, " "))}</span>}
        </span>
      </div>
      <ul ref={list} className="flex flex-col">
        {shown.map((r) => {
          const v = r[dimension] ?? null;
          const n = Number(r[metric] ?? 0);
          const pct = (n / max) * 100;
          const text = formatLabel ? formatLabel(v) : v === null ? t("(none)") : String(v);
          const Tag = onSelect ? "button" : "div";
          return (
            <li key={String(v)} data-flip={String(v)}>
              <Tag
                {...(onSelect
                  ? {
                      type: "button" as const,
                      onClick: () => onSelect(v),
                      title: t("Filter by {value}", { value: text }),
                    }
                  : { title: text })}
                className="row-hover group relative flex min-h-[34px] w-full items-center justify-between gap-3 overflow-hidden rounded-[8px] px-2.5 text-left text-sm"
              >
                <span
                  className="bar-fill absolute inset-y-[3px] left-0 rounded-[7px] bg-bar"
                  style={{ width: `${Math.max(pct, 0.6)}%` }}
                  aria-hidden="true"
                />
                <span className="relative flex min-w-0 items-center gap-2">
                  <RowGlyph dimension={dimension} value={v} />
                  <span className="min-w-0 truncate font-medium">{text}</span>
                  {onSelect && (
                    <ListFilter
                      size={12}
                      aria-hidden="true"
                      className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  )}
                </span>
                <span className="relative flex shrink-0 items-baseline gap-3 tabular">
                  <span className="hidden text-xs text-ink-2 sm:inline">
                    {total ? fmt((n / total) * 100, "share_pct") : ""}
                  </span>
                  <span className="text-[14px] font-semibold">{fmt(r[metric], metric)}</span>
                  {secondary && (
                    <span className="w-12 text-right text-ink-2">{fmt(r[secondary], secondary)}</span>
                  )}
                </span>
              </Tag>
            </li>
          );
        })}
      </ul>
      {rows.length > limit && (
        <button type="button" className="btn btn-quiet btn-sm mt-1" onClick={() => setAll(!all)}>
          {all ? t("Show fewer") : t("Show all {n}", { n: rows.length })}
        </button>
      )}
    </div>
  );
}

/** Panel tabs: quiet labels; the selected one sits on a soft pill that slides to it. */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = wrap.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      setMark(el ? { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [value, options.length]);
  return (
    <div
      ref={wrap}
      role="tablist"
      aria-label={label}
      className="no-scrollbar relative flex min-w-0 flex-nowrap gap-x-0.5 overflow-x-auto"
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`relative z-[1] shrink-0 whitespace-nowrap rounded-[8px] px-2.5 py-1 text-[12.5px] font-medium transition-colors ${value === o.value ? "text-ink" : "text-ink-3 hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
      {mark && (
        <span
          className="tab-mark pointer-events-none absolute left-0 h-[26px] rounded-[8px] bg-line-2"
          style={{ transform: `translate(${mark.left}px, ${mark.top}px)`, width: mark.width, top: 0 }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export function CsvButton({ rows, name }: { rows: Row[]; name: string }) {
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm text-ink-2"
      onClick={() => download(`${name}.csv`, toCsv(rows))}
      disabled={!rows.length}
      title={t("Download CSV")}
      aria-label={t("Download CSV")}
    >
      <Download size={14} aria-hidden="true" />
    </button>
  );
}

export function DataTable({
  rows,
  columns,
  empty = t("No data for this range."),
}: {
  rows: Row[];
  columns: { key: string; label: string; metric?: string; render?: (r: Row) => ReactNode }[];
  empty?: string;
}) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={t("Table")}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-grid-major text-left text-xs text-ink-3">
            {columns.map((c) => (
              <th key={c.key} className={`px-2 py-2 font-medium ${c.metric ? "text-right" : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="row-hover border-b border-rule last:border-0">
              {columns.map((c) => (
                <td key={c.key} className={`px-2 py-2 ${c.metric ? "t-num text-right text-[15px]" : ""}`}>
                  {c.render
                    ? c.render(r)
                    : c.metric
                      ? fmt(r[c.key], c.metric)
                      : String(r[c.key] ?? t("(none)"))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A labelled control. `group` is for several controls (checkbox lists): a labelled group instead of a <label>, so labels never nest. */
export function Field({
  label,
  hint,
  children,
  className = "",
  group = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  group?: boolean;
}) {
  const id = useId();
  if (group)
    return (
      <div role="group" aria-labelledby={id} className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
        <span id={id} className="text-[13px] font-medium text-ink">
          {label}
        </span>
        {children}
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
      </div>
    );
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="flex items-start justify-between gap-4 py-2">
      <span className="flex flex-col">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
      </span>
      <RSwitch.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-grid-major bg-bar transition-colors data-[state=checked]:border-ink data-[state=checked]:bg-ink"
      >
        <RSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-sheet shadow transition-transform data-[state=checked]:translate-x-[17px]" />
      </RSwitch.Root>
    </label>
  );
}

export function CopyField({
  value,
  label = t("Copy"),
  mono = true,
}: {
  value: string;
  label?: string;
  mono?: boolean;
}) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex min-w-0 items-stretch gap-2">
      <code
        tabIndex={0}
        className={`min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-[10px] border border-line bg-fog px-3 py-2 text-[13px] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </code>
      <button
        type="button"
        className="btn shrink-0"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setOk(true);
            setTimeout(() => setOk(false), 1500);
          })
        }
      >
        {ok ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        {ok ? t("Copied") : label}
      </button>
    </div>
  );
}

/** A panel that slides in from the right (edit forms, details). */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-fade fixed inset-0 z-40 bg-[rgba(17,23,21,0.32)]" />
        <Dialog.Content
          className={`anim-sheet fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-rule bg-sheet shadow-[var(--shadow)] sm:inset-y-2 sm:right-2 sm:rounded-[10px] sm:border ${wide ? "sm:max-w-[760px]" : "sm:max-w-[560px]"}`}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="t-heading">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-sm text-ink-2">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">
                  {typeof title === "string" ? title : t("Details")}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close className="btn btn-quiet btn-sm" aria-label={t("Close")}>
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Confirmation for irreversible or disruptive actions. The confirm label names the action. */
export function Confirm({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  onConfirm,
  danger = true,
  requireText,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  body: ReactNode;
  confirm: string;
  onConfirm: () => void;
  danger?: boolean;
  requireText?: string;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="anim-fade fixed inset-0 z-50 bg-[rgba(17,23,21,0.4)]" />
        <AlertDialog.Content className="anim-pop floating fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 p-5">
          <AlertDialog.Title className="t-heading">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-sm text-ink-2">{body}</div>
          </AlertDialog.Description>
          {requireText && (
            <Field label={t("Type {text} to confirm", { text: requireText })} className="mt-4">
              <input
                className="input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="btn">{t("Cancel")}</AlertDialog.Cancel>
            <AlertDialog.Action
              className={`btn ${danger ? "border-down bg-down text-sheet hover:bg-down" : "btn-primary"}`}
              disabled={!!requireText && typed !== requireText}
              onClick={onConfirm}
            >
              {confirm}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// ---------- Toasts ----------
interface ToastItem {
  id: number;
  text: string;
  tone: "ok" | "error";
}
const ToastCtx = createContext<(text: string, tone?: "ok" | "error") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2"
        role="status"
        aria-live="polite"
      >
        {items.map((it) => (
          <div
            key={it.id}
            className={`anim-pop floating pointer-events-auto flex items-center gap-2 px-4 py-2.5 text-sm ${it.tone === "error" ? "text-down" : ""}`}
            data-state="open"
          >
            {it.tone === "ok" ? (
              <Check size={15} className="text-up" aria-hidden="true" />
            ) : (
              <X size={15} aria-hidden="true" />
            )}
            {it.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Relative time for "last used", "last event". */
export function ago(ts: string | number | null | undefined, empty = t("never")): string {
  if (ts === null || ts === undefined || ts === "") return empty;
  const at = typeof ts === "number" ? ts : Date.parse(ts);
  const s = (Date.now() - at) / 1000;
  if (s < 0) {
    const f = -s;
    if (f < 3600) return t("in {n} min", { n: Math.round(f / 60) });
    if (f < 86400) return t("in {n} h", { n: Math.round(f / 3600) });
    return t("in {n} d", { n: Math.round(f / 86400) });
  }
  if (s < 90) return t("just now");
  if (s < 3600) return t("{n} min ago", { n: Math.round(s / 60) });
  if (s < 86400) return t("{n} h ago", { n: Math.round(s / 3600) });
  if (s < 86400 * 60) return t("{n} d ago", { n: Math.round(s / 86400) });
  return new Date(at).toLocaleDateString(locale);
}

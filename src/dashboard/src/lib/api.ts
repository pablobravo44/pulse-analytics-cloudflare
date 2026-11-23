import { locale } from "./i18n.ts";

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let share: { token: string; password: string | null } | null = null;
/** Share-link mode: every request carries the link's token (and password) instead of a session. */
export function setShare(token: string | null, password: string | null = null) {
  share = token ? { token, password } : null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: share ? "omit" : "same-origin",
    headers: {
      "X-Pulse-Client": "dashboard",
      ...(share
        ? {
            "X-Pulse-Share": share.token,
            ...(share.password ? { "X-Pulse-Share-Password": share.password } : {}),
          }
        : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !share && !location.pathname.startsWith("/login")) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  if (!res.ok) {
    let code = "error";
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      code = j.error?.code ?? code;
      message = j.error?.message ?? message;
    } catch {
      /* not json */
    }
    throw new HttpError(res.status, code, message);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
}

/**
 * A file from the API (CSV, NDJSON) saved through the browser. Fetched with the dashboard header, which a plain
 * link can't send, so the whole file passes through memory once.
 */
async function fetchFile(method: "GET" | "POST", path: string, body?: unknown): Promise<{ name: string; bytes: number }> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "X-Pulse-Client": "dashboard", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* not json */
    }
    throw new HttpError(res.status, "error", message);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "pulse-export";
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name, bytes: blob.size };
}

export const api = {
  download: fetchFile,
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b: unknown) => request<T>("PUT", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export type Row = Record<string, string | number | null>;

/** previous_period, previous_year, explicit days "YYYY-MM-DD,YYYY-MM-DD", or none. */
export type Compare = "previous_period" | "previous_year" | (string & {}) | null;

export interface Filters {
  range: string; // preset or "YYYY-MM-DD,YYYY-MM-DD"
  compare: Compare;
  filters: [string, string, (string | number)[]][];
}

export function rangeParams(f: Filters): string {
  const p = new URLSearchParams();
  if (f.range.includes(",")) {
    const [from, to] = f.range.split(",");
    p.set("from", from!);
    p.set("to", to!);
  } else p.set("date_range", f.range);
  if (f.compare?.includes(",")) {
    const [a, b] = f.compare.split(",");
    p.set("compare_from", a!);
    p.set("compare_to", b!);
  } else p.set("compare", f.compare ?? "none");
  if (f.filters.length) p.set("filters", JSON.stringify(f.filters));
  return p.toString();
}

export function rangeBody(f: Filters) {
  const date_range = f.range.includes(",")
    ? { from: f.range.split(",")[0]!, to: f.range.split(",")[1]! }
    : f.range;
  const compare = f.compare?.includes(",")
    ? { from: f.compare.split(",")[0]!, to: f.compare.split(",")[1]! }
    : f.compare;
  return { date_range, filters: f.filters, compare };
}

const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const cf = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });

export function fmt(v: unknown, metric?: string): string {
  if (v === null || v === undefined || v === "") return "–";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (metric?.endsWith("rate") || metric === "scroll_depth" || metric?.endsWith("_pct"))
    return `${nf.format(n)}%`;
  if (metric === "avg_session_duration" || metric === "avg_engaged_time") return duration(n);
  if (metric === "cls_p75")
    return n.toLocaleString(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  if (metric?.includes("revenue"))
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: n >= 1000 ? 0 : 2,
      minimumFractionDigits: 0,
    }).format(n);
  if (metric?.endsWith("_p75")) return `${Math.round(n)} ms`;
  return n >= 100_000 ? cf.format(n) : nf.format(n);
}

export function duration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m < 60 ? `${m}m ${s}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function toCsv(rows: Row[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

export function download(name: string, text: string, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

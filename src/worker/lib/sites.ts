import { z } from "zod";
import { DEFAULT_QUERY_ALLOWLIST } from "./url.ts";

export interface SiteFeatures {
  outbound: boolean;
  downloads: boolean;
  engagement: boolean;
  vitals: boolean;
  errors: boolean;
}

export interface SiteSettings {
  features: SiteFeatures;
  query_allowlist: string[];
  respect_dnt: boolean;
  /** Drop hits from hosting/cloud networks (datacenter traffic with browser user agents); counted as dropped_hosting. */
  block_hosting: boolean;
  /** Internal sites (e.g. the smoke-test site): left out of the sites board, the digest and the OAuth consent page. */
  hidden: boolean;
  /** Path globs dropped at ingest, e.g. "/admin/*". */
  exclude_paths: string[];
  /** Hostname globs dropped at ingest even though they match a domain, e.g. "staging.*". */
  exclude_hosts: string[];
  include_in_digest: boolean;
  /** Query parameters that carry an on-site search, e.g. ["q", "s"]; the value becomes the search_term dimension. */
  search_params: string[];
  /** Referrer hosts whose visits are dropped as spam (in addition to the built-in list). */
  block_referrers: string[];
  /** ISO-2 country codes whose visits are dropped. */
  block_countries: string[];
  /** Currency the `revenue` event property is in, for display (e.g. EUR). */
  revenue_currency: string;
  /** Circuit breaker: once this many events were accepted on a UTC day, ingest for the site pauses until the next day. 0 = no cap. */
  daily_event_cap: number;
  /** The site's colour in the dashboard (one of SITE_COLORS); null = assigned by creation order. */
  color: SiteColor | null;
  /** Goal shown on the home card and first in reports; null = none. */
  primary_goal: string | null;
}

/** The twelve validated site hues, in their fixed order (docs/DESIGN.md). A colour follows its site, never its position. */
export const SITE_COLORS = [
  "violet",
  "teal",
  "amber",
  "magenta",
  "blue",
  "olive",
  "coral",
  "indigo",
  "emerald",
  "plum",
  "cyan",
  "slate",
] as const;
export type SiteColor = (typeof SITE_COLORS)[number];

/** The colour for a new site: the least-used of the twelve (the first one on a tie), given the slots in use. */
export function pickSiteColor(used: string[]): SiteColor {
  const count = SITE_COLORS.map((_, i) => used.filter((u) => u === `s${i + 1}`).length);
  return SITE_COLORS[count.indexOf(Math.min(...count))]!;
}

/** A site's colour slot (s1…s12): its chosen colour, or the next one by creation order among all sites. */
export function siteColorSlot(site: Pick<Site, "id" | "settings" | "created_at">, all: Pick<Site, "id" | "created_at">[]): string {
  if (site.settings.color) return `s${SITE_COLORS.indexOf(site.settings.color) + 1}`;
  const order = [...all].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)).findIndex((s) => s.id === site.id);
  return `s${(Math.max(order, 0) % SITE_COLORS.length) + 1}`;
}

export const DEFAULT_DAILY_EVENT_CAP = 200_000;

export interface Site {
  id: string;
  name: string;
  domains: string[];
  timezone: string;
  settings: SiteSettings;
  retention_months: number;
  created_at: number;
  archived_at: number | null;
  /** Set only for share links bound to a saved view: filters every query of the request must apply. */
  forcedFilters?: [string, string, (string | number)[]][];
}

export interface SiteRow {
  id: string;
  name: string;
  domains_json: string;
  timezone: string;
  /** Unused (left from a removed compatibility shim); the column stays, '[]' for new sites. */
  legacy_ids_json: string;
  settings_json: string;
  retention_months: number;
  created_at: number;
  archived_at: number | null;
}

export const DEFAULT_SETTINGS: SiteSettings = {
  features: { outbound: true, downloads: true, engagement: true, vitals: true, errors: false },
  query_allowlist: DEFAULT_QUERY_ALLOWLIST,
  respect_dnt: false,
  block_hosting: true,
  hidden: false,
  exclude_paths: [],
  exclude_hosts: [],
  include_in_digest: true,
  search_params: [],
  block_referrers: [],
  block_countries: [],
  revenue_currency: "EUR",
  daily_event_cap: DEFAULT_DAILY_EVENT_CAP,
  color: null,
  primary_goal: null,
};

/** The editable part of site settings; every field optional so it works for create and patch. */
export const siteSettingsInput = z
  .object({
    features: z.object({ outbound: z.boolean(), downloads: z.boolean(), engagement: z.boolean(), vitals: z.boolean(), errors: z.boolean() }).partial(),
    query_allowlist: z.array(z.string().min(1).max(64)).max(30),
    respect_dnt: z.boolean(),
    block_hosting: z.boolean(),
    hidden: z.boolean(),
    exclude_paths: z.array(z.string().min(1).max(200).regex(/^\//, "paths start with /")).max(50),
    exclude_hosts: z.array(z.string().min(1).max(253).regex(/^[a-z0-9*.-]+$/i, "hostnames with * wildcards").transform((x) => x.toLowerCase())).max(50),
    include_in_digest: z.boolean(),
    search_params: z.array(z.string().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/)).max(10),
    block_referrers: z.array(z.string().min(3).max(253)).max(200),
    block_countries: z.array(z.string().regex(/^[A-Za-z]{2}$/).transform((x) => x.toUpperCase())).max(250),
    revenue_currency: z.string().regex(/^[A-Za-z]{3}$/).transform((x) => x.toUpperCase()),
    daily_event_cap: z.number().int().min(0).max(100_000_000),
    color: z.enum(SITE_COLORS).nullable(),
    primary_goal: z.string().min(1).max(64).nullable(),
  })
  .partial();
export type SiteSettingsInput = z.infer<typeof siteSettingsInput>;

export function mergeSettings(base: SiteSettings, patch: SiteSettingsInput | undefined): SiteSettings {
  if (!patch) return { ...base, features: { ...base.features } };
  return {
    ...base,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    features: { ...base.features, ...(patch.features ?? {}) },
  } as SiteSettings;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function rowToSite(r: SiteRow): Site {
  const s = parseJson<Partial<SiteSettings>>(r.settings_json, {});
  return {
    id: r.id,
    name: r.name,
    domains: parseJson<string[]>(r.domains_json, []),
    timezone: r.timezone,
    settings: {
      features: { ...DEFAULT_SETTINGS.features, ...(s.features ?? {}) },
      query_allowlist: s.query_allowlist ?? DEFAULT_SETTINGS.query_allowlist,
      respect_dnt: s.respect_dnt ?? false,
      block_hosting: s.block_hosting ?? true,
      hidden: s.hidden ?? false,
      exclude_paths: s.exclude_paths ?? [],
      exclude_hosts: s.exclude_hosts ?? [],
      include_in_digest: s.include_in_digest ?? true,
      search_params: s.search_params ?? [],
      block_referrers: s.block_referrers ?? [],
      block_countries: s.block_countries ?? [],
      revenue_currency: s.revenue_currency ?? "EUR",
      daily_event_cap: s.daily_event_cap ?? DEFAULT_DAILY_EVENT_CAP,
      color: s.color && (SITE_COLORS as readonly string[]).includes(s.color) ? s.color : null,
      primary_goal: s.primary_goal ?? null,
    },
    retention_months: r.retention_months,
    created_at: r.created_at,
    archived_at: r.archived_at,
  };
}

/**
 * Normalize what a person types as a domain: "https://www.Example.com/path" → "www.example.com".
 * Returns null for things that can't be a site domain (IPs, localhost, no dot). "*.example.com" is kept.
 */
export function normalizeDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  const wildcard = d.startsWith("*.");
  if (wildcard) d = d.slice(2);
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/\.$/, "");
  let host: string;
  try {
    host = new URL(`http://${d}`).hostname;
  } catch {
    return null;
  }
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[") || host === "localhost" || host.endsWith(".localhost")) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.split(".").some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return null;
  return wildcard ? `*.${host}` : host;
}

/** A site id from a name or domain: "Example.com" → "example", "My Blog" → "my-blog". */
export function siteSlug(source: string): string {
  const base = source
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/\.(com|org|net|io|dev|app|es|co|eu|info|me|site)$/, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  // "summary" is taken by GET /sites/summary.
  if (base === "summary") return "summary-site";
  return base.length >= 2 ? base : `site-${base || "new"}`;
}

/**
 * Glob with `*` against a path or hostname (same syntax as the tracker's data-exclude): `*` matches any run of
 * characters; everything else is literal. Greedy matching with one backtrack point is
 * O(len(glob) × len(text)) at worst, so visitor-controlled paths can't make it slow (a RegExp could backtrack
 * exponentially on globs with several stars in a row of segments).
 */
export function pathMatches(glob: string, text: string): boolean {
  let g = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] !== "*" && glob[g] === text[t]) {
      g++;
      t++;
    } else if (g < glob.length && glob[g] === "*") {
      star = g++;
      mark = t;
    } else if (star >= 0) {
      g = star + 1;
      t = ++mark;
    } else return false;
  }
  while (g < glob.length && glob[g] === "*") g++;
  return g === glob.length;
}

// Small per-isolate cache; sites change rarely. 60 s TTL.
let cache: { at: number; sites: Map<string, Site> } | null = null;

export function invalidateSiteCache(): void {
  cache = null;
}

async function load(db: D1Database) {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const { results } = await db.prepare("SELECT * FROM sites WHERE archived_at IS NULL").all<SiteRow>();
  const sites = new Map<string, Site>();
  for (const r of results) {
    const s = rowToSite(r);
    sites.set(s.id, s);
  }
  cache = { at: Date.now(), sites };
  return cache;
}

export async function getSite(db: D1Database, id: string): Promise<Site | null> {
  return (await load(db)).sites.get(id) ?? null;
}

export async function listSitesCached(db: D1Database): Promise<Site[]> {
  return [...(await load(db)).sites.values()];
}

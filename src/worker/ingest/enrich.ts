import { classifyChannel, SPAM_REFERRERS } from "../lib/channels.ts";
import { hmacHex } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { pathMatches, type Site } from "../lib/sites.ts";
import { localParts } from "../lib/time.ts";
import { isBotUa, parseUa } from "../lib/ua.ts";
import { hostAllowed, parsePage, referrerParts } from "../lib/url.ts";
import { HIT_TYPES, type EnrichedHit, type TrackerPayload } from "./types.ts";

export type DropReason = "invalid" | "bot" | "dnt" | "hosting" | "site" | "excluded";

export interface RequestMeta {
  ip: string;
  ua: string;
  origin: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  continent: string | null;
  verifiedBot: boolean;
  dnt: boolean;
  /** The request comes from a hosting/cloud network (looked up from the ASN; the ASN itself is not kept). */
  hosting: boolean;
  now: number;
}

const MAX_PROPS = 20;
const MAX_STR = 200;
const MAX_NAME = 80;

function str(v: unknown, max = MAX_STR): string | null {
  return typeof v === "string" && v.length ? v.slice(0, max) : null;
}
function num(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
}
/** LCP/INP above 60 s come from background tabs: drop them instead of clamping. */
function vital(v: unknown): number | null {
  return typeof v === "number" && v <= 60_000 ? num(v, 0, 60_000) : null;
}
function int(v: unknown, min = 0, max = 1e9): number | null {
  const n = num(v, min, max);
  return n === null ? null : Math.round(n);
}

export function sanitizeProps(p: unknown): string | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (n >= MAX_PROPS) break;
    const key = k.slice(0, MAX_NAME);
    if (typeof v === "string") out[key] = v.slice(0, MAX_STR);
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
    else continue;
    n++;
  }
  return n ? JSON.stringify(out) : null;
}

/** The site-search query from the page URL, if the site declared its search parameters. */
export function searchTerm(url: string, params: readonly string[]): string | null {
  if (!params.length) return null;
  try {
    const sp = new URL(url).searchParams;
    for (const k of params) {
      const v = sp.get(k)?.trim().toLowerCase();
      if (v) return v.slice(0, 100);
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** Validate the raw body into a payload. Returns null when malformed. */
export function parsePayload(body: unknown): TrackerPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.s !== "string" || typeof b.u !== "string") return null;
  const t = (b.t ?? "pageview") as string;
  if (!(HIT_TYPES as readonly string[]).includes(t)) return null;
  return { ...(b as unknown as TrackerPayload), t: t as TrackerPayload["t"] };
}

export async function visitorId(salt: string, siteId: string, ip: string, ua: string): Promise<string> {
  return hmacHex(salt, `${siteId}|${ip}|${ua}`, 16);
}

/** Pure-ish enrichment: everything except the queue send. The IP is consumed here and not returned. */
export async function enrich(
  p: TrackerPayload,
  site: Site,
  meta: RequestMeta,
  salt: string,
): Promise<EnrichedHit | DropReason> {
  const page = parsePage(p.u, site.settings.query_allowlist);
  if (!page) return "invalid";
  if (!hostAllowed(page.hostname, site.domains)) return "site";
  if (site.settings.exclude_paths.some((g) => pathMatches(g, page.pathname))) return "excluded";
  if (site.settings.exclude_hosts.some((g) => pathMatches(g, page.hostname))) return "excluded";
  if (meta.origin) {
    let oh: string;
    try {
      oh = new URL(meta.origin).hostname;
    } catch {
      return "site";
    }
    if (!hostAllowed(oh, site.domains)) return "site";
  }
  if (p.b || meta.verifiedBot || isBotUa(meta.ua)) return "bot";
  if (site.settings.respect_dnt && meta.dnt) return "dnt";
  if (site.settings.block_hosting && meta.hosting) return "hosting";
  if (meta.country && site.settings.block_countries.includes(meta.country.toUpperCase())) return "excluded";

  const f = site.settings.features;
  if (p.t === "outbound" && !f.outbound) return "invalid";
  if (p.t === "download" && !f.downloads) return "invalid";
  if (p.t === "engagement" && !f.engagement) return "invalid";
  if (p.t === "vitals" && !f.vitals) return "invalid";
  if (p.t === "error" && !f.errors) return "invalid";

  const ref = referrerParts(p.r);
  if (ref.host && (SPAM_REFERRERS.some((h) => ref.host === h || ref.host!.endsWith(`.${h}`)) || site.settings.block_referrers.some((h) => ref.host === h || ref.host!.endsWith(`.${h}`)))) return "bot";
  const ownRef = ref.host !== null && hostAllowed(ref.host, site.domains.concat(site.domains.map((d) => `www.${d}`)));
  const referrer = ownRef ? null : ref.referrer;
  const referrerHost = ownRef ? null : ref.host;
  const ua = parseUa(meta.ua, int(p.w));
  const local = localParts(meta.now, site.timezone);
  const vid = await visitorId(salt, site.id, meta.ip, meta.ua);

  let name: string | null = null;
  let props: string | null = null;
  if (p.t === "event") {
    name = str(p.n, MAX_NAME);
    if (!name) return "invalid";
    props = sanitizeProps(p.p);
  } else if (p.t === "error") {
    const m = p.m ?? {};
    name = str(m.msg, MAX_STR);
    if (!name) return "invalid";
    const src = typeof m.src === "string" ? m.src.split("?")[0]!.slice(0, MAX_STR) : null;
    props = JSON.stringify({ source: src, line: int(m.line) });
  }

  let targetUrl: string | null = null;
  if (p.t === "outbound" || p.t === "download") {
    targetUrl = str(p.x, 500);
    if (!targetUrl) return "invalid";
    if (/^https?:/i.test(targetUrl)) {
      try {
        const t = new URL(targetUrl);
        targetUrl = `${t.protocol}//${t.host}${t.pathname}`;
      } catch {
        return "invalid";
      }
    } else if (/^(mailto|tel):/i.test(targetUrl)) {
      targetUrl = targetUrl.split(":")[0]!.toLowerCase() + ":";
    }
  }

  const v = p.v ?? {};
  return {
    id: ulid(meta.now),
    site_id: site.id,
    ts: meta.now,
    local_day: local.day,
    local_hour: local.hour,
    type: p.t,
    visitor_id: vid,
    pageview_id: str(p.pv, 40),
    hostname: page.hostname,
    pathname: page.pathname,
    query: page.query,
    title: str(p.ti),
    referrer,
    referrer_host: referrerHost,
    channel: classifyChannel({
      referrerHost,
      utmSource: page.utm.source,
      utmMedium: page.utm.medium,
      ownHosts: site.domains,
    }),
    utm_source: page.utm.source,
    utm_medium: page.utm.medium,
    utm_campaign: page.utm.campaign,
    utm_term: page.utm.term,
    utm_content: page.utm.content,
    country: meta.country,
    region: meta.region,
    city: meta.city,
    continent: meta.continent,
    device: ua.device,
    browser: ua.browser,
    browser_version: ua.browser_version,
    os: ua.os,
    os_version: ua.os_version,
    screen_w: int(p.w, 0, 20000),
    screen_h: int(p.h, 0, 20000),
    language: str(p.l, 35)?.toLowerCase() ?? null,
    name,
    props_json: props,
    engaged_ms: p.t === "engagement" ? int(p.e, 0, 6 * 3600_000) : null,
    scroll_pct: p.t === "engagement" ? int(p.sc, 0, 100) : null,
    url: targetUrl,
    lcp: p.t === "vitals" ? vital(v.lcp) : null,
    inp: p.t === "vitals" ? vital(v.inp) : null,
    cls: p.t === "vitals" ? num(v.cls, 0, 100) : null,
    fcp: p.t === "vitals" ? num(v.fcp, 0, 120_000) : null,
    ttfb: p.t === "vitals" ? num(v.ttfb, 0, 120_000) : null,
    search_term: p.t === "pageview" ? searchTerm(p.u, site.settings.search_params) : null,
    source: "pulse",
  };
}

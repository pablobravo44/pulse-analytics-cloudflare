export const HIT_TYPES = ["pageview", "event", "engagement", "outbound", "download", "vitals", "error"] as const;
export type HitType = (typeof HIT_TYPES)[number];

/** Raw tracker payload. */
export interface TrackerPayload {
  s: string;
  t: HitType;
  u: string;
  r?: string;
  ti?: string;
  w?: number;
  h?: number;
  l?: string;
  n?: string;
  p?: Record<string, string | number | boolean>;
  pv?: string;
  e?: number;
  sc?: number;
  v?: { lcp?: number; inp?: number; cls?: number; fcp?: number; ttfb?: number };
  b?: boolean | number;
  x?: string; // outbound/download target url
  m?: { msg?: string; src?: string; line?: number }; // error
}

/** Enriched hit, queued without any IP. */
export interface EnrichedHit {
  id: string;
  site_id: string;
  ts: number;
  local_day: string;
  local_hour: number;
  type: HitType;
  visitor_id: string;
  pageview_id: string | null;
  hostname: string;
  pathname: string;
  query: string | null;
  title: string | null;
  referrer: string | null;
  referrer_host: string | null;
  channel: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  continent: string | null;
  device: string;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  os_version: string | null;
  screen_w: number | null;
  screen_h: number | null;
  language: string | null;
  name: string | null;
  props_json: string | null;
  engaged_ms: number | null;
  scroll_pct: number | null;
  url: string | null;
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
  search_term?: string | null;
  source: "pulse";
}

export const DEFAULT_QUERY_ALLOWLIST = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source"];

export interface ParsedPage {
  hostname: string;
  pathname: string;
  query: string | null; // allowlisted, "?a=b" form or null
  utm: { source: string | null; medium: string | null; campaign: string | null; term: string | null; content: string | null };
}

export function stripQuery(search: string, allowlist: readonly string[] = DEFAULT_QUERY_ALLOWLIST): string | null {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const [k, v] of params) if (allowlist.includes(k.toLowerCase())) out.append(k.toLowerCase(), v.slice(0, 200));
  const s = out.toString();
  return s ? `?${s}` : null;
}

export function parsePage(raw: string, allowlist?: readonly string[]): ParsedPage | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const p = u.searchParams;
  const g = (k: string) => (p.get(k)?.slice(0, 200) || null);
  let pathname = u.pathname || "/";
  try {
    pathname = decodeURI(pathname);
  } catch {
    /* keep encoded */
  }
  return {
    hostname: u.hostname.toLowerCase(),
    pathname: pathname.slice(0, 500),
    query: stripQuery(u.search, allowlist),
    utm: {
      source: g("utm_source")?.toLowerCase() ?? (g("ref") ?? g("source"))?.toLowerCase() ?? null,
      medium: g("utm_medium")?.toLowerCase() ?? null,
      campaign: g("utm_campaign"),
      term: g("utm_term"),
      content: g("utm_content"),
    },
  };
}

/**
 * Android apps send `android-app://<package>/` as the referrer. Known packages map to the canonical host of the
 * service's web referrer, so app and web visits group together (same channel, same source_name).
 */
export const ANDROID_APP_HOSTS: Readonly<Record<string, string>> = {
  "com.google.android.gm": "mail.google.com",
  "com.google.android.gm.lite": "mail.google.com",
  "com.google.android.googlequicksearchbox": "google.com",
  "com.google.android.youtube": "youtube.com",
  "com.reddit.frontpage": "reddit.com",
  "com.facebook.katana": "facebook.com",
  "com.facebook.lite": "facebook.com",
  "com.facebook.orca": "facebook.com",
  "com.instagram.android": "instagram.com",
  "com.linkedin.android": "linkedin.com",
  "com.twitter.android": "x.com",
  "com.twitter.android.lite": "x.com",
  "org.telegram.messenger": "t.me",
  "org.telegram.messenger.web": "t.me",
  "com.whatsapp": "whatsapp.com",
  "com.whatsapp.w4b": "whatsapp.com",
  "com.slack": "slack.com",
  "com.microsoft.office.outlook": "outlook.live.com",
  "com.yahoo.mobile.client.android.mail": "mail.yahoo.com",
  "com.microsoft.bing": "bing.com",
  "com.duckduckgo.mobile.android": "duckduckgo.com",
  "com.pinterest": "pinterest.com",
  "com.zhiliaoapp.musically": "tiktok.com",
};

export function referrerParts(ref: string | null | undefined): { referrer: string | null; host: string | null } {
  if (!ref) return { referrer: null, host: null };
  try {
    const u = new URL(ref);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "android-app:") return { referrer: null, host: null };
    if (u.protocol === "android-app:") {
      // URL lower-cases the hostname, so the keys above are lower-case too.
      const web = ANDROID_APP_HOSTS[u.hostname.toLowerCase()];
      if (web) return { referrer: `https://${web}/`, host: web };
    }
    // Keep origin + path only; never the query string of a referrer.
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return { referrer: `${u.protocol}//${u.hostname}${u.pathname}`.slice(0, 500), host };
  } catch {
    return { referrer: null, host: null };
  }
}

/** Does `host` match an allowed site domain? Exact match, or `*.example.com` entries for subdomains. */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => {
    const dd = d.toLowerCase();
    if (dd.startsWith("*.")) return h.endsWith(dd.slice(1));
    return h === dd;
  });
}

/**
 * A `next` redirect target that stays on `origin`: a path ("/sites/x?y"), or "/" for anything else. Checking
 * `startsWith("/") && !startsWith("//")` isn't enough: browsers read "/\evil.com" (and "/<tab>/evil.com") as
 * "//evil.com", another host. So backslashes, whitespace and control characters are refused, and the URL resolved
 * against the origin must still be on it.
 */
export function sameOriginPath(next: string | null | undefined, origin: string): string {
  if (!next || next[0] !== "/" || /[\\\s\u0000-\u001f\u007f]/.test(next)) return "/";
  try {
    const base = new URL(origin);
    const u = new URL(next, base);
    return u.origin === base.origin ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}

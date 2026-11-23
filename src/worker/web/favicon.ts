// Favicons of referrer hosts for the dashboard's source lists. The dashboard asks Pulse (/icons/favicon/<host>), and
// the Worker fetches the icon from that host itself and caches it: the browser of the person reading the dashboard
// never talks to a third party, and no icon service learns which sites send traffic. Only a signed-in session may ask
// (the route checks the dashboard cookie), so this is not an open proxy.

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;
const MAX_BYTES = 100 * 1024;
const OK_TTL = 7 * 86_400;
const MISS_TTL = 86_400;

/** A hostname we are willing to fetch from: a public DNS name (not an IP, not localhost or an internal name). */
export function validIconHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^www\./, "");
  if (!HOST.test(host) || /^\d+(\.\d+)+$/.test(host) || /\.(local|internal|localhost|lan|home|arpa)$/.test(host)) return null;
  return host;
}

async function fetchImage(url: string): Promise<Response | null> {
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(3000), headers: { Accept: "image/*" }, cf: { cacheTtl: OK_TTL } } as RequestInit);
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok || !/^image\//.test(type)) return null;
    const body = await r.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_BYTES) return null;
    return new Response(body, { headers: { "Content-Type": type.split(";")[0]! } });
  } catch {
    return null;
  }
}

/** The icon <link> of a home page, if it names one (the first 64 KB are enough for any <head>). */
export function iconHref(html: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href && !href.startsWith("data:")) return href;
  }
  return null;
}

async function findIcon(host: string): Promise<Response | null> {
  const direct = await fetchImage(`https://${host}/favicon.ico`);
  if (direct) return direct;
  try {
    const page = await fetch(`https://${host}/`, { redirect: "follow", signal: AbortSignal.timeout(3000), headers: { Accept: "text/html" } });
    if (!page.ok || !page.body) return null;
    const reader = page.body.getReader();
    let html = "";
    const dec = new TextDecoder();
    while (html.length < 65_536) {
      const { value, done } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    const href = iconHref(html);
    if (!href) return null;
    const url = new URL(href, page.url || `https://${host}/`);
    if (url.protocol !== "https:") return null;
    return fetchImage(url.href);
  } catch {
    return null;
  }
}

/** The icon for `host`: cached at the edge for a week (a miss for a day, so a slow host isn't asked on every view). */
export async function favicon(rawHost: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const host = validIconHost(rawHost);
  if (!host) return new Response(null, { status: 400 });
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(`https://cache.pulse.internal/favicon/${host}`);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return hit;
  const icon = await findIcon(host);
  const res = icon
    ? new Response(icon.body, { headers: { "Content-Type": icon.headers.get("Content-Type")!, "Cache-Control": `private, max-age=${OK_TTL}`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } })
    : new Response(null, { status: 404, headers: { "Cache-Control": `private, max-age=${MISS_TTL}` } });
  if (cache) {
    const stored = res.clone();
    const copy = new Response(stored.body, { status: stored.status, headers: { ...Object.fromEntries(stored.headers), "Cache-Control": `max-age=${icon ? OK_TTL : MISS_TTL}` } });
    const put = cache.put(key, copy).catch(() => {});
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

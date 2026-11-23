// Edge cache (Cache API, per data center) for read reports. Only aggregates are stored, after the caller has
// authorized the site; the key carries everything the answer depends on. Where there is no Cache API (Node dev
// server, unit tests) every call computes.

interface WaitUntil {
  waitUntil(p: Promise<unknown>): void;
}

export async function edgeCached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>, ctx?: WaitUntil): Promise<{ value: T; hit: boolean }> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!cache) return { value: await fn(), hit: false };
  const req = new Request(`https://cache.pulse.internal/${encodeURIComponent(key)}`);
  const found = await cache.match(req).catch(() => undefined);
  if (found) return { value: (await found.json()) as T, hit: true };
  const value = await fn();
  const put = cache.put(req, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlSeconds}` } })).catch(() => {});
  if (ctx) ctx.waitUntil(put);
  else await put;
  return { value, hit: false };
}

/** Cache key part for a URL's query string: parameters sorted so the same report always gets the same key. */
export function sortedQuery(url: string): string {
  const u = new URL(url);
  return [...u.searchParams.entries()].sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b))).map(([k, v]) => `${k}=${v}`).join("&");
}

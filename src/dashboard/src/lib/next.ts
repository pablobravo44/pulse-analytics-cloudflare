// Same rule as sameOriginPath in src/worker/lib/url.ts (the dashboard bundle doesn't import Worker code).
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

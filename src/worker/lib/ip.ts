import { sha256Hex } from "./crypto.ts";

/**
 * The part of a client IP that rate limits are keyed by: the whole address for IPv4 (and IPv4-mapped IPv6),
 * the /64 prefix for IPv6. One IPv6 subscriber usually gets a whole /64, so keying by the full address would
 * let a single client rotate through 2^64 keys. Never stored or logged; callers hash it into the limiter key.
 */
export function rateLimitSubject(ip: string): string {
  const s = ip.trim().toLowerCase().split("%")[0]!;
  if (!s.includes(":")) return s;
  const halves = s.split("::");
  if (halves.length > 2) return s;
  const parts = (x: string | undefined) => (x ? x.split(":") : []);
  let head = parts(halves[0]);
  let tail = parts(halves[1]);
  // An embedded IPv4 tail ("::ffff:192.0.2.1") is two groups; an IPv4-mapped address is that IPv4.
  const last = (halves.length === 2 ? tail : head).at(-1);
  if (last?.includes(".")) {
    const octets = last.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return s;
    const groups = [((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16)];
    if (halves.length === 2) tail = [...tail.slice(0, -1), ...groups];
    else head = [...head.slice(0, -1), ...groups];
    const all = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
    if (all.slice(0, 5).every((g) => /^0+$/.test(g)) && /^0*ffff$/.test(all[5] ?? "")) return last;
  }
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** A rate-limit key for the client of a request: hashed IPv4 address or IPv6 /64, never the address itself. */
export async function clientKey(req: Request): Promise<string> {
  return (await sha256Hex(rateLimitSubject(req.headers.get("cf-connecting-ip") ?? "unknown"))).slice(0, 32);
}

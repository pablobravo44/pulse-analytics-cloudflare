// Sign-in through Cloudflare Access (one-time code by email). Access protects only /auth/access; it
// sends the signed-in identity as a JWT (Cf-Access-Jwt-Assertion) which is verified here against the
// team's public keys, the application's audience tag and the allow-list of emails, then a normal
// dashboard session is created. Everything else (tracker, ingest, API keys, MCP) never sees Access.

export interface AccessConfig {
  /** e.g. "your-team.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  /** Lower-case emails allowed to sign in this way. */
  emails: string[];
}

export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; ACCESS_EMAILS?: string }): AccessConfig | null {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ACCESS_EMAILS) return null;
  const emails = env.ACCESS_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return emails.length ? { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, emails } : null;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

const keyCache = new Map<string, { at: number; keys: Jwk[] }>();
const KEY_TTL_MS = 3600_000;

async function teamKeys(teamDomain: string, fetcher: typeof fetch, now: number, refresh = false): Promise<Jwk[]> {
  const hit = keyCache.get(teamDomain);
  if (hit && !refresh && now - hit.at < KEY_TTL_MS) return hit.keys;
  const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs HTTP ${res.status}`);
  const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
  keyCache.set(teamDomain, { at: now, keys });
  return keys;
}

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The verified, allowed email, or null for anything else (bad signature, audience, issuer, expiry or email).
 * Allowed = in ACCESS_EMAILS (bootstrap) or accepted by `allowEmail` (an enabled person in the users table),
 * so inviting someone in Pulse is enough; no wrangler change.
 */
export async function verifyAccessJwt(token: string | null | undefined, cfg: AccessConfig, opts: { fetch?: typeof fetch; now?: number; allowEmail?: (email: string) => Promise<boolean> } = {}): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetch ?? fetch;
  let header: { alg?: string; kid?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1]!)));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  let jwk = (await teamKeys(cfg.teamDomain, fetcher, now)).find((k) => k.kid === header.kid);
  // Access rotates keys; one refresh covers a token signed with a key newer than the cache.
  if (!jwk) jwk = (await teamKeys(cfg.teamDomain, fetcher, now, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(cfg.aud)) return null;
  if (claims.iss !== `https://${cfg.teamDomain}`) return null;
  const sec = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp < sec) return null;
  if (typeof claims.nbf === "number" && claims.nbf > sec + 60) return null;
  const email = claims.email?.toLowerCase();
  if (!email) return null;
  if (cfg.emails.includes(email)) return email;
  return opts.allowEmail && (await opts.allowEmail(email)) ? email : null;
}

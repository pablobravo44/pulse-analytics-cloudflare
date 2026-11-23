// Share-link passwords: PBKDF2-SHA256 (WebCrypto), "pbkdf2$<iterations>$<salt>$<hash>" with base64 salt and hash.
// Links made before this used SHA-256("<link id>:<password>") in hex; those still verify and are rehashed on
// the first correct password.
import { safeEqual, sha256Hex } from "./crypto.ts";

/** Workers' WebCrypto accepts at most 100000 PBKDF2 iterations. */
export const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(await derive(password, salt, iterations))}`;
}

/**
 * Check a share link's password. `rehash` is set when the stored hash is the old fast format (or weaker than
 * today's iterations) and the password was right: the caller stores it in place of the old one.
 */
export async function verifySharePassword(linkId: string, password: string, stored: string): Promise<{ ok: boolean; rehash: string | null }> {
  if (stored.startsWith("pbkdf2$")) {
    const [, iter, salt, hash] = stored.split("$");
    const iterations = Number(iter);
    if (!salt || !hash || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return { ok: false, rehash: null };
    const ok = safeEqual(b64(await derive(password, unb64(salt), iterations)), hash);
    return { ok, rehash: ok && iterations < PBKDF2_ITERATIONS ? await hashPassword(password) : null };
  }
  const ok = safeEqual(await sha256Hex(`${linkId}:${password}`), stored);
  return { ok, rehash: ok ? await hashPassword(password) : null };
}

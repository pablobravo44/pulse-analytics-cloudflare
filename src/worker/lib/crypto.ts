const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

export async function hmacHex(key: string, message: string, bytes = 32): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return toHex(sig.slice(0, bytes));
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function randomToken(bytes = 32): string {
  return base32(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomHex(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string compare (same length required for equality). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The AES-GCM key from the PULSE_SECRET_KEY secret (32 random bytes, base64), or null when it isn't set. */
async function secretKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (!secret) return null;
  const raw = unb64(secret.trim());
  if (raw.length !== 32) throw new Error("PULSE_SECRET_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a JSON value for storage ("v1.<iv>.<ciphertext>"). Throws when the secret isn't configured. */
export async function sealJson(secret: string | undefined, value: unknown): Promise<string> {
  const key = await secretKey(secret);
  if (!key) throw new Error("PULSE_SECRET_KEY is not configured");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value))));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function openJson<T>(secret: string | undefined, sealed: string): Promise<T> {
  const key = await secretKey(secret);
  if (!key) throw new Error("PULSE_SECRET_KEY is not configured");
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("unknown sealed format");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

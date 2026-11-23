import { describe, expect, it, vi } from "vitest";
import { sameOriginPath as dashboardNext } from "../../src/dashboard/src/lib/next.ts";
import { accessConfig, verifyAccessJwt, type AccessConfig } from "../../src/worker/auth/access.ts";
import { sameOriginPath } from "../../src/worker/lib/url.ts";
import { makeEnv } from "./harness.ts";

const TEAM = "team-test.cloudflareaccess.com";
const AUD = "aud-tag-123";
const cfg: AccessConfig = { teamDomain: TEAM, aud: AUD, emails: ["owner@example.com"] };
const NOW = Date.UTC(2026, 9, 13, 12);

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid };
  return { pair, jwk };
}

async function sign(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>) {
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc(claims);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${btoa(String.fromCharCode(...sig)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

const good = { aud: [AUD], iss: `https://${TEAM}`, email: "Owner@Example.com", exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10 };

describe("Cloudflare Access sign-in", () => {
  it("reads its config only when all three variables are set", () => {
    expect(accessConfig({})).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_EMAILS: " A@x.com , b@y.com" })).toEqual({ teamDomain: TEAM, aud: AUD, emails: ["a@x.com", "b@y.com"] });
  });

  it("accepts a valid token for an allowed email and rejects everything else", async () => {
    const { pair, jwk } = await keyPair("k1");
    const other = await keyPair("k1");
    const fetcher = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch;
    const opts = { fetch: fetcher, now: NOW };
    expect(await verifyAccessJwt(await sign(pair.privateKey, "k1", good), { ...cfg, teamDomain: TEAM }, opts)).toBe("owner@example.com");
    expect(await verifyAccessJwt(await sign(pair.privateKey, "k1", { ...good, email: "intruder@example.com" }), cfg, opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(pair.privateKey, "k1", { ...good, aud: ["other-app"] }), cfg, opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(pair.privateKey, "k1", { ...good, iss: "https://evil.cloudflareaccess.com" }), cfg, opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(pair.privateKey, "k1", { ...good, exp: NOW / 1000 - 1 }), cfg, opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(other.pair.privateKey, "k1", good), cfg, opts)).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", cfg, opts)).toBeNull();
    // People invited in Pulse can sign in with Access too, without editing ACCESS_EMAILS.
    const invited = await sign(pair.privateKey, "k1", { ...good, email: "viewer@example.com" });
    expect(await verifyAccessJwt(invited, cfg, { ...opts, allowEmail: async (e) => e === "viewer@example.com" })).toBe("viewer@example.com");
    expect(await verifyAccessJwt(invited, cfg, { ...opts, allowEmail: async () => false })).toBeNull();
    expect(await verifyAccessJwt(null, cfg, opts)).toBeNull();
  });

  it("refreshes the team keys once for an unknown key id", async () => {
    const old = await keyPair("old");
    const fresh = await keyPair("new");
    let calls = 0;
    const fetcher = (async () => new Response(JSON.stringify({ keys: calls++ === 0 ? [old.jwk] : [old.jwk, fresh.jwk] }))) as unknown as typeof fetch;
    const team = { ...cfg, teamDomain: "rotating.cloudflareaccess.com" };
    const token = await sign(fresh.pair.privateKey, "new", { ...good, iss: "https://rotating.cloudflareaccess.com" });
    expect(await verifyAccessJwt(token, team, { fetch: fetcher, now: NOW })).toBe("owner@example.com");
    expect(calls).toBe(2);
  });
});

describe("redirect after sign-in", () => {
  const cases: [string | null, string][] = [
    ["/sites/test?range=7d#top", "/sites/test?range=7d#top"],
    ["/", "/"],
    [null, "/"],
    ["", "/"],
    ["//evil.com", "/"],
    ["/\\evil.com", "/"],
    ["/\\/evil.com", "/"],
    ["\\\\evil.com", "/"],
    ["/\t/evil.com", "/"],
    ["/%5Cevil.com", "/%5Cevil.com"],
    ["https://evil.com/", "/"],
    ["javascript:alert(1)", "/"],
    ["/sites/../settings", "/settings"],
  ];
  it.each(cases)("Worker: next=%j → %s", (next, want) => expect(sameOriginPath(next, "https://pulse.test")).toBe(want));
  it.each(cases)("dashboard: next=%j → %s", (next, want) => expect(dashboardNext(next, "https://pulse.test")).toBe(want));

  it("/auth/access only redirects to paths on Pulse's own origin", async () => {
    const h = makeEnv();
    const team = "redirect-test.cloudflareaccess.com";
    Object.assign(h.env, { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD, ACCESS_EMAILS: "owner@example.com" });
    const { pair, jwk } = await keyPair("r1");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ keys: [jwk] })));
    try {
      const now = Date.now();
      const token = await sign(pair.privateKey, "r1", { ...good, iss: `https://${team}`, exp: now / 1000 + 600, nbf: now / 1000 - 10 });
      const go = async (next: string) => (await h.call(`/auth/access?next=${encodeURIComponent(next)}`, { headers: { "cf-access-jwt-assertion": token } })).headers.get("location");
      expect(await go("/\\evil.com")).toBe("/");
      expect(await go("//evil.com/x")).toBe("/");
      expect(await go("/sites/test?x=1")).toBe("/sites/test?x=1");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { classifyChannel, mapRybbitChannel, sourceNameSql } from "../../src/worker/lib/channels.ts";
import { rateLimitSubject } from "../../src/worker/lib/ip.ts";
import { hashPassword, verifySharePassword } from "../../src/worker/lib/password.ts";
import { addDays, localParts, startOfLocalDay, weekStart } from "../../src/worker/lib/time.ts";
import { isBotUa, parseUa } from "../../src/worker/lib/ua.ts";
import { hostAllowed, parsePage, referrerParts, stripQuery } from "../../src/worker/lib/url.ts";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

describe("channels", () => {
  const own = ["example.com"];
  it.each([
    [{ referrerHost: "chatgpt.com" }, "AI Assistants"],
    [{ referrerHost: "www.perplexity.ai" }, "AI Assistants"],
    [{ utmSource: "chatgpt.com" }, "AI Assistants"],
    [{ referrerHost: "gemini.google.com" }, "AI Assistants"],
    [{ referrerHost: "google.com", utmMedium: "cpc" }, "Paid Search"],
    [{ referrerHost: "facebook.com", utmMedium: "paid_social" }, "Paid Social"],
    [{ utmMedium: "email" }, "Email"],
    [{ referrerHost: "mail.google.com" }, "Email"],
    [{ referrerHost: "www.google.es" }, "Organic Search"],
    [{ referrerHost: "google.co.uk" }, "Organic Search"],
    [{ referrerHost: "bing.com" }, "Organic Search"],
    [{ referrerHost: "duckduckgo.com" }, "Organic Search"],
    [{ referrerHost: "search.brave.com" }, "Organic Search"],
    [{ referrerHost: "l.facebook.com" }, "Organic Social"],
    [{ referrerHost: "t.co" }, "Organic Social"],
    [{ referrerHost: "bsky.app" }, "Organic Social"],
    [{ referrerHost: "example.org" }, "Referral"],
    [{ referrerHost: "example.com" }, "Direct"],
    [{}, "Direct"],
  ])("%o → %s", (input, expected) => {
    expect(classifyChannel({ ...input, ownHosts: own })).toBe(expected);
  });

  it("maps rybbit channel names, keeping AI detection", () => {
    expect(mapRybbitChannel("Organic Search", { referrerHost: "google.com" })).toBe("Organic Search");
    expect(mapRybbitChannel("Referral", { referrerHost: "chatgpt.com" })).toBe("AI Assistants");
    expect(mapRybbitChannel("Direct", {})).toBe("Direct");
    expect(mapRybbitChannel("weird", { referrerHost: "x.com" })).toBe("Organic Social");
  });

  it.each([
    [["www.google.es", null], "Google"],
    [["google.co.uk", null], "Google"],
    [["mail.google.com", null], "Gmail"],
    [["gemini.google.com", null], "Gemini"],
    [["www.bing.com", null], "Bing"],
    [["duckduckgo.com", null], "DuckDuckGo"],
    [["search.brave.com", null], "Brave Search"],
    [["es.search.yahoo.com", null], "Yahoo"],
    [["l.facebook.com", null], "Facebook"],
    [["m.facebook.com", null], "Facebook"],
    [["l.instagram.com", null], "Instagram"],
    [["t.co", null], "X"],
    [["www.linkedin.com", null], "LinkedIn"],
    [["lnkd.in", null], "LinkedIn"],
    [["pinterest.es", null], "Pinterest"],
    [["chatgpt.com", null], "ChatGPT"],
    [[null, "Facebook"], "Facebook"],
    [[null, "ig"], "Instagram"],
    [["www.example.org", null], "example.org"],
    [[null, "newsletter-42"], "newsletter-42"],
    [["notgoogle.com", null], "notgoogle.com"],
    [[null, null], null],
  ] as const)("source name %o → %s", ([host, utm], expected) => {
    const db = new DatabaseSync(":memory:");
    const row = db.prepare(`SELECT ${sourceNameSql("?1", "?2")} AS n`).get(host, utm) as { n: string | null };
    expect(row.n).toBe(expected);
  });
});

describe("time", () => {
  it("local day/hour in Madrid across spring-forward (29 Mar 2026)", () => {
    // 2026-03-29 00:59:59Z = 01:59:59 CET; 01:00:00Z = 03:00 CEST
    expect(localParts(Date.UTC(2026, 2, 29, 0, 59, 59), "Europe/Madrid")).toMatchObject({ day: "2026-03-29", hour: 1 });
    expect(localParts(Date.UTC(2026, 2, 29, 1, 0, 0), "Europe/Madrid")).toMatchObject({ day: "2026-03-29", hour: 3 });
  });
  it("local day/hour in Madrid across fall-back (25 Oct 2026)", () => {
    expect(localParts(Date.UTC(2026, 9, 25, 0, 30), "Europe/Madrid")).toMatchObject({ hour: 2 });
    expect(localParts(Date.UTC(2026, 9, 25, 1, 30), "Europe/Madrid")).toMatchObject({ hour: 2 });
    expect(localParts(Date.UTC(2026, 9, 24, 22, 30), "Europe/Madrid")).toMatchObject({ day: "2026-10-25", hour: 0 });
  });
  it("start of local day", () => {
    expect(startOfLocalDay("2026-10-12", "Europe/Madrid")).toBe(Date.UTC(2026, 9, 11, 22));
    expect(startOfLocalDay("2026-01-12", "Europe/Madrid")).toBe(Date.UTC(2026, 0, 11, 23));
    expect(startOfLocalDay("2026-03-29", "Europe/Madrid")).toBe(Date.UTC(2026, 2, 28, 23));
    expect(startOfLocalDay("2026-03-30", "Europe/Madrid")).toBe(Date.UTC(2026, 2, 29, 22));
  });
  it("day arithmetic", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    expect(weekStart("2026-10-18")).toBe("2026-10-12");
  });
});

describe("url", () => {
  it("strips query to the allowlist", () => {
    expect(stripQuery("?utm_source=x&token=secret&ref=hn")).toBe("?utm_source=x&ref=hn");
    expect(stripQuery("?a=1")).toBeNull();
  });
  it("parses pages", () => {
    const p = parsePage("https://example.com/es/precios?utm_source=Newsletter&utm_medium=email&t=abc");
    expect(p).toMatchObject({ hostname: "example.com", pathname: "/es/precios", query: "?utm_source=Newsletter&utm_medium=email" });
    expect(p?.utm.source).toBe("newsletter");
    expect(parsePage("javascript:alert(1)")).toBeNull();
  });
  it("referrer drops query", () => {
    expect(referrerParts("https://www.google.com/search?q=secret")).toEqual({ referrer: "https://www.google.com/search", host: "google.com" });
  });
  it("host allowlist: exact or *.domain", () => {
    expect(hostAllowed("example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("evil.example.com", ["example.com"])).toBe(false);
    expect(hostAllowed("www.example.com", ["example.com", "*.example.com"])).toBe(true);
    expect(hostAllowed("example.com.evil.io", ["example.com"])).toBe(false);
  });
});

describe("ua", () => {
  it("parses desktop and mobile", () => {
    expect(parseUa(CHROME)).toMatchObject({ device: "desktop", browser: "Chrome", browser_version: "141", os: "Windows" });
    expect(parseUa(IPHONE)).toMatchObject({ device: "mobile", os: "iOS" });
  });
  it("detects bots", () => {
    expect(isBotUa("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBe(true);
    expect(isBotUa(CHROME.replace("Chrome/", "HeadlessChrome/"))).toBe(true);
    expect(isBotUa("")).toBe(true);
    expect(isBotUa("curl/8")).toBe(true);
    expect(isBotUa(CHROME)).toBe(false);
  });
});

describe("ip", () => {
  it("keys IPv4 by address and IPv6 by its /64", () => {
    expect(rateLimitSubject("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitSubject("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(rateLimitSubject("2001:DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitSubject("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitSubject("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitSubject("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitSubject("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitSubject("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    // Garbage is passed through unchanged (it still gets hashed into a key).
    expect(rateLimitSubject("1:2:3")).toBe("1:2:3");
    expect(rateLimitSubject("1::2::3")).toBe("1::2::3");
  });
});

describe("share passwords", () => {
  it("PBKDF2 with a random salt; weaker hashes verify and ask to be rehashed", async () => {
    const a = await hashPassword("secret!");
    const b = await hashPassword("secret!");
    expect(a).not.toBe(b);
    expect(await verifySharePassword("id1", "secret!", a)).toEqual({ ok: true, rehash: null });
    expect((await verifySharePassword("id1", "Secret!", a)).ok).toBe(false);
    const weak = await hashPassword("secret!", 1000);
    const v = await verifySharePassword("id1", "secret!", weak);
    expect(v.ok).toBe(true);
    expect(v.rehash?.startsWith("pbkdf2$100000$")).toBe(true);
    expect((await verifySharePassword("id1", "secret!", "pbkdf2$999999999$AAAA$BBBB")).ok).toBe(false);
    expect((await verifySharePassword("id1", "secret!", "pbkdf2$x")).ok).toBe(false);
  });
});

describe("visitor salts (Pulse v2 2.8, 2.11)", () => {
  it("one salt per local day of the site: no split at UTC midnight, no link across local midnight", async () => {
    const { createD1, migrate } = await import("./d1-shim.ts");
    const { saltFor } = await import("../../src/worker/ingest/salt.ts");
    const db = createD1();
    migrate(db);
    const tz = "Europe/Madrid"; // UTC+2 in October
    const lateLocal = await saltFor(db, tz, Date.UTC(2026, 9, 12, 21, 0)); // 23:00 on the 12th, Madrid
    const afterLocalMidnight = await saltFor(db, tz, Date.UTC(2026, 9, 12, 22, 30)); // 00:30 on the 13th
    const afterUtcMidnight = await saltFor(db, tz, Date.UTC(2026, 9, 13, 0, 30)); // 02:30 on the 13th
    expect(afterLocalMidnight).not.toBe(lateLocal);
    expect(afterUtcMidnight).toBe(afterLocalMidnight);
  });

  it("a salt is deleted as soon as its local day is over", async () => {
    const { createD1, migrate } = await import("./d1-shim.ts");
    const { saltFor, rotateSalts } = await import("../../src/worker/ingest/salt.ts");
    const db = createD1();
    migrate(db);
    await saltFor(db, "Europe/Madrid", Date.UTC(2026, 9, 12, 12));
    await saltFor(db, "America/New_York", Date.UTC(2026, 9, 12, 12));
    // 00:10 on the 13th in Madrid, still the 12th in New York.
    expect(await rotateSalts(db, Date.UTC(2026, 9, 12, 22, 10))).toBe(1);
    expect(db.sqlite.prepare("SELECT day FROM salts").all().map((r) => (r as { day: string }).day)).toEqual(["2026-10-12@America/New_York"]);
  });
});

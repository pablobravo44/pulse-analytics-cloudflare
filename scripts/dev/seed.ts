// Demo data for the local dev server: three sites, ~120 days of synthetic traffic through the real
// enrich + consumer code, goals, funnels, annotations and checks.
//   npm run dev:seed            (wipes .data/dev.sqlite first)
import { rmSync, writeFileSync } from "node:fs";
import { enrich } from "../../src/worker/ingest/enrich.ts";
import type { TrackerPayload } from "../../src/worker/ingest/types.ts";
import { invalidateSiteCache, rowToSite, type SiteRow } from "../../src/worker/lib/sites.ts";
import { localParts } from "../../src/worker/lib/time.ts";
import { processHit } from "../../src/worker/queue/consumer.ts";
import { createSession } from "../../src/worker/auth/session.ts";
import { DEV_DB, devEnv } from "./env.ts";

for (const f of [DEV_DB, `${DEV_DB}-wal`, `${DEV_DB}-shm`]) rmSync(f, { force: true });
const { db } = devEnv();
db.sqlite.exec("PRAGMA synchronous = OFF");

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const weighted = <T>(a: readonly [T, number][]): T => {
  const total = a.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of a) if ((r -= w) <= 0) return v;
  return a[a.length - 1]![0];
};

const UAS: [string, number][] = [
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", 40],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1", 30],
  ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", 20],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0", 10],
];
const PLACES: [{ country: string; region: string; city: string; continent: string }, number][] = [
  [{ country: "ES", region: "MD", city: "Madrid", continent: "EU" }, 40],
  [{ country: "ES", region: "CL", city: "Valladolid", continent: "EU" }, 20],
  [{ country: "MX", region: "CMX", city: "Mexico City", continent: "NA" }, 10],
  [{ country: "US", region: "CA", city: "San Francisco", continent: "NA" }, 10],
  [{ country: "AR", region: "C", city: "Buenos Aires", continent: "SA" }, 6],
  [{ country: "FR", region: "IDF", city: "Paris", continent: "EU" }, 6],
  [{ country: "DE", region: "BE", city: "Berlin", continent: "EU" }, 4],
  [{ country: "GB", region: "ENG", city: "London", continent: "EU" }, 4],
];
const REFS: [string, number][] = [
  ["", 30],
  ["https://www.google.com/", 35],
  ["https://www.bing.com/", 4],
  ["https://chatgpt.com/", 6],
  ["https://www.perplexity.ai/", 2],
  ["https://t.co/abc", 5],
  ["https://www.reddit.com/r/webdev/", 4],
  ["https://news.ycombinator.com/", 3],
  ["https://duckduckgo.com/", 3],
  ["?utm_source=newsletter&utm_medium=email&utm_campaign=october", 5],
  ["?utm_source=instagram&utm_medium=paid_social&utm_campaign=autumn-sale", 3],
];

interface DemoSite {
  id: string;
  name: string;
  domain: string;
  tz: string;
  base: number;
  pages: [string, string][];
  hidden?: boolean;
  color?: string;
}
const SITES: DemoSite[] = [
  {
    id: "demo-shop",
    color: "teal",
    name: "Demo Shop",
    domain: "shop.example.com",
    tz: "Europe/Madrid",
    base: 70,
    pages: [["/", "Demo Shop"], ["/products", "All products"], ["/products/linen-shirt", "Linen shirt"], ["/products/wool-coat", "Wool coat"], ["/cart", "Cart"], ["/checkout", "Checkout"], ["/thanks", "Thank you"], ["/about", "About us"]],
  },
  {
    id: "demo-blog",
    color: "violet",
    name: "Field Notes",
    domain: "notes.example.org",
    tz: "America/Mexico_City",
    base: 130,
    pages: [["/", "Field Notes"], ["/posts/cookieless-analytics", "Cookieless analytics in 2026"], ["/posts/edge-databases", "Edge databases"], ["/posts/typography-for-dashboards", "Typography for dashboards"], ["/newsletter", "Newsletter"], ["/about", "About"]],
  },
  // A site with a few visits a day: its charts draw bars, not a flat line.
  { id: "demo-quiet", name: "Quiet Corner", domain: "quiet.example.net", tz: "Europe/Madrid", base: 2, color: "amber", pages: [["/", "Quiet Corner"], ["/about", "About"]] },
  { id: "pulse-smoke", name: "Pulse smoke", domain: "smoke.pulse.test", tz: "UTC", base: 0, pages: [["/", "Smoke"]], hidden: true },
];

const now = Date.now();
for (const s of SITES) {
  const settings = { features: { outbound: true, downloads: true, engagement: true, vitals: true, errors: s.id === "demo-shop" }, respect_dnt: false, ...(s.hidden ? { hidden: true } : {}), ...(s.color ? { color: s.color } : {}) };
  await db.prepare("INSERT INTO sites (id, name, domains_json, timezone, settings_json, retention_months, created_at) VALUES (?, ?, ?, ?, ?, 25, ?)")
    .bind(s.id, s.name, JSON.stringify([s.domain]), s.tz, JSON.stringify(settings), now - 130 * 86_400_000)
    .run();
}
invalidateSiteCache();

async function send(site: DemoSite, p: Partial<TrackerPayload> & { t: TrackerPayload["t"]; u: string }, ts: number, who: { ip: string; ua: string; place: (typeof PLACES)[number][0] }) {
  const row = await db.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first<SiteRow>();
  const day = new Date(ts).toISOString().slice(0, 10);
  const h = await enrich({ s: site.id, w: 1440, h: 900, l: "es-ES", ...p } as TrackerPayload, rowToSite(row!), { ip: who.ip, ua: who.ua, origin: null, ...who.place, verifiedBot: false, dnt: false, hosting: false, now: ts }, `dev-salt-${day}`);
  if (typeof h !== "string") await processHit(db, h);
}

let hits = 0;
for (const site of SITES.filter((s) => s.base > 0)) {
  const url = (path: string) => `https://${site.domain}${path}`;
  for (let d = 120; d >= 0; d--) {
    const dayStart = now - d * 86_400_000;
    const dow = new Date(dayStart).getUTCDay();
    const weekly = dow === 0 || dow === 6 ? 0.7 : 1.05;
    const trend = 0.75 + (0.5 * (120 - d)) / 120;
    const spike = d === 34 ? 2.6 : 1;
    const visitors = Math.round(site.base * weekly * trend * spike * (0.8 + rnd() * 0.4) * (d === 0 ? localParts(now, site.tz).hour / 24 : 1));
    for (let v = 0; v < visitors; v++) {
      const who = { ip: `198.51.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}`, ua: weighted(UAS), place: weighted(PLACES) };
      const hour = Math.min(23, Math.max(0, Math.round(14 + (rnd() + rnd() + rnd() - 1.5) * 7)));
      let ts = dayStart - (dayStart % 86_400_000) + hour * 3_600_000 + Math.floor(rnd() * 3_600_000);
      if (ts > now) ts = now - Math.floor(rnd() * 3_600_000);
      const ref = weighted(REFS);
      const depth = 1 + Math.floor(rnd() * rnd() * 5);
      let path = rnd() < 0.55 ? "/" : pick(site.pages)[0];
      for (let i = 0; i < depth; i++) {
        const title = site.pages.find(([p]) => p === path)?.[1] ?? site.name;
        const q = i === 0 && ref.startsWith("?") ? ref : "";
        await send(site, { t: "pageview", u: url(path + q), r: i === 0 && !ref.startsWith("?") ? ref : undefined, ti: title, pv: `pv${hits}` }, ts, who);
        hits++;
        const engaged = 4_000 + Math.floor(rnd() * 90_000);
        await send(site, { t: "engagement", u: url(path), pv: `pv${hits - 1}`, e: engaged, sc: Math.floor(30 + rnd() * 70) }, ts + engaged, who);
        if (rnd() < 0.3) await send(site, { t: "vitals", u: url(path), pv: `pv${hits - 1}`, v: { lcp: 900 + rnd() * 2600, inp: 60 + rnd() * 320, cls: rnd() * 0.18, fcp: 500 + rnd() * 1200, ttfb: 80 + rnd() * 500 } }, ts + 2000, who);
        if (site.id === "demo-shop") {
          if (path.startsWith("/products/") && rnd() < 0.25) {
            await send(site, { t: "event", u: url(path), n: "add_to_cart", p: { product: path.split("/").pop()!, price: path.includes("coat") ? 189 : 59 } }, ts + 5000, who);
            path = "/cart";
          } else if (path === "/cart" && rnd() < 0.5) path = "/checkout";
          else if (path === "/checkout" && rnd() < 0.6) {
            const revenue = rnd() < 0.5 ? 59 : 189;
            await send(site, { t: "event", u: url(path), n: "purchase", p: { revenue, currency: "EUR", items: 1 } }, ts + 8000, who);
            path = "/thanks";
          } else path = pick(site.pages)[0];
          if (rnd() < 0.01) await send(site, { t: "error", u: url(path), m: { msg: "TypeError: Cannot read properties of undefined (reading 'price')", src: `${url("/assets/app.js")}`, line: 412 } }, ts + 3000, who);
        } else {
          if (path === "/newsletter" && rnd() < 0.3) await send(site, { t: "event", u: url(path), n: "newsletter_signup", p: { placement: pick(["footer", "inline", "modal"]) } }, ts + 6000, who);
          if (path.startsWith("/posts/") && rnd() < 0.12) await send(site, { t: "outbound", u: url(path), x: pick(["https://developers.cloudflare.com/d1/", "https://github.com/", "https://fonts.google.com/"]) }, ts + 7000, who);
          if (path.startsWith("/posts/") && rnd() < 0.04) await send(site, { t: "download", u: url(path), x: url("/files/cheatsheet.pdf") }, ts + 7000, who);
          if (rnd() < 0.02) await send(site, { t: "event", u: url("/old-post"), n: "404", p: { path: "/old-post" } }, ts + 1000, who);
          path = rnd() < 0.5 ? pick(site.pages)[0] : "/posts/cookieless-analytics";
        }
        ts += engaged + 2000;
        if (ts > now) break;
      }
    }
  }
  console.log(`${site.id}: done (${hits} pageviews so far)`);
}

const ins = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v).run();
await ins("INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES ('g_purchase', 'demo-shop', 'Purchase', 'event', ?, ?)", JSON.stringify({ event: "purchase" }), now);
await ins("INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES ('g_checkout', 'demo-shop', 'Reached checkout', 'pageview', ?, ?)", JSON.stringify({ path: "/checkout" }), now);
await ins("INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES ('g_signup', 'demo-blog', 'Newsletter signup', 'event', ?, ?)", JSON.stringify({ event: "newsletter_signup" }), now);
await ins(
  "INSERT INTO funnels (id, site_id, name, steps_json, window_minutes, created_at) VALUES ('f_checkout', 'demo-shop', 'Product to purchase', ?, 30, ?)",
  JSON.stringify([{ name: "Product page", match: { kind: "pageview", path: "/products/*" } }, { name: "Added to cart", match: { kind: "event", event: "add_to_cart" } }, { name: "Checkout", match: { kind: "pageview", path: "/checkout" } }, { name: "Purchase", match: { kind: "event", event: "purchase" } }]),
  now,
);
await ins("INSERT INTO annotations (id, site_id, ts, title, body, category, created_by, created_at) VALUES ('a1', 'demo-shop', ?, 'Autumn sale campaign', 'Launched seasonal 20% off email + social push.', 'campaign', 'user:owner@pulse.local', ?)", now - 21 * 86_400_000, now);
await ins("INSERT INTO annotations (id, site_id, ts, title, body, url, category, created_by, created_at) VALUES ('a2', NULL, ?, 'Deploy: new checkout', 'Reduced checkout from 3 steps to 1 and deferred non-critical scripts.', 'https://github.com/example/shop/commit/a1b2c3d', 'deploy', 'key:deploy', ?)", now - 12 * 86_400_000, now);
await ins("INSERT INTO annotations (id, site_id, ts, title, body, category, created_by, created_at) VALUES ('a3', 'demo-blog', ?, 'Post shared on Hacker News', 'Reached front page for 6 hours.', 'campaign', 'user:owner@pulse.local', ?)", now - 18 * 86_400_000, now);
await ins("INSERT INTO annotations (id, site_id, ts, title, body, category, created_by, created_at) VALUES ('a4', 'demo-shop', ?, 'Origin CDN hiccup', 'Brief 503 spike on EU edge nodes; resolved in 12 min.', 'incident', 'key:ops', ?)", now - 4 * 86_400_000, now);

// Checks: replace the production seed (migration 0002) with demo ones.
await ins("DELETE FROM monitors");
await ins("INSERT INTO monitors (id, name, kind, url, site_id, created_at) VALUES ('shop-home', 'Shop home', 'http', 'https://example.com/', 'demo-shop', ?)", now);
await ins("INSERT INTO monitors (id, name, kind, url, site_id, created_at) VALUES ('blog-home', 'Blog home', 'http', 'https://example.org/', 'demo-blog', ?)", now);
await ins("INSERT INTO monitors (id, name, kind, url, site_id, config_json, created_at) VALUES ('blog-newsletter', 'Newsletter job', 'heartbeat', 'heartbeat', 'demo-blog', '{\"period_min\":1440,\"grace_min\":60}', ?)", now);
await ins("INSERT INTO monitors (id, name, kind, url, sort, created_at) VALUES ('pulse-healthz', 'Pulse healthz', 'http', 'self:/healthz', 100, ?)", now);
await ins("INSERT INTO monitors (id, name, kind, url, sort, created_at) VALUES ('pulse-ingest', 'Pulse ingest lag', 'pulse_ingest', 'self:ingest', 100, ?)", now);
for (const m of ["shop-home", "blog-home", "pulse-healthz", "pulse-ingest"]) {
  for (let i = 0; i < 90 * 24; i++) {
    const ts = now - i * 3_600_000;
    const down = m === "blog-home" && i >= 200 && i < 203;
    await ins("INSERT OR REPLACE INTO checks (monitor_id, ts, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)", m, ts, down ? 0 : 1, m === "pulse-ingest" ? null : down ? 503 : 200, m === "pulse-ingest" ? null : Math.round(120 + rnd() * 260), down ? "HTTP 503" : null);
  }
}
await ins("INSERT INTO incidents (id, monitor_id, started_at, resolved_at, error, notified_open, notified_resolved) VALUES ('i1', 'blog-home', ?, ?, 'HTTP 503', 1, 1)", now - 203 * 3_600_000, now - 200 * 3_600_000);

// Status board cells, as the check writer keeps them.
await ins("INSERT OR REPLACE INTO monitor_days (monitor_id, day, checks, up) SELECT monitor_id, ts / 86400000, COUNT(*), SUM(ok) FROM checks GROUP BY monitor_id, ts / 86400000");
// Filtered traffic per day (bots, hosting networks, DNT…) for the site settings chart.
for (const site of ["demo-shop", "demo-blog", "demo-quiet"]) {
  for (let i = 0; i < 30; i++) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const r = (n: number) => Math.round(n * (0.5 + rnd()));
    await ins(
      "INSERT OR REPLACE INTO ingest_stats (day, site_id, accepted, dropped_bot, dropped_hosting, dropped_dnt, dropped_host, dropped_excluded, dropped_rate, dropped_cap, dropped_invalid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      day, site, r(site === "demo-quiet" ? 8 : 400), r(30), r(12), r(4), r(1), r(2), i === 6 ? 40 : 0, 0, r(1),
    );
  }
}

await ins("INSERT INTO users (id, email, name, role, created_at) VALUES ('dev_owner', 'owner@pulse.local', 'Dev owner', 'owner', ?)", now);
const { token } = await createSession(db, "dev_owner", { label: "e2e" });
writeFileSync(".data/session-local-e2e.txt", token + "\n", { mode: 0o600 });
console.log(`seeded ${hits} pageviews; e2e session written to .data/session-local-e2e.txt`);

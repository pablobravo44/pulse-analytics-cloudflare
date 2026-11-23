// Browser judge: opens the dev dashboard like a person would and records every API request per step
// (home, open a site, change the range, switch site), with timings. Needs `npm run dev:api` (or `npm run dev`).
//   node scripts/bench/capture.mjs [origin] [out.json]
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const origin = process.argv[2] ?? "http://localhost:8787";
const out = process.argv[3];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${origin}/__dev/login`);
let step = "";
const log = [];
page.on("response", (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/api/")) return;
  log.push({ step, url: u.pathname + u.search, status: r.status(), ms: Math.round(r.request().timing().responseEnd) });
});
const steps = [
  ["home", () => page.goto(`${origin}/`)],
  ["open site", () => page.goto(`${origin}/sites/demo-shop`)],
  ["range 7d", () => page.goto(`${origin}/sites/demo-shop?range=7d`)],
  ["switch site", () => page.goto(`${origin}/sites/demo-blog`)],
];
const summary = [];
for (const [name, go] of steps) {
  step = name;
  const t0 = Date.now();
  await go();
  await page.waitForLoadState("networkidle").catch(() => {});
  const mine = log.filter((x) => x.step === name);
  summary.push({ step: name, requests: mine.length, errors: mine.filter((x) => x.status >= 400).length, ms: Date.now() - t0, slowest: Math.max(0, ...mine.map((x) => x.ms)) });
}
await browser.close();
for (const s of summary) console.log(`${s.step.padEnd(12)} ${String(s.requests).padStart(3)} requests  ${String(s.errors)} errors  idle after ${s.ms} ms  slowest ${s.slowest} ms`);
if (errors.length) console.log("page errors:\n" + errors.join("\n"));
if (out) writeFileSync(out, JSON.stringify({ summary, log }, null, 1));

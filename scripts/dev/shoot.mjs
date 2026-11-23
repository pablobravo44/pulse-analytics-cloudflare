// Screenshots of the dashboard on the local dev server, for design review.
//   node scripts/dev/shoot.mjs <label> [path ...]  → .data/qa/<label>/<width>-<scheme><path>.png
// Env: PULSE_SHOOT_WIDTHS=1440,390  PULSE_SHOOT_SCHEMES=light,dark  PULSE_DEV_ORIGIN=http://localhost:8787
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const origin = process.env.PULSE_DEV_ORIGIN ?? "http://localhost:8787";
const [label = "shots", ...paths] = process.argv.slice(2);
const widths = (process.env.PULSE_SHOOT_WIDTHS ?? "1440,390").split(",").map(Number);
const schemes = (process.env.PULSE_SHOOT_SCHEMES ?? "light,dark").split(",");
const list = paths.length ? paths : ["/", "/sites/demo-shop", "/status", "/settings"];
mkdirSync(`.data/qa/${label}`, { recursive: true });

const browser = await chromium.launch();
const problems = [];
for (const width of widths) {
  for (const scheme of schemes) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1, locale: process.env.SHOOT_LOCALE || "en-GB" });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && problems.push(`${width} ${scheme}: ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`${width} ${scheme}: ${e.message}`));
    await page.goto(`${origin}/__dev/login`);
    for (const p of list) {
      await page.goto(origin + p);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${width} ${scheme} ${p}: horizontal overflow ${overflow}px`);
      const name = p.replace(/[/?=&]/g, "_") || "_root";
      await page.screenshot({ path: `.data/qa/${label}/${width}-${scheme}${name}.png`, fullPage: true });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(problems.length ? problems.join("\n") : "no console errors or overflow");

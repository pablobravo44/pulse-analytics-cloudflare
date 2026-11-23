// Accessibility judge: runs axe-core on dashboard pages of the local dev server, in light and dark, at 1440 and 390 px.
//   node scripts/dev/axe.mjs [path ...]       (needs the dev server: npm run dev:api)
// Exits 1 when any page has a violation of the given impact or worse (PULSE_AXE_IMPACT, default "serious").
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const origin = process.env.PULSE_DEV_ORIGIN ?? "http://localhost:8787";
const paths = process.argv.slice(2).length ? process.argv.slice(2) : ["/", "/sites/demo-shop", "/sites/demo-blog", "/status", "/settings"];
const order = ["minor", "moderate", "serious", "critical"];
const floor = order.indexOf(process.env.PULSE_AXE_IMPACT ?? "serious");
const axe = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
const browser = await chromium.launch();
let failures = 0;
for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", bypassCSP: true });
    const page = await ctx.newPage();
    await page.goto(`${origin}/__dev/login`);
    for (const p of paths) {
      await page.goto(origin + p);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(300);
      await page.addScriptTag({ content: axe });
      const res = await page.evaluate(async () => {
        // @ts-expect-error axe is injected above
        const r = await window.axe.run(document, { resultTypes: ["violations"] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`.trim()) }));
      });
      const bad = res.filter((v) => order.indexOf(v.impact) >= floor);
      failures += bad.length;
      for (const v of res) console.log(`${width} ${scheme} ${p}: [${v.impact}] ${v.id} — ${v.help}\n    ${v.nodes.join("\n    ")}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(failures ? `${failures} violation(s) at "${order[floor]}" or worse` : `no violations at "${order[floor]}" or worse`);
process.exitCode = failures ? 1 : 0;

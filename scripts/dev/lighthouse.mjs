// Lighthouse judge for dashboard pages on the local dev server (signed in as the dev owner), with Playwright's Chromium.
//   node --import ./scripts/dev/register.mjs scripts/dev/lighthouse.mjs [path] [--desktop]
// Prints performance, accessibility and best-practices scores plus LCP, CLS and TBT. Needs `npm run dev:api`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const desktop = args.includes("--desktop");
const path = args.find((a) => !a.startsWith("--")) ?? "/";
const origin = process.env.PULSE_DEV_ORIGIN ?? "http://localhost:8787";
process.env.PULSE_DEV_DB ??= ".data/dev.sqlite";
const { devEnv } = await import("./env.ts");
const { createSession } = await import("../../src/worker/auth/session.ts");
const { db } = devEnv();
const owner = await db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").first();
const { token } = await createSession(db, owner.id, { label: "lighthouse" });
writeFileSync(".data/lh-headers.json", JSON.stringify({ Cookie: `__Host-pulse_session=${token}` }));
const out = `.data/qa/lh${path.replace(/[/?=&]/g, "_")}${desktop ? "-desktop" : ""}.json`;
execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["-y", "lighthouse@12.6.0", origin + path, "--quiet", "--chrome-flags=--headless=new", "--only-categories=performance,accessibility,best-practices", "--extra-headers=.data/lh-headers.json", "--output=json", `--output-path=${out}`, ...(desktop ? ["--preset=desktop"] : [])],
  { stdio: "inherit", env: { ...process.env, CHROME_PATH: chromium.executablePath() }, shell: process.platform === "win32" },
);
const r = JSON.parse(readFileSync(out, "utf8"));
const s = Object.fromEntries(Object.entries(r.categories).map(([k, v]) => [k, Math.round(v.score * 100)]));
console.log(`${path} (${desktop ? "desktop" : "mobile, simulated 4G"}): performance ${s.performance}, accessibility ${s.accessibility}, best practices ${s["best-practices"]}; LCP ${r.audits["largest-contentful-paint"].displayValue}, CLS ${r.audits["cumulative-layout-shift"].displayValue}, TBT ${r.audits["total-blocking-time"].displayValue}`);

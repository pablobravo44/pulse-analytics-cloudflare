import { defineConfig, devices } from "@playwright/test";

// PULSE_E2E_ORIGIN defaults to a local `wrangler dev` (http://localhost:8787). Pointing it at your deployment
// creates and revokes one API key and saves one funnel there; that session cookie comes from
// `npm run admin -- session --label e2e`.
export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  retries: 1,
  reporter: [["list"]],
  outputDir: ".data/qa/results",
  use: {
    baseURL: process.env.PULSE_E2E_ORIGIN ?? "http://localhost:8787",
    headless: true,
    screenshot: "only-on-failure",
    // Pulse drops automated browsers as bots; the tracker check needs a hit that looks like a person
    // (devices[...] carries a normal Chrome user agent; the flag below clears navigator.webdriver).
    launchOptions: { args: ["--disable-blink-features=AutomationControlled"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

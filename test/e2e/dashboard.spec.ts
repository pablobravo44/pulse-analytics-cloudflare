import { expect, test, type BrowserContext } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

const ORIGIN = process.env.PULSE_E2E_ORIGIN ?? "http://localhost:8787";
const ENV = new URL(ORIGIN).hostname === "localhost" ? "local" : "production";
const SITE = process.env.PULSE_E2E_SITE ?? "pulse-smoke";
const SESSION_FILE = `.data/session-${ENV}-${process.env.PULSE_E2E_LABEL ?? "e2e"}.txt`;
const token = existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, "utf8").trim() : "";

async function signIn(ctx: BrowserContext) {
  const url = new URL(ORIGIN);
  await ctx.addCookies([{ name: "__Host-pulse_session", value: token, domain: url.hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
}

const PAGES = ["", "/realtime", "/goals", "/funnels", "/paths", "/retention", "/vitals", "/errors", "/annotations", "/settings"];
const GLOBAL = ["/", "/add-site", "/status", "/settings/keys", "/settings/people", "/settings/ops", "/settings/sites", "/settings/audit", "/settings/system"];

test.describe("dashboard", () => {
  test.beforeEach(async ({ context }) => signIn(context));

  for (const width of [360, 1440]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`all pages render at ${width}px ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => m.type() === "error" && !m.text().includes("favicon") && errors.push(m.text()));
        for (const p of [...GLOBAL, ...PAGES.map((x) => `/sites/${SITE}${x}`)]) {
          await page.goto(p);
          await expect(page.locator("main")).toBeVisible();
          await page.waitForLoadState("networkidle");
          await expect(page.locator('[role="alert"]')).toHaveCount(0);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `horizontal overflow on ${p}`).toBeLessThanOrEqual(1);
          await page.screenshot({ path: `.data/qa/${ENV}-${width}-${scheme}${p.replace(/\//g, "_") || "_root"}.png`, fullPage: true });
        }
        expect(errors).toEqual([]);
      });
    }
  }

  // The site view in both widths and themes; a site with a few visits a day draws bars.
  for (const width of [360, 1440]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`site view at ${width}px ${scheme}: KPIs, chart, panels; low traffic as bars`, async ({ page }) => {
        test.skip(ENV !== "local", "demo sites exist on the local dev server only");
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto("/sites/demo-shop");
        await expect(page.getByRole("radio", { name: /Visitors/ })).toBeVisible();
        await expect(page.locator("[data-chart-mode]")).toHaveAttribute("data-chart-mode", "line");
        await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();
        await page.goto("/sites/demo-quiet");
        await expect(page.locator("[data-chart-mode]")).toHaveAttribute("data-chart-mode", "bars");
        if (width < 1024) await expect(page.getByRole("navigation", { name: "Site sections" })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
      });
    }
  }

  test("create and revoke an API key", async ({ page }) => {
    await page.goto("/settings/keys");
    const name = `e2e-${Date.now()}`;
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click();
    await expect(page.getByRole("dialog").locator("code").first()).toContainText("pulse_sk_");
    await page.getByRole("button", { name: "I've copied it" }).click();
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: "Revoke key" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke key" }).click();
    await expect(page.getByText("Key revoked")).toBeVisible();
  });

  test("funnel builder saves and analyzes", async ({ page }) => {
    await page.goto(`/sites/${SITE}/funnels`);
    await page.getByRole("button", { name: "New funnel" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Name").fill(`e2e funnel ${Date.now()}`);
    await sheet.getByLabel("Step 1 value").fill("/");
    await sheet.getByLabel("Step 2 type").selectOption("pageview");
    await sheet.getByLabel("Step 2 value").fill("/*");
    await sheet.getByLabel("Step order").selectOption("strict");
    await sheet.getByRole("button", { name: "Save funnel" }).click();
    await expect(page.getByText("Funnel saved")).toBeVisible();
    await expect(page.locator("ol li").first()).toBeVisible();
  });
});

test("tracker: a fixture page visit reaches the API within 10 s", async ({ page, request }) => {
  test.skip(ENV !== "local", "fixture exists on a local wrangler dev only");
  const key = process.env.PULSE_E2E_KEY;
  test.skip(!key, "PULSE_E2E_KEY (stats:read on pulse-smoke) missing");
  const before = await request.get(`/api/v1/sites/pulse-smoke/realtime`, { headers: { Authorization: `Bearer ${key}` } });
  const pv0 = ((await before.json()) as { hits_per_minute: { hits: number }[] }).hits_per_minute.reduce((a, x) => a + x.hits, 0);
  await page.goto("/__e2e/fixture");
  await page.waitForTimeout(500);
  const t0 = Date.now();
  let pv = pv0;
  while (Date.now() - t0 < 10_000 && pv <= pv0) {
    await page.waitForTimeout(1000);
    const r = await request.get(`/api/v1/sites/pulse-smoke/realtime`, { headers: { Authorization: `Bearer ${key}` } });
    pv = ((await r.json()) as { hits_per_minute: { hits: number }[] }).hits_per_minute.reduce((a, x) => a + x.hits, 0);
  }
  expect(pv).toBeGreaterThan(pv0);
});

// Motion answers actions, and with reduced motion nothing moves; no layout shift while data arrives.
test.describe("motion", () => {
  test.skip(ENV !== "local", "demo sites exist on the local dev server only");
  test.beforeEach(async ({ context }) => signIn(context));

  test("with prefers-reduced-motion nothing animates after changing the range, the metric and the tab", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/sites/demo-shop");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "7d", exact: true }).click();
    await page.getByRole("radio", { name: /Pageviews/ }).click();
    await page.getByRole("tab", { name: "Channels" }).click();
    await page.waitForLoadState("networkidle");
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => (a as CSSAnimation).animationName ?? a.constructor.name));
    expect(running).toEqual([]);
  });

  test("the site view doesn't shift its layout while it loads (CLS 0)", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto("/sites/demo-shop");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.01);
  });
});

test.describe("sidebar, quick ranges and chart notes", () => {
  test.skip(ENV !== "local", "demo sites exist on the local dev server only");
  test.beforeEach(async ({ context }) => signIn(context));

  test("the sidebar folds to icons and stays folded after a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/sites/demo-shop");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.keyboard.press("[");
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  test("yesterday is one click away", async ({ page }) => {
    await page.goto("/sites/demo-shop");
    await page.getByRole("group", { name: "Date range" }).getByRole("button", { name: "Yesterday" }).click();
    await expect(page).toHaveURL(/range=yesterday/);
  });

  test("switching page tabs never shows another tab's rows", async ({ page }) => {
    await page.goto("/sites/demo-shop");
    await page.waitForLoadState("networkidle");
    for (const tab of ["Entry", "Exit", "Top"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(page.getByRole("region", { name: "Pages" }).getByText("(none)")).toHaveCount(0);
    }
  });
});

test.describe("insights, page drawer and site settings", () => {
  test.skip(ENV !== "local", "demo sites exist on the local dev server only");
  test.beforeEach(async ({ context }) => signIn(context));

  test("home cards say what changed yesterday", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/^Yesterday \d/).first()).toBeVisible();
  });

  test("a page opens its report in a drawer and can still filter", async ({ page }) => {
    await page.goto("/sites/demo-shop");
    await page.getByRole("button", { name: "/cart", exact: false }).first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("/cart").first()).toBeVisible();
    await drawer.getByRole("button", { name: "Filter by this page" }).click();
    await expect(page).toHaveURL(/f=/);
  });

  test("site settings show filtered traffic and build a campaign link", async ({ page }) => {
    await page.goto("/sites/demo-shop/settings");
    await expect(page.getByText(/% of hits in the last 30 days were filtered out/)).toBeVisible();
    await page.getByLabel("Source (required)").fill("newsletter");
    await page.getByLabel("Campaign (required)").fill("spring sale");
    await expect(page.getByText(/utm_source=newsletter&utm_campaign=spring%20sale/)).toBeVisible();
  });
});

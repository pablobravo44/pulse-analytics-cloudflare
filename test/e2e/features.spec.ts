// Market-audit features in the dashboard: saved views, alerts from the overview, share links, scheduled reports,
// notification channels and the funnel builder. Local only (the dev server, see manage.spec.ts); it creates data.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const ORIGIN = process.env.PULSE_E2E_ORIGIN ?? "http://localhost:8787";
const LOCAL = new URL(ORIGIN).hostname === "localhost";
const token = existsSync(".data/session-local-e2e.txt") ? readFileSync(".data/session-local-e2e.txt", "utf8").trim() : "";
const SITE = "demo-shop";
const SHOTS = ".data/qa/flows";

async function signIn(ctx: BrowserContext) {
  await ctx.addCookies([{ name: "__Host-pulse_session", value: token, domain: new URL(ORIGIN).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });

test.describe("features", () => {
  test.skip(!LOCAL || !token, "local dev server only");
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
  test.beforeEach(async ({ context, page }) => {
    await signIn(context);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("save a filtered view, then alert on it from the overview", async ({ page }) => {
    const stamp = Date.now();
    const name = `Mobile ${stamp}`;
    // A filter no earlier run saved, so "Save as view" is offered (it hides when a view already matches).
    const filters = [["is", "device", ["mobile"]], ["not_contains", "page", [`/e2e-${stamp}`]]];
    await page.goto(`${ORIGIN}/sites/${SITE}?f=${encodeURIComponent(JSON.stringify(filters))}`);
    await page.getByRole("button", { name: "Save as view" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Name").press("Enter");
    await expect(page.getByText("View saved")).toBeVisible();
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();

    await page.getByRole("link", { name: /Alert me when/ }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(/Only visits where Device is mobile/)).toBeVisible();
    await sheet.getByLabel("Name").fill(`Mobile drop ${Date.now()}`);
    await shot(page, "alert-from-view");
    await sheet.getByRole("button", { name: "Add alert" }).click();
    await expect(page.getByText("Alert saved")).toBeVisible();

    // Leave the dev data as it was: the saved view and the alert are this run's only.
    const h = { "X-Pulse-Client": "dashboard", Origin: ORIGIN };
    const views = (await (await page.request.get(`${ORIGIN}/api/v1/sites/${SITE}/views`, { headers: h })).json()) as { data: { id: string; name: string }[] };
    for (const v of views.data.filter((x) => x.name === name)) await page.request.delete(`${ORIGIN}/api/v1/sites/${SITE}/views/${v.id}`, { headers: h });
    const alerts = (await (await page.request.get(`${ORIGIN}/api/v1/sites/${SITE}/alerts`, { headers: h })).json()) as { data: { id: string; name: string }[] };
    for (const a of alerts.data.filter((x) => /^Mobile drop \d+$/.test(x.name))) await page.request.delete(`${ORIGIN}/api/v1/sites/${SITE}/alerts/${a.id}`, { headers: h });
  });

  test("custom comparison and a wildcard filter", async ({ page }) => {
    await page.goto(`${ORIGIN}/sites/${SITE}`);
    await page.getByRole("button", { name: "Compare with" }).click();
    await page.getByLabel("Compare from").fill("2026-08-01");
    await page.getByLabel("Compare to").fill("2026-08-28");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.getByRole("button", { name: "Compare with" })).toContainText("2026");
    await page.getByRole("button", { name: "Filter" }).click();
    await page.getByLabel("Operator").selectOption("matches");
    await page.getByLabel("Value").fill("/products*");
    await page.getByRole("button", { name: "Add filter" }).click();
    await expect(page.getByText("/products*")).toBeVisible();
    await shot(page, "compare-custom");
  });

  test("a share link opens read-only without signing in", async ({ page, browser }) => {
    await page.goto(`${ORIGIN}/sites/${SITE}/settings`);
    await page.getByRole("button", { name: "Create link" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Name").fill(`e2e share ${Date.now()}`);
    await sheet.getByRole("button", { name: "Create link" }).click();
    const url = await sheet.locator("code").first().innerText();
    expect(url).toContain("/share/");
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const viewer = await anon.newPage();
    await viewer.goto(url);
    await expect(viewer.getByText("Visitors").first()).toBeVisible();
    await expect(viewer.getByRole("link", { name: /Alert me when/ })).toHaveCount(0);
    await viewer.screenshot({ path: `${SHOTS}/share-viewer.png` });
    await anon.close();
  });

  test("create, preview and delete a scheduled report", async ({ page }) => {
    const name = `e2e report ${Date.now()}`;
    await page.goto(`${ORIGIN}/settings/reports`);
    await page.getByRole("button", { name: "New report" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Name").fill(name);
    await sheet.getByRole("combobox", { name: /^Every/ }).selectOption("monthly");
    await sheet.getByRole("button", { name: "Create report" }).click();
    await expect(page.getByText("Report saved")).toBeVisible();
    const row = page.locator("li", { hasText: name });
    await row.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("dialog").locator("iframe")).toBeVisible();
    await shot(page, "report-preview");
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: "Delete report" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete report" }).click();
    await expect(page.getByText("Report deleted")).toBeVisible();
  });

  test("add and delete a notification channel", async ({ page }) => {
    const name = `e2e ntfy ${Date.now()}`;
    await page.goto(`${ORIGIN}/settings/notifications`);
    await page.getByRole("button", { name: "Add channel" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Kind").selectOption("ntfy");
    await sheet.getByLabel("Name").fill(name);
    await sheet.getByLabel("Topic URL").fill("https://ntfy.sh/pulse-e2e-not-a-real-topic");
    await sheet.getByRole("button", { name: "Add channel" }).click();
    await expect(page.getByText("Channel added")).toBeVisible();
    const row = page.locator("li", { hasText: name });
    await expect(row).toContainText("ntfy.sh");
    await expect(row).not.toContainText("not-a-real-topic");
    await row.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete channel" }).click();
    await expect(page.getByText("Channel deleted")).toBeVisible();
  });
});

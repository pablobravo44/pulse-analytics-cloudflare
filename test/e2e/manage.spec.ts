// Owner workflows in the dashboard: API keys, adding a site, status checks, site settings.
// Local only (the dev server: `npm run dev:seed && npm run build && npm run dev:api`); it creates and deletes data.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const ORIGIN = process.env.PULSE_E2E_ORIGIN ?? "http://localhost:8787";
const LOCAL = new URL(ORIGIN).hostname === "localhost";
const token = existsSync(".data/session-local-e2e.txt") ? readFileSync(".data/session-local-e2e.txt", "utf8").trim() : "";
const SHOTS = ".data/qa/flows";

async function signIn(ctx: BrowserContext) {
  await ctx.addCookies([{ name: "__Host-pulse_session", value: token, domain: new URL(ORIGIN).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });

test.describe("owner workflows", () => {
  test.skip(!LOCAL || !token, "local dev server only");
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
  test.beforeEach(async ({ context, page }) => {
    await signIn(context);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("create, edit, rotate and revoke an API key", async ({ page }) => {
    const name = `e2e-${Date.now()}`;
    await page.goto(`${ORIGIN}/settings/keys`);
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByLabel("Name").fill(name);
    await shot(page, "key-create");
    await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click();
    await expect(page.getByText("Copy the key now")).toBeVisible();
    await expect(page.getByRole("dialog").locator("code").first()).toContainText("pulse_sk_");
    await shot(page, "key-secret");
    await page.getByRole("button", { name: "I've copied it" }).click();

    await page.getByRole("button", { name: new RegExp(name) }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Name").fill(`${name}-renamed`);
    await sheet.getByText("sites:write").click();
        await shot(page, "key-edit");
    await sheet.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Key updated")).toBeVisible();
    const row = page.getByRole("button", { name: new RegExp(`${name}-renamed`) });
    await expect(row).toContainText("sites:write");

    await row.click();
    await page.getByRole("button", { name: "Rotate secret" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Rotate secret" }).click();
    await expect(page.getByText("Copy the key now")).toBeVisible();
    await page.getByRole("button", { name: "I've copied it" }).click();

    await page.getByRole("button", { name: new RegExp(`${name}-renamed`) }).click();
    await page.getByRole("button", { name: "Revoke key" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke key" }).click();
    await expect(page.getByText("Key revoked")).toBeVisible();
  });

  test("add a site and see the install check", async ({ page }) => {
    const domain = `e2e${Date.now()}.example.net`;
    await page.goto(`${ORIGIN}/add-site`);
    await page.getByRole("textbox", { name: "Domains" }).fill(`https://${domain}/`);
    await page.getByRole("textbox", { name: "Domains" }).press("Enter");
    await expect(page.getByText(domain, { exact: true })).toBeVisible();
    await shot(page, "site-add");
    await page.getByRole("button", { name: "Add site" }).click();
    await expect(page.getByText("Add it to the <head> of every page")).toBeVisible();
    await expect(page.locator("code").filter({ hasText: "data-site=" }).first()).toBeVisible();
    await expect(page.getByText(/No pageviews yet|Couldn't load|Waiting for the first pageview/).first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "site-added");

    await page.getByRole("link", { name: "Site settings" }).click();
    await page.getByText("Internal site").click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Site settings saved")).toBeVisible();
    await page.getByRole("button", { name: "Archive site" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive site" }).click();
    await expect(page.getByText("Site archived")).toBeVisible();
  });

  test("add, test, pause and delete a status check", async ({ page }) => {
    const name = `E2E check ${Date.now()}`;
    await page.goto(`${ORIGIN}/status`);
    await page.getByRole("button", { name: "Add check" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Name").fill(name);
    await sheet.getByRole("textbox", { name: "URL", exact: true }).fill(`${ORIGIN}/healthz`);
    await sheet.getByLabel("Must contain").fill("ok");
    await sheet.getByRole("button", { name: "Test" }).click();
    await expect(sheet.getByText("● Up")).toBeVisible();
    await shot(page, "check-form");
    await sheet.getByRole("button", { name: "Add check" }).click();
    await expect(page.getByText("Check added")).toBeVisible();

    await page.getByRole("button", { name: new RegExp(name) }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText("Checked: up")).toBeVisible();
    await drawer.getByRole("button", { name: "Pause 1 hour" }).click();
    await expect(page.getByText("Check paused")).toBeVisible();
    await shot(page, "check-detail");
    await drawer.getByRole("button", { name: "Delete check" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete check" }).click();
    await expect(page.getByText("Check deleted")).toBeVisible();
  });
});

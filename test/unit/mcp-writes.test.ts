// MCP write tools that used to be dashboard-only: people, share links, channels, data deletion, site purge, imports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../../src/worker/auth/apikeys.ts";
import { hit, insertSite, OTHER, SITE } from "./fixtures.ts";
import { makeEnv } from "./harness.ts";

let h: ReturnType<typeof makeEnv>;
let admin: string;
const SECRET = btoa("0123456789abcdef0123456789abcdef");

async function call(key: string, name: string, args: Record<string, unknown> = {}) {
  const r = await h.call("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  });
  const res = ((await r.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON for assertions
  return { error: !!res.isError, body: JSON.parse(res.content[0]!.text) as Record<string, any> };
}

beforeEach(async () => {
  h = makeEnv();
  await insertSite(h.db, SITE);
  await insertSite(h.db, OTHER);
  admin = (await createApiKey(h.db, { name: "admin", scopes: ["admin"], siteIds: null, createdBy: "test" })).key;
});
afterEach(() => vi.unstubAllGlobals());

describe("MCP writes", () => {
  it("add_user gives someone access", async () => {
    const r = await call(admin, "add_user", { email: "Ana@Example.com", site_ids: ["test"] });
    expect(r.body.user).toMatchObject({ email: "ana@example.com", role: "viewer", site_ids: ["test"] });
    expect((await call(admin, "add_user", { email: "ana@example.com" })).error).toBe(true);
  });

  it("create_share returns the URL once and the link works", async () => {
    const r = await call(admin, "create_share", { site: "test", name: "Client" });
    expect(r.body.share.url).toMatch(/\/share\/[A-Za-z0-9_-]+$/);
    const token = String(r.body.share.url).split("/share/")[1]!;
    const list = await call(admin, "list_shares", { site: "test" });
    expect(JSON.stringify(list.body)).not.toContain(token);
    const read = await h.call("/api/v1/sites/test/summary", { headers: { "X-Pulse-Share": token } });
    expect(read.status).toBe(200);
  });

  it("save_channel adds, edits and delete_channel removes, never echoing the URL", async () => {
    Object.assign(h.env, { PULSE_SECRET_KEY: SECRET });
    const url = "https://hooks.slack.com/services/T000/B000/secretpart";
    const added = await call(admin, "save_channel", { name: "Team", kind: "slack", config: { url } });
    expect(added.error).toBe(false);
    expect(JSON.stringify(added.body)).not.toContain("secretpart");
    const id = added.body.channel.id as string;
    expect((await call(admin, "save_channel", { id, enabled: false })).body.channel).toMatchObject({ enabled: false, name: "Team" });
    expect((await call(admin, "save_channel", { name: "No kind" })).error).toBe(true);
    expect((await call(admin, "delete_channel", { id })).body).toEqual({ deleted: true });
    expect((await call(admin, "list_channels")).body.channels.find((c: { id: string }) => c.id === id)).toBeUndefined();
  });

  it("delete_data needs the dry run's token", async () => {
    await hit(h.db, { u: "https://example.com/" }, Date.UTC(2026, 9, 14, 10));
    const sel = { site: "test", from: "2026-10-14", to: "2026-10-14" };
    expect((await call(admin, "delete_data", sel)).error).toBe(true);
    const dry = await call(admin, "delete_data", { ...sel, dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, events: 1 });
    expect((await call(admin, "delete_data", { ...sel, confirm_token: "nope" })).error).toBe(true);
    expect((await call(admin, "delete_data", { ...sel, confirm_token: dry.body.confirm_token })).body).toMatchObject({ events_deleted: 1 });
  });

  it("archive_site purges only with confirm, as admin", async () => {
    const writer = (await createApiKey(h.db, { name: "w", scopes: ["sites:write", "stats:read"], siteIds: null, createdBy: "test" })).key;
    expect((await call(writer, "archive_site", { site: "other", purge: true, confirm: "other" })).error).toBe(true);
    expect((await call(admin, "archive_site", { site: "other", purge: true })).body.error.code).toBe("confirm_required");
    expect((await call(admin, "archive_site", { site: "other", purge: true, confirm: "other" })).body.deleted).toBe(true);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM sites WHERE id = 'other'").get()).toEqual({ n: 0 });
  });

  it("list_sites can include archived sites (admin), and list_annotations returns categories", async () => {
    await call(admin, "archive_site", { site: "other" });
    expect((await call(admin, "list_sites")).body.sites.map((s: { id: string }) => s.id)).toEqual(["test"]);
    const all = (await call(admin, "list_sites", { include_archived: true })).body.sites;
    expect(all.find((s: { id: string }) => s.id === "other")).toMatchObject({ archived: true });
    await call(admin, "add_annotation", { site: "test", title: "Launch", category: "campaign" });
    expect((await call(admin, "list_annotations", { site: "test" })).body.annotations[0]).toMatchObject({ title: "Launch", category: "campaign", affects: [] });
  });

  it("list_imports shows the import history", async () => {
    expect((await call(admin, "list_imports")).body).toEqual({ imports: [] });
  });
});

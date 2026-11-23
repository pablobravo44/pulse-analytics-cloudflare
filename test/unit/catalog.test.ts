// Rule 9 (AGENTS.md): every capability is in the catalog, reachable over REST and MCP (or has a written reason
// why not), documented, and scope-checked. These tests fail when a new route or tool skips any of that.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "../../src/worker/auth/apikeys.ts";
import { SCOPES } from "../../src/worker/auth/principal.ts";
import { CAPABILITIES } from "../../src/worker/catalog.ts";
import { TOPICS } from "../../src/worker/guide.ts";
import { METRICS } from "../../src/worker/query/schema.ts";
import { insertSite, OTHER, SITE } from "./fixtures.ts";
import { makeEnv } from "./harness.ts";

let h: ReturnType<typeof makeEnv>;
let admin: string;
let reader: string;

beforeEach(async () => {
  h = makeEnv();
  await insertSite(h.db, SITE);
  await insertSite(h.db, OTHER);
  admin = (await createApiKey(h.db, { name: "admin", scopes: ["admin"], siteIds: null, createdBy: "test" })).key;
  reader = (await createApiKey(h.db, { name: "reader", scopes: ["stats:read"], siteIds: null, createdBy: "test" })).key;
});

async function openapiOps() {
  const doc = (await (await h.call("/api/v1/openapi.json")).json()) as { paths: Record<string, Record<string, { "x-required-scope": string | null }>> };
  return Object.entries(doc.paths).flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ op: `${method.toUpperCase()} ${path}`, scope: op["x-required-scope"] })));
}

async function tools(key: string): Promise<string[]> {
  const r = await h.call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });
  return ((await r.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
}

async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
  const r = await h.call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });
  return ((await r.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
}

describe("capability catalog", () => {
  it("every REST operation is in exactly one capability, with the same scope", async () => {
    const ops = await openapiOps();
    const catalogued = CAPABILITIES.flatMap((c) => c.rest.map((op) => ({ op, scope: c.scope, id: c.id })));
    for (const { op, scope } of ops) {
      const hits = catalogued.filter((x) => x.op === op);
      expect(hits, `${op} is not in src/worker/catalog.ts`).toHaveLength(1);
      expect(hits[0]!.scope, `${op}: catalog scope differs from the route's`).toBe(scope ?? null);
    }
    for (const { op, id } of catalogued) expect(ops.some((o) => o.op === op), `${id} lists ${op}, which doesn't exist`).toBe(true);
  });

  it("every capability has an MCP tool or a written reason", () => {
    for (const c of CAPABILITIES) expect(!!c.mcp !== !!c.mcpExclusion, `${c.id}: set exactly one of mcp / mcpExclusion`).toBe(true);
    const names = CAPABILITIES.filter((c) => c.mcp).map((c) => c.mcp);
    expect(new Set(names).size).toBe(names.length);
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("an admin key sees every catalogued tool, and nothing else", async () => {
    const listed = await tools(admin);
    expect(listed.sort()).toEqual(CAPABILITIES.filter((c) => c.mcp).map((c) => c.mcp!).sort());
  });

  it("a read-only key sees only what its scope allows, and whoami explains the rest", async () => {
    const listed = await tools(reader);
    const allowed = CAPABILITIES.filter((c) => c.mcp && (c.scope === null || c.scope === "stats:read")).map((c) => c.mcp!);
    expect(listed.sort()).toEqual(allowed.sort());
    const who = JSON.parse((await callTool(reader, "whoami")).content[0]!.text) as { locked: { needs_scope: string }[]; missing_scopes: { scope: string }[]; how_to_get_more: string };
    expect(who.locked.length).toBeGreaterThan(0);
    expect(who.missing_scopes.map((m) => m.scope)).toEqual(SCOPES.filter((s) => s !== "stats:read"));
    expect(who.how_to_get_more).toContain("API keys");
  });

  it("every route rejects a key without its scope before doing anything", async () => {
    const minimal = (await createApiKey(h.db, { name: "m", scopes: ["events:export"], siteIds: null, createdBy: "test" })).key;
    for (const { op, scope } of await openapiOps()) {
      if (scope === null || scope === "events:export") continue;
      const [method, path] = op.split(" ") as [string, string];
      const url = "/api/v1" + path.replace("{site}", "test").replace("{dimension}", "page").replace("{id}", "x");
      const r = await h.call(url, { method, headers: { Authorization: `Bearer ${minimal}`, "Content-Type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
      expect(r.status, `${op} answered ${r.status} to a key without ${scope}`).toBe(403);
    }
  });

  it("every site route refuses a key for another site", async () => {
    const elsewhere = (await createApiKey(h.db, { name: "other-only", scopes: ["admin"], siteIds: ["other"], createdBy: "test" })).key;
    for (const { op } of await openapiOps()) {
      if (!op.includes("{site}")) continue;
      const [method, path] = op.split(" ") as [string, string];
      const url = "/api/v1" + path.replace("{site}", "test").replace("{dimension}", "page").replace("{id}", "x");
      const r = await h.call(url, { method, headers: { Authorization: `Bearer ${elsewhere}`, "Content-Type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
      expect([403, 404], `${op} answered ${r.status} to a key for another site`).toContain(r.status);
    }
  });

  it("MCP initialize instructions distinguish read-only keys from write keys", async () => {
    const init = async (key: string) => {
      const r = await h.call("/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      });
      return ((await r.json()) as { result: { instructions?: string } }).result.instructions ?? "";
    };
    const readInst = await init(reader);
    expect(readInst).toContain("This key is read-only.");
    expect(readInst).not.toContain("You can change things with:");
    const adminInst = await init(admin);
    expect(adminInst).toContain("You can change things with:");
    expect(adminInst).toContain("save_site");
    expect(adminInst).not.toMatch(/You can change things with:[^.]*\b(sites_summary|live|ingest_drops|what_changed|insights|sessions|list_keys)\b/);
  });

  it("help covers every topic, every metric has a definition, and docs mention every tool and REST path", async () => {
    for (const topic of TOPICS) {
      const r = await callTool(reader, "help", { topic });
      expect(r.isError, topic).toBeFalsy();
      expect(r.content[0]!.text.length, topic).toBeGreaterThan(100);
    }
    const metricsDoc = (await callTool(reader, "help", { topic: "metrics" })).content[0]!.text;
    for (const m of METRICS) expect(metricsDoc, `missing metric description for ${m}`).toMatch(new RegExp(`\\| ${m} \\| \\S+`));
    const mcpDoc = readFileSync("docs/MCP.md", "utf8");
    for (const c of CAPABILITIES.filter((x) => x.mcp)) expect(mcpDoc, `docs/MCP.md doesn't mention ${c.mcp}`).toContain(`\`${c.mcp}\``);
    const apiDoc = readFileSync("docs/API.md", "utf8");
    for (const op of CAPABILITIES.flatMap((c) => c.rest)) {
      const path = op.split(" ")[1]!;
      expect(apiDoc, `docs/API.md doesn't mention ${path}`).toContain(path === "/" ? "GET /api/v1/" : path);
    }
  });

  it("serves the discovery documents", async () => {
    const llms = await h.call("/llms.txt");
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain("/mcp");
    expect((await h.call("/docs/agents")).status).toBe(200);
    expect((await h.call("/docs")).status).toBe(200);
    for (const path of ["/api/v1", "/api/v1/"]) {
      const r = await h.call(path, { headers: { Authorization: `Bearer ${reader}` } });
      expect(r.status, path).toBe(200);
      const j = (await r.json()) as { can: { id: string }[]; locked: { id: string }[]; docs: { agent_guide: string } };
      expect(j.can.some((c) => c.id === "stats.query")).toBe(true);
      expect(j.locked.some((c) => c.id === "sites.save")).toBe(true);
    }
  });
});

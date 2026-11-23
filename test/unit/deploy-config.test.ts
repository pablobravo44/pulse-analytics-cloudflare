// scripts/deploy-config.mjs: the public wrangler.jsonc carries no deployment's values; they come from PULSE_*.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript module
import { parseJsonc, render, varsFromBindings } from "../../scripts/deploy-config.mjs";

const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));

describe("deploy config", () => {
  it("wrangler.jsonc holds top-level 1-click deploy bindings and env.production placeholders", () => {
    const text = readFileSync("wrangler.jsonc", "utf8");
    expect(text).not.toMatch(/account_id|@[a-z0-9-]+\.[a-z]{2,}"|cloudflareaccess\.com"/);
    expect(config.workers_dev).toBe(true);
    expect(config.d1_databases[0].binding).toBe("DB");
    expect(config.d1_databases[0].database_id).toBeUndefined();
    expect(config.kv_namespaces[0].id).toBeUndefined();
    expect(config.env.production.d1_databases[0].database_id).toBe("${PULSE_D1_ID}");
  });

  it("fills the placeholders and drops the optional pieces that aren't set", () => {
    const out = render(config, { PULSE_DOMAIN: "pulse.example.com", PULSE_D1_ID: "d1", PULSE_KV_ID: "kv", PULSE_JURISDICTION: "none" });
    const p = out.env.production;
    expect(p.vars).toEqual({ ENVIRONMENT: "production", PUBLIC_ORIGIN: "https://pulse.example.com", RP_ID: "pulse.example.com" });
    expect(p.routes).toEqual([{ pattern: "pulse.example.com", custom_domain: true }]);
    expect(p.send_email[0]).toEqual({ name: "SEND_EMAIL" });
    expect(p.r2_buckets.every((b: { jurisdiction?: string }) => b.jurisdiction === undefined)).toBe(true);
    expect(out.account_id).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("${");
  });

  it("keeps sign-in, alert addresses and the account when given, and names what's missing", () => {
    const out = render(config, { PULSE_DOMAIN: "a.example.com", PULSE_D1_ID: "d", PULSE_KV_ID: "k", PULSE_ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", PULSE_ACCESS_AUD: "aud", PULSE_ALERT_FROM: "alerts@example.com", PULSE_ALERT_TO: "me@example.com", PULSE_ACCOUNT_ID: "acc", PULSE_OPS_BACKUPS: "false" });
    expect(out.env.production.vars).toMatchObject({ ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud", ALERT_FROM: "alerts@example.com", CF_ACCOUNT_ID: "acc" });
    expect(out.env.production.send_email[0].destination_address).toBe("me@example.com");
    expect(out.env.production.r2_buckets.map((b: { binding: string }) => b.binding)).toEqual(["BACKUPS"]);
    expect(out.account_id).toBe("acc");
    expect(() => render(config, { PULSE_DOMAIN: "x.example.com" })).toThrow(/PULSE_D1_ID, PULSE_KV_ID/);
  });

  it("reads a deployed Worker's bindings back into the same variables, so updates need no values", () => {
    const vars = varsFromBindings([
      { name: "RP_ID", type: "plain_text", text: "pulse.example.com" },
      { name: "PUBLIC_ORIGIN", type: "plain_text", text: "https://pulse.example.com" },
      { name: "DB", type: "d1", database_id: "d1-id" },
      { name: "OAUTH_KV", type: "kv_namespace", namespace_id: "kv-id" },
      { name: "ACCESS_AUD", type: "plain_text", text: "aud" },
      { name: "ACCESS_TEAM_DOMAIN", type: "plain_text", text: "t.cloudflareaccess.com" },
      { name: "SEND_EMAIL", type: "send_email", destination_address: "me@example.com" },
      { name: "BACKUPS", type: "r2_bucket", bucket_name: "pulse-backups" },
      { name: "ACCESS_EMAILS", type: "secret_text" },
    ]);
    expect(vars).toEqual({ PULSE_DOMAIN: "pulse.example.com", PULSE_D1_ID: "d1-id", PULSE_KV_ID: "kv-id", PULSE_ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", PULSE_ACCESS_AUD: "aud", PULSE_ALERT_TO: "me@example.com", PULSE_JURISDICTION: "none", PULSE_OPS_BACKUPS: "false" });
    const p = render(config, vars).env.production;
    expect(p.r2_buckets).toEqual([{ binding: "BACKUPS", bucket_name: "pulse-backups" }]);
    expect(p.d1_databases[0].database_id).toBe("d1-id");
  });
});

// Pulse admin CLI (production D1). Usage: npm run admin -- <command> [--flags] [--env production]
// Secrets (API keys, session cookies) are written to .data/, never printed.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SCOPES } from "../src/worker/auth/principal.ts";
import { randomToken, sha256Hex } from "../src/worker/lib/crypto.ts";
import { ulid } from "../src/worker/lib/ids.ts";
import { normalizeDomain } from "../src/worker/lib/sites.ts";
import { d1, ORIGIN, sql, type EnvName } from "./lib/d1.ts";

const [cmd, ...rest] = process.argv.slice(2);
const args: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[++i]! : "true";
    args[k] = v;
  }
}
const env = (args.env ?? "production") as EnvName;
if (env !== "production") throw new Error("--env production (the only environment)");
mkdirSync(".data", { recursive: true });

function need(k: string): string {
  const v = args[k];
  if (!v) throw new Error(`--${k} is required`);
  return v;
}

function parseTtl(s: string): number {
  const m = /^(\d+)([mhd])$/.exec(s);
  if (!m) throw new Error("ttl like 30m, 1h, 7d");
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

function upsertEnvFile(file: string, name: string, value: string) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith(`${name}=`)) : [];
  lines.push(`${name}=${value}`);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
}

async function main() {
  switch (cmd) {
    case "site:create": {
      const id = need("id");
      const features = { outbound: true, downloads: true, engagement: true, vitals: true, errors: args.errors === "true" };
      const raw = need("domains").split(",").map((d) => d.trim()).filter(Boolean);
      const domains: string[] = [];
      for (const d of raw) {
        const norm = normalizeDomain(d);
        if (!norm) throw new Error(`invalid domain: ${d}`);
        if (!domains.includes(norm)) domains.push(norm);
      }
      if (!domains.length) throw new Error("at least one valid domain is required");
      d1(env, sql`INSERT INTO sites (id, name, domains_json, timezone, settings_json, retention_months, created_at)
        VALUES (${id}, ${args.name ?? domains[0]}, ${JSON.stringify(domains)}, ${args.tz ?? "UTC"},
                ${JSON.stringify({ features, respect_dnt: false })}, ${Number(args.retention ?? 25)}, ${Date.now()})
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, domains_json = excluded.domains_json, timezone = excluded.timezone`);
      d1(env, sql`INSERT INTO audit_log (id, ts, actor, action, target) VALUES (${ulid()}, ${Date.now()}, 'cli', 'site.create', ${id})`);
      console.log(`site ${id} ready on ${env}`);
      console.log(`snippet: <script defer src="${ORIGIN[env]}/p.js" data-site="${id}"></script>`);
      break;
    }
    case "site:domains": {
      const raw = need("domains").split(",").map((d) => d.trim()).filter(Boolean);
      const domains: string[] = [];
      for (const d of raw) {
        const norm = normalizeDomain(d);
        if (!norm) throw new Error(`invalid domain: ${d}`);
        if (!domains.includes(norm)) domains.push(norm);
      }
      if (!domains.length) throw new Error("at least one valid domain is required");
      d1(env, sql`UPDATE sites SET domains_json = ${JSON.stringify(domains)} WHERE id = ${need("id")}`);
      console.log(`site ${args.id} domains = ${domains.join(", ")}`);
      break;
    }
    case "goal:create": {
      // --match '{"kind":"event","event":"start_free"}'
      const m = JSON.parse(need("match")) as { kind: string } & Record<string, unknown>;
      const { kind, ...def } = m;
      d1(env, sql`INSERT INTO goals (id, site_id, name, kind, definition_json, created_at) VALUES (${ulid()}, ${need("site")}, ${need("name")}, ${kind}, ${JSON.stringify(def)}, ${Date.now()})`);
      console.log(`goal "${args.name}" created on ${args.site}`);
      break;
    }
    case "funnel:create": {
      const steps = JSON.parse(need("steps"));
      d1(env, sql`INSERT INTO funnels (id, site_id, name, steps_json, window_minutes, created_at) VALUES (${ulid()}, ${need("site")}, ${need("name")}, ${JSON.stringify(steps)}, ${Number(args.window ?? 30)}, ${Date.now()})`);
      console.log(`funnel "${args.name}" created on ${args.site}`);
      break;
    }
    case "session": {
      // Test sessions for e2e/agents. Creates a dedicated test user if needed.
      const label = args.label ?? "e2e";
      const email = `agent-${label}@pulse.invalid`;
      const ttl = parseTtl(args.ttl ?? "1h");
      const token = randomToken(32);
      const uid = `test_${label}`;
      d1(env, [
        sql`INSERT INTO users (id, email, name, role, created_at) VALUES (${uid}, ${email}, ${"Agent " + label}, ${args.role ?? "owner"}, ${Date.now()}) ON CONFLICT (id) DO UPDATE SET disabled_at = NULL`,
        sql`INSERT INTO auth_sessions (id_hash, user_id, expires_at, created_at, ua_summary, label) VALUES (${await sha256Hex(token)}, ${uid}, ${Date.now() + ttl}, ${Date.now()}, 'cli', ${label})`,
      ]);
      const file = `.data/session-${env}-${label}.txt`;
      writeFileSync(file, token + "\n", { mode: 0o600 });
      console.log(`session "${label}" (${args.ttl ?? "1h"}) cookie value written to ${file}`);
      break;
    }
    case "session:delete": {
      const label = args.label ?? "e2e";
      d1(env, [sql`DELETE FROM auth_sessions WHERE label = ${label}`, sql`DELETE FROM users WHERE id = ${"test_" + label}`]);
      console.log(`sessions labelled "${label}" deleted on ${env}`);
      break;
    }
    case "key:create": {
      const name = need("name");
      const scopes = [...new Set(need("scopes").split(",").map((s) => s.trim()).filter(Boolean))];
      const badScopes = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
      if (!scopes.length || badScopes.length) throw new Error(`invalid scope(s): ${badScopes.join(", ") || "(none)"}; valid: ${SCOPES.join(", ")}`);
      const sites = args.sites && args.sites !== "all" ? args.sites.split(",").map((s) => s.trim()).filter(Boolean) : null;
      const expires = args["expires-days"] ? Date.now() + Number(args["expires-days"]) * 86_400_000 : args["expires-hours"] ? Date.now() + Number(args["expires-hours"]) * 3_600_000 : null;
      const key = "pulse_sk_" + randomToken(32);
      const id = ulid();
      d1(env, [
        sql`INSERT INTO api_keys (id, prefix, hash, name, scopes_json, site_ids_json, created_by, created_at, expires_at)
            VALUES (${id}, ${key.slice(9, 17)}, ${await sha256Hex(key)}, ${name}, ${JSON.stringify(scopes)}, ${sites ? JSON.stringify(sites) : null}, 'cli', ${Date.now()}, ${expires})`,
        sql`INSERT INTO audit_log (id, ts, actor, action, target, meta_json) VALUES (${ulid()}, ${Date.now()}, 'cli', 'key.create', ${id}, ${JSON.stringify({ name, scopes, sites })})`,
      ]);
      const varName = (args.var ?? `PULSE_KEY_${name}_${env}`).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      upsertEnvFile(".data/keys.env", varName, key);
      console.log(`key "${name}" (${scopes.join(",")}) stored in .data/keys.env as ${varName}`);
      break;
    }
    case "key:revoke": {
      d1(env, sql`UPDATE api_keys SET revoked_at = ${Date.now()} WHERE id = ${need("id")} OR name = ${args.id}`);
      console.log("revoked");
      break;
    }
    case "keys": {
      const rows = d1(env, "SELECT id, prefix, name, scopes_json, site_ids_json, expires_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at");
      console.log(JSON.stringify(rows, null, 2));
      break;
    }
    case "sql": {
      console.log(JSON.stringify(d1(env, need("q")), null, 2));
      break;
    }
    default:
      console.log(`commands: site:create site:domains goal:create funnel:create session session:delete key:create key:revoke keys sql`);
      process.exitCode = cmd ? 1 : 0;
  }
  appendFileSync(".data/admin.log", `${new Date().toISOString()} ${env} ${cmd}\n`);
}

await main();

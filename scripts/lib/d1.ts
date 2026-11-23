// Run SQL against the remote production D1 database through wrangler (no secrets printed). The database id comes
// from your deploy variables (PULSE_* in the environment or .env.deploy), through scripts/deploy-config.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type EnvName = "production";

export const DB_NAME: Record<EnvName, string> = { production: "pulse" };

const DEPLOY_CONFIG = join(process.cwd(), "wrangler.deploy.jsonc");
const HAS_CUSTOM_DEPLOY = () => existsSync(join(process.cwd(), ".env.deploy")) || Boolean(process.env.PULSE_DOMAIN);
let rendered = false;
/** Render wrangler.deploy.jsonc when custom PULSE_* vars exist; otherwise use top-level wrangler.jsonc (1-click deploy). */
function wranglerTarget(env: EnvName): { db: string; configArgs: string[] } {
  if (!HAS_CUSTOM_DEPLOY()) {
    return { db: "DB", configArgs: [] };
  }
  if (!rendered) {
    execFileSync(process.execPath, [join(process.cwd(), "scripts", "deploy-config.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
    rendered = true;
  }
  return { db: DB_NAME[env], configArgs: ["-c", DEPLOY_CONFIG, "--env", env] };
}

/** Your Pulse origin, from the rendered deploy config (PULSE_DOMAIN) or detected_origin in D1. */
export const ORIGIN: Record<EnvName, string> = {
  get production() {
    if (HAS_CUSTOM_DEPLOY()) {
      wranglerTarget("production");
      const text = readFileSync(DEPLOY_CONFIG, "utf8");
      return (JSON.parse(text.slice(text.indexOf("{"))) as { env: { production: { vars: { PUBLIC_ORIGIN: string } } } }).env.production.vars.PUBLIC_ORIGIN;
    }
    try {
      const rows = d1("production", "SELECT value FROM kv_meta WHERE key = 'detected_origin'") as { value?: string }[];
      if (rows[0]?.value) return rows[0].value;
    } catch {
      // Fallback when running before first visit.
    }
    return "https://<your-worker>.workers.dev";
  },
};

export function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? lit(values[i]) : ""), "");
}

const WRANGLER = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

/** Run one statement (`--command`, returns rows) or several (`--file`, returns only a summary). No shell. */
export function d1(env: EnvName, statements: string | string[], opts: { json?: boolean } = {}): unknown[] {
  const list = (Array.isArray(statements) ? statements : [statements]).map((s) => s.trim().replace(/;$/, ""));
  const target = wranglerTarget(env);
  const base = ["d1", "execute", target.db, "--remote", ...target.configArgs, "--json", "-y"];
  let dir: string | null = null;
  try {
    let args: string[];
    if (list.length === 1) args = [...base, "--command", list[0]!];
    else {
      dir = mkdtempSync(join(tmpdir(), "pulse-sql-"));
      const file = join(dir, "q.sql");
      writeFileSync(file, list.map((s) => s + ";").join(String.fromCharCode(10)));
      args = [...base, "--file", file];
    }
    const out = execFileSync(process.execPath, [WRANGLER, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const start = out.indexOf("[");
    const parsed = JSON.parse(out.slice(start)) as { results?: unknown[] }[];
    return opts.json === false ? [] : parsed.flatMap((p) => p.results ?? []);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// Writes wrangler.deploy.jsonc: wrangler.jsonc with the ${PULSE_*} placeholders of env.production filled from the
// environment, so your domain, resource ids and addresses live in your Cloudflare build variables (or a local
// .env.deploy) instead of in the repository, and a fork can pull upstream changes without conflicts.
//
//   node scripts/deploy-config.mjs            → wrangler.deploy.jsonc (git-ignored)
//   npx wrangler deploy -c wrangler.deploy.jsonc --env production
//
// Required: PULSE_DOMAIN, PULSE_D1_ID, PULSE_KV_ID. Optional: PULSE_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID),
// PULSE_ACCESS_TEAM_DOMAIN + PULSE_ACCESS_AUD (dashboard sign-in), PULSE_ALERT_FROM, PULSE_ALERT_TO,
// PULSE_JURISDICTION (eu, fedramp or none; default eu), PULSE_OPS_BACKUPS (false to drop the ops-backups bucket).
// docs/SELF-HOSTING.md explains each one.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

/** KEY=value lines from .env.deploy, if present; real environment variables win. */
function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** JSON with // and /* comments and trailing commas (wrangler.jsonc). Strings are kept intact. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function render(config, vars) {
  const missing = new Set();
  const fill = (v) => {
    if (typeof v === "string")
      return v.replace(/\$\{(\w+)\}/g, (_, k) => {
        if (vars[k] === undefined || vars[k] === "") missing.add(k);
        return vars[k] ?? "";
      });
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const prod = structuredClone(config.env.production);
  const optional = (key) => vars[key] === undefined || vars[key] === "";
  // Optional pieces are dropped when their variable isn't set.
  if (optional("PULSE_ALERT_FROM")) delete prod.vars.ALERT_FROM;
  if (optional("PULSE_ACCESS_TEAM_DOMAIN") || optional("PULSE_ACCESS_AUD")) {
    delete prod.vars.ACCESS_TEAM_DOMAIN;
    delete prod.vars.ACCESS_AUD;
  }
  if (optional("PULSE_ACCOUNT_ID")) delete prod.vars.CF_ACCOUNT_ID;
  if (optional("PULSE_ALERT_TO")) for (const b of prod.send_email ?? []) delete b.destination_address;
  const jurisdiction = vars.PULSE_JURISDICTION ?? "eu";
  for (const b of prod.r2_buckets ?? []) {
    if (jurisdiction === "none" || jurisdiction === "") delete b.jurisdiction;
    else b.jurisdiction = jurisdiction;
  }
  if (vars.PULSE_OPS_BACKUPS === "false") prod.r2_buckets = (prod.r2_buckets ?? []).filter((b) => b.binding !== "OPS_BACKUPS");
  const filled = fill(prod);
  if (missing.size) throw new Error(`missing ${[...missing].join(", ")} (set them in the environment or .env.deploy; see docs/SELF-HOSTING.md)`);
  const accountId = vars.PULSE_ACCOUNT_ID || vars.CLOUDFLARE_ACCOUNT_ID;
  return { ...config, ...(accountId ? { account_id: accountId } : {}), env: { production: filled } };
}

/**
 * PULSE_* values read back from an already deployed Worker's bindings (GET …/workers/scripts/<name>/settings), so
 * an existing deployment can be updated with nothing but a Cloudflare API token that can read it.
 */
export function varsFromBindings(bindings) {
  const by = Object.fromEntries(bindings.map((b) => [b.name, b]));
  const text = (n) => (by[n]?.type === "plain_text" ? by[n].text : undefined);
  const out = {
    PULSE_DOMAIN: text("RP_ID") ?? (text("PUBLIC_ORIGIN") ? new URL(text("PUBLIC_ORIGIN")).host : undefined),
    PULSE_D1_ID: by.DB?.database_id ?? by.DB?.id,
    PULSE_KV_ID: by.OAUTH_KV?.namespace_id,
    PULSE_ACCESS_TEAM_DOMAIN: text("ACCESS_TEAM_DOMAIN"),
    PULSE_ACCESS_AUD: text("ACCESS_AUD"),
    PULSE_ALERT_FROM: text("ALERT_FROM"),
    PULSE_ALERT_TO: by.SEND_EMAIL?.destination_address,
    PULSE_ACCOUNT_ID: text("CF_ACCOUNT_ID"),
    PULSE_JURISDICTION: by.BACKUPS ? (by.BACKUPS.jurisdiction ?? "none") : undefined,
    PULSE_OPS_BACKUPS: by.BACKUPS && !by.OPS_BACKUPS ? "false" : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
}

async function fromDeployed(vars, name) {
  const token = vars.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN isn't set, so the deployed Worker can't be read");
  const api = async (path) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success) throw new Error(`Cloudflare API ${path.replace(/\/accounts\/[^/]+/, "/accounts/…")}: ${res.status} ${(j.errors ?? []).map((e) => e.message).join("; ")}`);
    return j.result;
  };
  let account = vars.PULSE_ACCOUNT_ID || vars.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const list = await api("/accounts?per_page=5");
    if (list.length !== 1) throw new Error("set CLOUDFLARE_ACCOUNT_ID: the token sees several accounts");
    account = list[0].id;
  }
  const settings = await api(`/accounts/${account}/workers/scripts/${name}/settings`);
  return { PULSE_ACCOUNT_ID: account, ...varsFromBindings(settings.bindings ?? []) };
}

const REQUIRED = ["PULSE_DOMAIN", "PULSE_D1_ID", "PULSE_KV_ID"];

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}` || process.argv[1]?.endsWith("deploy-config.mjs")) {
  const flags = new Set(process.argv.slice(2));
  // --ci: inside Workers Builds (WORKERS_CI=1) only. When PULSE_DOMAIN (or CLOUDFLARE_API_TOKEN for an existing
  // custom-domain deployment) is configured, fill env.production into wrangler.jsonc; otherwise leave the
  // top-level 1-click Deploy Button config untouched. Outside CI it does nothing.
  if (flags.has("--ci") && !process.env.WORKERS_CI) process.exit(0);
  const ci = flags.has("--ci");
  let vars = { ...loadDotEnv(new URL(".env.deploy", root)), ...process.env };
  if (ci && !vars.PULSE_DOMAIN && !vars.CLOUDFLARE_API_TOKEN) {
    console.log("deploy-config: no PULSE_* build vars set; using top-level wrangler.jsonc");
    process.exit(0);
  }
  const config = parseJsonc(readFileSync(new URL("wrangler.jsonc", root), "utf8"));
  try {
    if ((ci || flags.has("--from-deployed")) && REQUIRED.some((k) => !vars[k])) {
      vars = { ...(await fromDeployed(vars, config.env.production.name)), ...Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== "")) };
    }
    const out = render(config, vars);
    const target = ci || flags.has("--in-place") ? "wrangler.jsonc" : "wrangler.deploy.jsonc";
    writeFileSync(new URL(target, root), `// Generated by scripts/deploy-config.mjs from wrangler.jsonc. Don't edit or commit.\n${JSON.stringify(out, null, 2)}\n`);
    if (target !== "wrangler.deploy.jsonc") writeFileSync(new URL("wrangler.deploy.jsonc", root), readFileSync(new URL(target, root)));
    console.log(`${target} written for ${out.env.production.vars.PUBLIC_ORIGIN}`);
  } catch (err) {
    console.error(`deploy-config: ${err.message}`);
    process.exit(1);
  }
}

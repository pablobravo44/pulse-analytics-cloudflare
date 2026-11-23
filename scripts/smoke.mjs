// Post-deploy smoke test: node scripts/smoke.mjs [production|https://your-pulse.example.com|http://localhost:8787]
// "production" means https://$PULSE_DOMAIN (the deploy variable). Uses SMOKE_KEY_PRODUCTION (stats:read on a
// pulse-smoke site) from the environment; SMOKE_KEY for any other URL.
import { existsSync, readFileSync } from "node:fs";

const target = process.argv[2] ?? "production";
/** PULSE_DOMAIN, or the origin in the config scripts/deploy-config.mjs generated for this deploy. */
function deployedOrigin() {
  if (process.env.PULSE_DOMAIN) return `https://${process.env.PULSE_DOMAIN}`;
  if (!existsSync("wrangler.deploy.jsonc")) return null;
  const text = readFileSync("wrangler.deploy.jsonc", "utf8");
  return JSON.parse(text.slice(text.indexOf("{"))).env?.production?.vars?.PUBLIC_ORIGIN ?? null;
}
const origin = target === "production" ? deployedOrigin() : target;
if (!origin) {
  console.log("smoke: PULSE_DOMAIN not set and no wrangler.deploy.jsonc, skipping");
  process.exit(0);
}
const key = (target === "production" ? process.env.SMOKE_KEY_PRODUCTION : undefined) ?? process.env.SMOKE_KEY;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

let failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function retry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

await check("healthz", () =>
  retry(async () => {
    const r = await fetch(`${origin}/healthz`);
    assert(r.status === 200, `status ${r.status}`);
    assert((await r.json()).ok === true, "not ok");
  }),
);
await check("tracker", async () => {
  const r = await fetch(`${origin}/p.js`);
  assert(r.status === 200, `status ${r.status}`);
  assert((r.headers.get("content-type") ?? "").includes("javascript"), "content-type");
  assert((await r.text()).length > 500, "too small");
});
await check("ingest", async () => {
  const r = await fetch(`${origin}/e`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": UA },
    body: JSON.stringify({ s: "pulse-smoke", t: "pageview", u: `https://smoke.pulse.test/deploy?t=${Date.now()}`, w: 1440, h: 900, l: "en" }),
  });
  assert(r.status === 202, `status ${r.status}`);
});
if (key) {
  await check("api summary", async () => {
    const r = await fetch(`${origin}/api/v1/sites/pulse-smoke/summary?date_range=today`, { headers: { Authorization: `Bearer ${key}` } });
    assert(r.status === 200, `status ${r.status}`);
    assert("kpis" in (await r.json()), "no kpis");
  });
  // The site view and the home: each runs many queries merged into a few D1 statements.
  for (const [name, path, field] of [
    ["api overview", "/api/v1/sites/pulse-smoke/overview?date_range=28d", "kpis"],
    ["api sites summary", "/api/v1/sites/summary?date_range=7d", "sites"],
    ["api changes", "/api/v1/sites/pulse-smoke/changes", "visitors"],
  ]) {
    await check(name, async () => {
      const r = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${key}` } });
      assert(r.status === 200, `status ${r.status}`);
      assert(field in (await r.json()), `no ${field}`);
    });
  }
  await check("mcp tools/list", async () => {
    const r = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert(r.status === 200, `status ${r.status}`);
    const j = await r.json();
    assert((j.result?.tools?.length ?? 0) >= 16, "tools missing");
  });
} else console.log("skip api/mcp checks (no smoke key in env)");

if (failed) {
  console.error(`${failed} smoke check(s) failed`);
  process.exit(1);
}
console.log("smoke passed");

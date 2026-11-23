// Add a deploy annotation to Pulse from a repo's deploy command (Workers Builds or any CI).
// Env: PULSE_ANNOTATE_KEY (annotations:write), PULSE_ORIGIN (or PULSE_DOMAIN), PULSE_SITE (site ids,
// comma-separated, or "*"), PULSE_REPO (owner/name on GitHub, for the commit link). Never fails the deploy.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const key = process.env.PULSE_ANNOTATE_KEY;
if (!key) {
  console.log("annotate-deploy: PULSE_ANNOTATE_KEY not set, skipping");
  process.exit(0);
}
const deployConfig = () => {
  try {
    const text = readFileSync("wrangler.deploy.jsonc", "utf8");
    return JSON.parse(text.slice(text.indexOf("{"))).env?.production?.vars?.PUBLIC_ORIGIN ?? null;
  } catch {
    return null;
  }
};
const origin = process.env.PULSE_ORIGIN ?? (process.env.PULSE_DOMAIN ? `https://${process.env.PULSE_DOMAIN}` : deployConfig());
if (!origin) {
  console.log("annotate-deploy: PULSE_ORIGIN (or PULSE_DOMAIN) not set, skipping");
  process.exit(0);
}
const sites = (process.env.PULSE_SITE ?? "*").split(",");
const repo = process.env.PULSE_REPO ?? process.env.GITHUB_REPOSITORY ?? "pulse";
const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const sha = process.env.WORKERS_CI_COMMIT_SHA || git("rev-parse HEAD");
const subject = git("log -1 --format=%s") || "deploy";
const body = {
  sites: sites.length === 1 && sites[0] === "*" ? "*" : sites,
  repo,
  sha,
  message: subject.slice(0, 500),
  ...(sha && repo.includes("/") ? { url: `https://github.com/${repo}/commit/${sha}` } : {}),
};
if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
  console.log("annotate-deploy: no commit sha, skipping");
  process.exit(0);
}
// One call; the hook is idempotent per commit and site, so a retried build adds nothing.
try {
  const r = await fetch(`${origin}/api/v1/hooks/deploy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`annotate-deploy: HTTP ${r.status}`);
} catch (err) {
  console.log(`annotate-deploy: ${err.message}`);
}

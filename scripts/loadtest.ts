// Load tests against a LOCAL `wrangler dev` only (never a real deployment):
//   node scripts/loadtest.ts ingest --hits 50000 --minutes 5
//   node scripts/loadtest.ts seed --events 1000000 --months 12   (synthetic rows for site "loadtest" via /admin/import)
//   node scripts/loadtest.ts read --runs 40                         (p50/p95 of summary and breakdown over 12 months)
import { readFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const args: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) if (rest[i]!.startsWith("--")) args[rest[i]!.slice(2)] = rest[i + 1] ?? "true";
const origin = args.origin ?? "http://localhost:8787";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("load tests run against a local wrangler dev only");
const SEED_KEY_VAR = args["key-var"] ?? "PULSE_KEY_ADMIN_SEED_LOCAL";
const keyOf = (v: string) =>
  readFileSync(".data/keys.env", "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${v}=`))
    ?.slice(v.length + 1)
    .trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PAGES = ["/", "/pricing", "/blog/a", "/blog/b", "/docs", "/about", "/es/", "/fr/"];
const REFS = ["", "https://www.google.com/", "https://chatgpt.com/", "https://t.co/x", "https://news.ycombinator.com/"];
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ingest() {
  const total = Number(args.hits ?? 50000);
  const minutes = Number(args.minutes ?? 5);
  const conc = Number(args.concurrency ?? 50);
  const perMs = total / (minutes * 60_000);
  let next = 0;
  let netErrors = 0;
  const status = new Map<number, number>();
  const t0 = Date.now();
  async function worker() {
    while (next < total) {
      const i = next++;
      const wait = t0 + i / perMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const r = await fetch(`${origin}/e`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", "User-Agent": UA },
          body: JSON.stringify({ s: "loadtest", t: "pageview", u: `https://loadtest.pulse.test${pick(PAGES)}`, r: pick(REFS), w: 1440, h: 900, l: "en" }),
        });
        status.set(r.status, (status.get(r.status) ?? 0) + 1);
        await r.body?.cancel();
      } catch {
        netErrors++;
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  console.log(JSON.stringify({ total, seconds: (Date.now() - t0) / 1000, status: Object.fromEntries(status), network_errors: netErrors }));
}

async function seed() {
  const key = keyOf(SEED_KEY_VAR);
  if (!key) throw new Error(`${SEED_KEY_VAR} missing in .data/keys.env`);
  const n = Number(args.events ?? 1_000_000);
  const months = Number(args.months ?? 12);
  const now = Date.now();
  const span = months * 30 * 86_400_000;
  let done = 0;
  const post = async (sessions: unknown[], events: unknown[]) => {
    for (let a = 0; ; a++) {
      const r = await fetch(`${origin}/api/v1/admin/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ site_id: "loadtest", source: "rybbit", import_id: "loadtest-seed", sessions, events }),
      });
      if (r.ok) return;
      if (a > 5) throw new Error(`seed HTTP ${r.status}`);
      await sleep(2000 * (a + 1));
    }
  };
  const conc = Number(args.concurrency ?? 6);
  async function worker() {
    while (done < n) {
      const sessions: Record<string, unknown>[] = [];
      const events: Record<string, unknown>[] = [];
      while (events.length < 450) {
        const start = now - Math.floor(Math.random() * span);
        const sid = `lt_${start}_${Math.random().toString(36).slice(2, 8)}`;
        const vid = `lt_v_${Math.floor(Math.random() * 200000)}`;
        const pvs = 1 + Math.floor(Math.random() * 4);
        const day = new Date(start).toISOString().slice(0, 10);
        const ch = pick(["Direct", "Organic Search", "AI Assistants", "Referral", "Organic Social"]);
        const country = pick(["ES", "FR", "DE", "US", "PT"]);
        sessions.push({ id: sid, visitor_id: vid, started_at: start, last_seen_at: start + pvs * 30_000, local_day: day, entry_path: "/", exit_path: "/", pageviews: pvs, events: 0, engaged_ms: 0, duration_ms: pvs * 30_000, bounced: pvs === 1 ? 1 : 0, channel: ch, country, device: pick(["desktop", "mobile"]), browser: "Chrome", os: "Android" });
        for (let i = 0; i < pvs; i++) {
          const ts = start + i * 30_000;
          events.push({ id: `${sid}_${i}`, ts, local_day: day, local_hour: new Date(ts).getUTCHours(), type: "pageview", session_id: sid, visitor_id: vid, pathname: pick(PAGES), channel: ch, country, device: "desktop" });
        }
      }
      done += events.length;
      await post(sessions, events);
      if (done % 45_000 < 450) console.log(`seeded ~${done}/${n}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
}

async function read() {
  const key = keyOf(SEED_KEY_VAR);
  const runs = Number(args.runs ?? 40);
  const times: Record<string, number[]> = { summary: [], breakdown: [] };
  for (let i = 0; i < runs; i++) {
    for (const [name, path] of [
      ["summary", "/api/v1/sites/loadtest/summary?date_range=12mo&compare=none"],
      ["breakdown", "/api/v1/sites/loadtest/breakdown/page?date_range=12mo&metrics=visitors,pageviews"],
    ] as const) {
      const t0 = performance.now();
      const r = await fetch(`${origin}${path}&n=${i}`, { headers: { Authorization: `Bearer ${key}` } });
      await r.text();
      if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
      times[name]!.push(performance.now() - t0);
    }
  }
  const q = (a: number[], p: number) => Math.round([...a].sort((x, y) => x - y)[Math.floor(a.length * p)]!);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, { p50: q(v, 0.5), p95: q(v, 0.95) }]))));
}

const jobs: Record<string, () => Promise<void>> = { ingest, seed, read };
if (!cmd || !jobs[cmd]) console.log("commands: ingest seed read");
else await jobs[cmd]();

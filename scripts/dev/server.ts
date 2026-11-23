// Local full stack without workerd: the real Worker (src/worker/index.ts) behind a Node HTTP server.
//   npm run dev:seed      demo sites and 120 days of traffic in .data/dev.sqlite
//   npm run dev:api       this server on http://localhost:8787 (serves dist/public; run `npm run build` first)
//   npm run dev           this server + the Vite dashboard on http://localhost:5173 (proxies /api, /auth, /mcp)
// Open /__dev/login to get an owner session. Development only; never deployed.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import worker from "../../src/worker/index.ts";
import { createSession, sessionCookie } from "../../src/worker/auth/session.ts";
import { runMonitors } from "../../src/worker/ops/monitor.ts";
import { scheduled } from "../../src/worker/cron/jobs.ts";
import { evaluateAlerts } from "../../src/worker/ops/alerts.ts";
import { DEV_ORIGIN, devEnv } from "./env.ts";

const { env, db, applied } = devEnv();
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);
const port = Number(new URL(DEV_ORIGIN).port || 8787);

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p.catch((e) => console.error("waitUntil", e))), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

export async function devOwnerSession(): Promise<{ token: string; expiresAt: number }> {
  const email = "owner@pulse.local";
  let u = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!u) {
    u = { id: "dev_owner" };
    await db.prepare("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Dev owner', 'owner', ?)").bind(u.id, email, Date.now()).run();
  }
  return createSession(db, u.id, { label: "dev" });
}

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", DEV_ORIGIN);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", req.socket.remoteAddress ?? "127.0.0.1");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers, body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined, duplex: "half" } as RequestInit);
}

async function send(res: ServerResponse, r: Response, acceptEncoding = "") {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  // Compress text like Cloudflare does in production, so local performance checks (Lighthouse) are comparable.
  const type = r.headers.get("content-type") ?? "";
  let body = r.body as ReadableStream<Uint8Array> | null;
  if (body && /gzip/.test(acceptEncoding) && /(javascript|css|html|json|svg|text)/.test(type) && !r.headers.has("content-encoding")) {
    body = body.pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
    headers["content-encoding"] = "gzip";
    delete headers["content-length"];
    headers["vary"] = "Accept-Encoding";
  }
  res.writeHead(r.status, headers);
  if (body) for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", DEV_ORIGIN);
    if (url.pathname === "/__dev/login") {
      const s = await devOwnerSession();
      const next = url.searchParams.get("next") ?? "/";
      return send(res, new Response(null, { status: 302, headers: { Location: next.startsWith("/") ? next : "/", "Set-Cookie": sessionCookie(s.token, s.expiresAt) } }));
    }
    const r = await worker.fetch(toRequest(req), env, ctx);
    await send(res, r, String(req.headers["accept-encoding"] ?? ""));
    await Promise.all(pending.splice(0));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("dev server error");
  }
}).listen(port, () => console.log(`Pulse dev server on ${DEV_ORIGIN} (open ${DEV_ORIGIN}/__dev/login)`));

// Crons: the */5 trigger every 5 minutes; monitors are production-only in scheduled(), so run them here too.
setInterval(() => {
  const now = Date.now();
  void scheduled({ cron: "*/5 * * * *", scheduledTime: now, noRetry() {} } as ScheduledController, env).catch((e) => console.error("cron", e));
  if (process.env.PULSE_DEV_MONITORS !== "0") void runMonitors(env, now).catch((e) => console.error("monitors", e));
  void evaluateAlerts(env, now).catch((e) => console.error("alerts", e));
}, 5 * 60_000);

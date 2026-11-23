import { app } from "./app.ts";
import { scheduled, setMeta } from "./cron/jobs.ts";
import type { Env } from "./env.ts";
import type { EnrichedHit } from "./ingest/types.ts";
import { clientKey } from "./lib/ip.ts";
import { provider } from "./oauth/provider.ts";
import { handleQueue, processHit } from "./queue/consumer.ts";

let rememberedOrigin = "";

function withRequestOrigin(env: Env, url: URL, ctx: ExecutionContext): Env {
  if (env.PUBLIC_ORIGIN && env.RP_ID) return env;
  const origin = env.PUBLIC_ORIGIN || url.origin;
  const rpId = env.RP_ID || url.hostname;
  if (!env.PUBLIC_ORIGIN && origin !== rememberedOrigin && /^https?:\/\//.test(origin)) {
    rememberedOrigin = origin;
    ctx.waitUntil(setMeta(env.DB, "detected_origin", origin).catch(() => {}));
  }
  return { ...env, PUBLIC_ORIGIN: origin, RP_ID: rpId };
}

async function withScheduledOrigin(env: Env): Promise<Env> {
  if (env.PUBLIC_ORIGIN && env.RP_ID) return env;
  let origin = env.PUBLIC_ORIGIN;
  if (!origin) {
    try {
      const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'detected_origin'").first<{ value: string }>();
      if (row?.value && /^https?:\/\//.test(row.value)) origin = row.value;
    } catch {
      // Ignore before first migration / read failure.
    }
  }
  origin ||= "https://pulse.workers.dev";
  return { ...env, PUBLIC_ORIGIN: origin, RP_ID: env.RP_ID || new URL(origin).hostname };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const resolvedEnv = withRequestOrigin(env, url, ctx);
    const authz = req.headers.get("authorization") ?? "";
    // API keys skip the OAuth provider entirely.
    if (authz.startsWith("Bearer pulse_sk_") || url.pathname === "/e" || url.pathname.startsWith("/api/") || url.pathname === "/p.js" || url.pathname.startsWith("/hb/") || url.pathname.startsWith("/l/")) {
      return app.fetch(req, resolvedEnv, ctx);
    }
    // Dynamic client registration is open to anyone (that's how connectors sign up): 20 a minute per client.
    if (url.pathname === "/oauth/register" && req.method === "POST" && !(await resolvedEnv.LOGIN_LIMITER.limit({ key: `oauth-register:${await clientKey(req)}` })).success) {
      return Response.json({ error: "rate_limited", error_description: "too many registrations; try again in a minute" }, { status: 429, headers: { "Retry-After": "60" } });
    }
    return provider(resolvedEnv.PUBLIC_ORIGIN).fetch(req, resolvedEnv, ctx);
  },

  async queue(batch: MessageBatch<EnrichedHit>, env: Env): Promise<void> {
    if (batch.queue.endsWith("-dlq")) {
      // Last attempt for dead letters; record how many arrived.
      let failed = 0;
      for (const m of batch.messages) {
        try {
          await processHit(env.DB, m.body);
        } catch {
          failed++;
        }
        m.ack();
      }
      await setMeta(env.DB, "dlq_depth", String(failed));
      if (failed) console.error(JSON.stringify({ msg: "dlq_dropped", count: failed }));
      return;
    }
    await handleQueue(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(withScheduledOrigin(env).then((resolved) => scheduled(controller, resolved)));
  },
} satisfies ExportedHandler<Env, EnrichedHit>;

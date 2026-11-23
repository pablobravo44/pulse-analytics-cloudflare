import type { Env, Waiter } from "../env.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { getSite, type Site } from "../lib/sites.ts";
import { rateLimitSubject } from "../lib/ip.ts";
import { isHostingNetwork } from "../lib/hosting.ts";
import { hostAllowed } from "../lib/url.ts";
import { utcDay } from "../lib/time.ts";
import { noteQueued, overDailyCap } from "./cap.ts";
import { enrich, parsePayload, type DropReason, type RequestMeta } from "./enrich.ts";
import { saltFor } from "./salt.ts";
import { countStat, maybeFlush, noteRejectedHost, type StatField } from "./stats.ts";
import type { TrackerPayload } from "./types.ts";

const DROP_FIELD: Record<DropReason, StatField> = {
  bot: "dropped_bot",
  dnt: "dropped_dnt",
  hosting: "dropped_hosting",
  site: "dropped_host",
  excluded: "dropped_excluded",
  invalid: "dropped_invalid",
};

export const MAX_BODY = 8 * 1024;

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function accepted(): Response {
  return new Response(null, { status: 202, headers: CORS_HEADERS });
}

export function requestMeta(req: Request, now = Date.now()): RequestMeta {
  const cf = (req as Request & { cf?: IncomingRequestCfProperties }).cf;
  const verifiedBotCategory = (cf as { verifiedBotCategory?: string } | undefined)?.verifiedBotCategory;
  return {
    ip: req.headers.get("cf-connecting-ip") ?? "0.0.0.0",
    ua: req.headers.get("user-agent") ?? "",
    origin: req.headers.get("origin"),
    country: (cf?.country as string | undefined) ?? null,
    region: (cf?.regionCode as string | undefined) ?? null,
    city: (cf?.city as string | undefined) ?? null,
    continent: (cf?.continent as string | undefined) ?? null,
    verifiedBot: !!verifiedBotCategory || !!cf?.botManagement?.verifiedBot,
    dnt: req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1",
    hosting: isHostingNetwork(cf?.asn, cf?.asOrganization),
    now,
  };
}

export async function readBody(req: Request): Promise<unknown | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return null;
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY || buf.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

/**
 * Ingest path for `/e`. Always resolves; callers answer 202.
 * The IP in `meta` is used for the rate-limit key and visitor hash only.
 */
export async function ingestPayload(
  env: Env,
  ctx: Waiter,
  payload: TrackerPayload,
  meta: RequestMeta,
): Promise<void> {
  const site = await getSite(env.DB, payload.s);
  if (!site) {
    countStat("_unknown", "dropped_invalid", 1, meta.now);
    return;
  }
  // Circuit breaker: a site over its daily event cap is paused until the next UTC day (src/worker/ingest/cap.ts).
  if (await overDailyCap(env, ctx, site, meta.now)) {
    countStat(site.id, "dropped_cap", 1, meta.now);
    return;
  }

  // IPv6 clients are limited per /64 (src/worker/lib/ip.ts); the subject is hashed, never stored.
  const rlKey = `${site.id}:${(await sha256Hex(`${utcDay(meta.now)}|${rateLimitSubject(meta.ip)}`)).slice(0, 32)}`;
  const rl = await env.INGEST_LIMITER.limit({ key: rlKey });
  if (!rl.success) {
    countStat(site.id, "dropped_rate", 1, meta.now);
    return;
  }

  // Revenue in another currency than the site's is ignored (the event stays) and counted.
  const props = payload.t === "event" && payload.p && typeof payload.p === "object" ? (payload.p as Record<string, unknown>) : null;
  if (props && props.revenue !== undefined && typeof props.currency === "string" && props.currency.toUpperCase() !== site.settings.revenue_currency) {
    const { revenue: _ignored, ...rest } = props;
    payload = { ...payload, p: rest as TrackerPayload["p"] };
    countStat(site.id, "revenue_ignored", 1, meta.now);
  }

  const salt = await saltFor(env.DB, site.timezone, meta.now);
  const hit = await enrich(payload, site, meta, salt);
  if (typeof hit === "string") {
    countStat(site.id, DROP_FIELD[hit], 1, meta.now);
    if (hit === "site") rememberRejectedHost(site, payload.u, meta);
    return;
  }
  await env.EVENTS.send(hit, { contentType: "json" });
  noteQueued(site.id);
}

/** Keep the last hostname that was rejected for a site, for the installation check. A hostname is not personal data. */
function rememberRejectedHost(site: Site, url: string, meta: RequestMeta): void {
  const hostOf = (u: string | null) => {
    try {
      return u ? new URL(u).hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  };
  const page = hostOf(url);
  const host = page && !hostAllowed(page, site.domains) ? page : hostOf(meta.origin);
  if (host) noteRejectedHost(site.id, host, meta.now);
}

export async function handleIngest(req: Request, env: Env, ctx: Waiter): Promise<Response> {
  const body = await readBody(req);
  const payload = parsePayload(body);
  try {
    if (!payload) countStat("_unknown", "dropped_invalid");
    else await ingestPayload(env, ctx, payload, requestMeta(req));
  } catch (err) {
    console.error(JSON.stringify({ msg: "ingest_failed", error: String(err).slice(0, 200) }));
  }
  // Drop counters are written at most once a minute per isolate (src/worker/ingest/stats.ts).
  maybeFlush(env.DB, ctx);
  return accepted();
}

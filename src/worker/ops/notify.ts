// Notification channels: where incident and traffic alerts go. Secrets are sealed with PULSE_SECRET_KEY and
// never returned or logged; lists show config_hint only.
import { z } from "zod";
import { ApiError } from "../api/common.ts";
import type { Env } from "../env.ts";
import { hmacHex, openJson, randomToken, sealJson } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { getOpsSettings } from "../lib/settings.ts";
import { sendMail } from "./email.ts";
import { emailHtml } from "./mailtpl.ts";

export const CHANNEL_KINDS = ["email", "webhook", "slack", "discord", "telegram", "ntfy"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_INFO: Record<ChannelKind, string> = {
  email: "Email to your verified address (ALERT_EMAIL)",
  webhook: "JSON POST to your URL, signed with X-Pulse-Signature: sha256=<HMAC of the body>",
  slack: "A Slack incoming-webhook URL",
  discord: "A Discord channel webhook URL",
  telegram: "A Telegram bot token and chat id",
  ntfy: "An ntfy topic URL (ntfy.sh or self-hosted), optional access token",
};

const https = z.string().url().max(500).refine((u) => u.startsWith("https://"), "must be an https URL");
export const channelConfig = {
  email: z.object({}).passthrough(),
  webhook: z.object({ url: https }),
  slack: z.object({ url: https.refine((u) => /^https:\/\/hooks\.slack\.com\//.test(u), "must be a hooks.slack.com URL") }),
  discord: z.object({ url: https.refine((u) => /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(u), "must be a Discord webhook URL") }),
  telegram: z.object({ bot_token: z.string().regex(/^\d+:[\w-]{20,}$/, "looks like 123456:ABC…"), chat_id: z.string().min(1).max(64) }),
  ntfy: z.object({ url: https, token: z.string().max(200).optional() }),
} satisfies Record<ChannelKind, z.ZodTypeAny>;

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string;
  config_enc: string | null;
  config_hint: string | null;
  enabled: number;
  created_at: number;
  last_sent_at: number | null;
  last_error: string | null;
}

export interface Message {
  title: string;
  text: string;
  url?: string;
  severity: "down" | "up" | "alert" | "info";
  data?: Record<string, unknown>;
  /** Full HTML for email (reports); without it, email gets the standard alert layout. */
  html?: string;
  /**
   * "error" (a new JavaScript error) and "report" (a scheduled report an admin set up, stopped in Settings → Reports)
   * still email while `email_only_errors` is on; everything else skips email channels.
   */
  category?: "error" | "report";
}

function hintFor(kind: ChannelKind, cfg: Record<string, unknown>): string {
  if (kind === "email") return "ALERT_EMAIL";
  if (kind === "telegram") return `chat ${String(cfg.chat_id)}`;
  try {
    const u = new URL(String(cfg.url));
    const tail = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${u.host}/…/${tail.slice(-4)}`;
  } catch {
    return kind;
  }
}

export function channelView(r: ChannelRow) {
  return { id: r.id, kind: r.kind, name: r.name, target: r.config_hint, enabled: !!r.enabled, created_at: new Date(r.created_at).toISOString(), last_sent_at: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null, last_error: r.last_error };
}

export async function listChannels(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM notification_channels ORDER BY created_at").all<ChannelRow>();
  return results.map(channelView);
}

export const channelInput = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(CHANNEL_KINDS),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().optional(),
});

/** Create a channel. Webhooks get a signing secret, returned once. */
export async function createChannel(env: Env, input: z.input<typeof channelInput>): Promise<{ channel: ReturnType<typeof channelView>; signing_secret?: string }> {
  const b = channelInput.parse(input);
  const cfg = channelConfig[b.kind].parse(b.config) as Record<string, unknown>;
  let signing: string | undefined;
  if (b.kind === "webhook") cfg.signing_secret = signing = randomToken(24);
  let sealed: string | null = null;
  if (b.kind !== "email") {
    if (!env.PULSE_SECRET_KEY) throw new ApiError(422, "secret_key_missing", "Set the PULSE_SECRET_KEY Worker secret to store webhook URLs and tokens (see docs/OPERATIONS.md)");
    sealed = await sealJson(env.PULSE_SECRET_KEY, cfg);
  }
  const id = ulid();
  await env.DB.prepare("INSERT INTO notification_channels (id, kind, name, config_enc, config_hint, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, b.kind, b.name, sealed, hintFor(b.kind, cfg), b.enabled === false ? 0 : 1, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT * FROM notification_channels WHERE id = ?").bind(id).first<ChannelRow>();
  return { channel: channelView(row!), ...(signing ? { signing_secret: signing } : {}) };
}

export async function updateChannel(env: Env, id: string, input: { name?: string; enabled?: boolean; config?: Record<string, unknown> }) {
  const cur = await env.DB.prepare("SELECT * FROM notification_channels WHERE id = ?").bind(id).first<ChannelRow>();
  if (!cur) throw new ApiError(404, "not_found", "channel not found");
  let sealed = cur.config_enc;
  let hint = cur.config_hint;
  if (input.config && cur.kind !== "email") {
    const prev = cur.config_enc ? await openJson<Record<string, unknown>>(env.PULSE_SECRET_KEY, cur.config_enc) : {};
    const cfg = channelConfig[cur.kind].parse({ ...prev, ...input.config }) as Record<string, unknown>;
    if (prev.signing_secret) cfg.signing_secret = prev.signing_secret;
    sealed = await sealJson(env.PULSE_SECRET_KEY, cfg);
    hint = hintFor(cur.kind, cfg);
  }
  await env.DB.prepare("UPDATE notification_channels SET name = ?, enabled = ?, config_enc = ?, config_hint = ? WHERE id = ?")
    .bind(input.name ?? cur.name, input.enabled === undefined ? cur.enabled : input.enabled ? 1 : 0, sealed, hint, id)
    .run();
  return channelView((await env.DB.prepare("SELECT * FROM notification_channels WHERE id = ?").bind(id).first<ChannelRow>())!);
}

export async function deleteChannel(env: Env, id: string) {
  const res = await env.DB.prepare("DELETE FROM notification_channels WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "channel not found");
}

const icon = (m: Message) => (m.severity === "down" ? "🔴" : m.severity === "up" ? "✅" : m.severity === "alert" ? "📈" : "ℹ️");

async function deliver(env: Env, ch: ChannelRow, m: Message, fetcher: typeof fetch): Promise<void> {
  if (ch.kind === "email") {
    const html = m.html ?? emailHtml({ title: m.title, blocks: [{ lines: m.text.split("\n").filter(Boolean) }], ...(m.url ? { link: { url: m.url, label: "Open in Pulse" } } : {}), footer: "Sent by Pulse. Change where alerts go in Settings → Notifications." });
    const ok = await sendMail(env, m.html ? m.title : `${icon(m)} ${m.title}`, `${m.text}${m.url ? `\n\n${m.url}` : ""}`, html);
    if (!ok) throw new Error("email is not configured (SEND_EMAIL / ALERT_EMAIL)");
    return;
  }
  const cfg = await openJson<Record<string, string>>(env.PULSE_SECRET_KEY, ch.config_enc ?? "");
  const text = `${icon(m)} ${m.title}\n${m.text}${m.url ? `\n${m.url}` : ""}`;
  let res: Response;
  const post = (url: string, body: string, headers: Record<string, string>) => fetcher(url, { method: "POST", body, headers, signal: AbortSignal.timeout(10_000) });
  switch (ch.kind) {
    case "slack":
      // Escaped so text that came from visitors (error messages) can't become mentions or links.
      res = await post(cfg.url!, JSON.stringify({ text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }), { "Content-Type": "application/json" });
      break;
    case "discord":
      res = await post(cfg.url!, JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }), { "Content-Type": "application/json" });
      break;
    case "telegram":
      res = await post(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, JSON.stringify({ chat_id: cfg.chat_id, text: text.slice(0, 4000), disable_web_page_preview: true }), { "Content-Type": "application/json" });
      break;
    case "ntfy":
      res = await post(cfg.url!, `${m.text}${m.url ? `\n${m.url}` : ""}`, {
        Title: m.title.replace(/[^\x20-\x7e]/g, ""),
        Tags: m.severity === "down" ? "red_circle" : m.severity === "up" ? "white_check_mark" : "chart_with_upwards_trend",
        ...(m.url ? { Click: m.url } : {}),
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      });
      break;
    default: {
      const body = JSON.stringify({ title: m.title, text: m.text, url: m.url ?? null, severity: m.severity, data: m.data ?? null, at: new Date().toISOString() });
      res = await post(cfg.url!, body, { "Content-Type": "application/json", "User-Agent": "Pulse/1.0", "X-Pulse-Signature": `sha256=${await hmacHex(cfg.signing_secret ?? "", body)}` });
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Send a message to the given channels (null = every enabled channel). Returns how many succeeded.
 * Errors are recorded on the channel (never the URL or token) and logged with the channel id only.
 */
export async function notify(env: Env, m: Message, channelIds: string[] | null = null, fetcher: typeof fetch = fetch): Promise<number> {
  const { results } = await env.DB.prepare("SELECT * FROM notification_channels WHERE enabled = 1").all<ChannelRow>();
  const chosen = channelIds ? results.filter((c) => channelIds.includes(c.id)) : results;
  const emailAllowed = m.category !== undefined || !chosen.some((c) => c.kind === "email") || !(await getOpsSettings(env.DB)).email_only_errors;
  const targets = emailAllowed ? chosen : chosen.filter((c) => c.kind !== "email");
  let ok = 0;
  for (const ch of targets) {
    try {
      await deliver(env, ch, m, fetcher);
      ok++;
      await env.DB.prepare("UPDATE notification_channels SET last_sent_at = ?, last_error = NULL WHERE id = ?").bind(Date.now(), ch.id).run();
    } catch (err) {
      const msg = String((err as Error).message ?? err).slice(0, 160);
      console.error(JSON.stringify({ msg: "notify_failed", channel: ch.id, kind: ch.kind, error: msg }));
      await env.DB.prepare("UPDATE notification_channels SET last_error = ? WHERE id = ?").bind(msg, ch.id).run();
    }
  }
  return ok;
}

export async function testChannel(env: Env, id: string, fetcher: typeof fetch = fetch) {
  const ch = await env.DB.prepare("SELECT * FROM notification_channels WHERE id = ?").bind(id).first<ChannelRow>();
  if (!ch) throw new ApiError(404, "not_found", "channel not found");
  try {
    await deliver(env, ch, { title: "Test from Pulse", text: `This is a test message for “${ch.name}”. If you can read it, alerts will arrive here.`, url: env.PUBLIC_ORIGIN, severity: "info" }, fetcher);
    await env.DB.prepare("UPDATE notification_channels SET last_sent_at = ?, last_error = NULL WHERE id = ?").bind(Date.now(), id).run();
    return { sent: true, error: null };
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 160);
    await env.DB.prepare("UPDATE notification_channels SET last_error = ? WHERE id = ?").bind(msg, id).run();
    return { sent: false, error: msg };
  }
}

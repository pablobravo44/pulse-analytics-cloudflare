// Alert and digest emails through the send_email binding (free to verified destination addresses).
import { EmailMessage } from "cloudflare:email";
import type { Env } from "../env.ts";
import { getOpsSettings } from "../lib/settings.ts";

function encodeHeader(s: string): string {
  // RFC 2047 for non-ASCII subjects.
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;
}

function base64Lines(s: string): string {
  const b = btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  return b.replace(/.{1,76}/g, (m) => m + "\r\n");
}

export function buildMime(from: string, to: string, subject: string, text: string, html?: string): string {
  const id = `<${crypto.randomUUID()}@${from.split("@")[1]}>`;
  const head = [`From: Pulse <${from}>`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, `Message-ID: ${id}`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0"];
  if (!html) {
    return [...head, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lines(text)].join("\r\n");
  }
  const b = `pulse-${crypto.randomUUID()}`;
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(text),
    `--${b}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(html),
    `--${b}--`,
    "",
  ].join("\r\n");
}

/** "error" mail always goes out; a "notice" is skipped while `email_only_errors` is on (the default). */
export type MailKind = "error" | "notice";

export async function sendMail(env: Env, subject: string, text: string, html?: string, kind: MailKind = "error"): Promise<boolean> {
  if (kind === "notice" && (await getOpsSettings(env.DB)).email_only_errors) {
    console.log(JSON.stringify({ msg: "email_skipped_not_error", subject }));
    return false;
  }
  if (!env.SEND_EMAIL || !env.ALERT_EMAIL) {
    console.warn(JSON.stringify({ msg: "email_not_configured", subject }));
    return false;
  }
  const from = env.ALERT_FROM ?? `alerts@${new URL(env.PUBLIC_ORIGIN).hostname}`;
  await env.SEND_EMAIL.send(new EmailMessage(from, env.ALERT_EMAIL, buildMime(from, env.ALERT_EMAIL, subject, text, html)));
  return true;
}

// Traffic channel classification. Order of rules matters.

export const CHANNELS = [
  "AI Assistants",
  "Paid Search",
  "Paid Social",
  "Email",
  "Organic Search",
  "Organic Social",
  "Referral",
  "Direct",
] as const;
export type Channel = (typeof CHANNELS)[number];

/** Referrer spam that never brings real visitors; dropped at ingest like bots. */
export const SPAM_REFERRERS = ["semalt.com", "buttons-for-website.com", "darodar.com", "best-seo-offer.com", "ilovevitaly.com", "priceg.com", "hulfingtonpost.com", "o-o-6-o-o.com", "free-share-buttons.com", "traffic2money.com", "get-free-traffic-now.com"];

export const AI_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "chat.deepseek.com",
  "you.com",
  "phind.com",
  "meta.ai",
  "grok.com",
  "mistral.ai",
];

const AI_UTM = new Set([...AI_HOSTS, "chatgpt", "openai", "perplexity", "claude", "gemini", "copilot", "deepseek", "grok", "mistral", "phind"]);

const SEARCH = ["google", "bing", "duckduckgo", "ecosia", "yahoo", "yandex", "baidu", "search.brave", "qwant", "startpage"];

const SOCIAL = [
  "facebook.com",
  "fb.com",
  "m.facebook.com",
  "l.facebook.com",
  "lm.facebook.com",
  "instagram.com",
  "l.instagram.com",
  "x.com",
  "twitter.com",
  "t.co",
  "linkedin.com",
  "lnkd.in",
  "reddit.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "pinterest.com",
  "pinterest.es",
  "pin.it",
  "whatsapp.com",
  "wa.me",
  "web.whatsapp.com",
  "t.me",
  "telegram.org",
  "threads.net",
  "threads.com",
  "bsky.app",
  "mastodon.social",
];
const SOCIAL_UTM = new Set(["facebook", "fb", "instagram", "ig", "twitter", "x", "linkedin", "reddit", "youtube", "tiktok", "pinterest", "whatsapp", "telegram", "threads", "bluesky", "mastodon"]);

const WEBMAIL = ["mail.google.com", "outlook.live.com", "outlook.office.com", "mail.yahoo.com", "mail.proton.me", "webmail."];

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isAiHost(host: string | null | undefined): boolean {
  return !!host && hostMatches(host, AI_HOSTS);
}

function isSearchHost(host: string): boolean {
  // google.com, google.es, www.google.co.uk, search.brave.com, ...
  const labels = host.split(".");
  return SEARCH.some((s) => {
    if (s.includes(".")) return host === `${s}.com` || host.endsWith(`.${s}.com`) || host.startsWith(`${s}.`);
    return labels.includes(s) && !host.startsWith("mail.") && !host.startsWith("gemini.");
  });
}

function isSocialHost(host: string): boolean {
  return hostMatches(host, SOCIAL) || /(^|\.)mastodon\./.test(host);
}

export interface ChannelInput {
  referrerHost?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  ownHosts?: readonly string[];
}

export function classifyChannel(input: ChannelInput): Channel {
  const host = (input.referrerHost ?? "").toLowerCase().replace(/^www\./, "");
  const src = (input.utmSource ?? "").toLowerCase();
  const med = (input.utmMedium ?? "").toLowerCase();
  const own = (input.ownHosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, ""));
  const external = host && !own.some((o) => host === o || host.endsWith(`.${o}`));

  if ((external && isAiHost(host)) || AI_UTM.has(src)) return "AI Assistants";

  const paid = /^(cpc|ppc|paid.*|cpm|cpv|cpa|display)$/.test(med);
  if (paid) {
    if ((external && isSocialHost(host)) || SOCIAL_UTM.has(src)) return "Paid Social";
    return "Paid Search";
  }

  if (med === "email" || med === "e-mail" || med === "newsletter" || (external && hostMatches(host, WEBMAIL)) || host.startsWith("webmail."))
    return "Email";

  if (external && isSearchHost(host)) return "Organic Search";
  if ((external && isSocialHost(host)) || SOCIAL_UTM.has(src) || med === "social") return "Organic Social";
  if (external) return "Referral";
  if (src) return "Referral";
  return "Direct";
}

/** Map Rybbit's channel names onto ours (used by the importer). */
export function mapRybbitChannel(ch: string | null | undefined, input: ChannelInput): Channel {
  const own = classifyChannel(input);
  if (own === "AI Assistants") return own;
  switch ((ch ?? "").toLowerCase()) {
    case "direct":
      return "Direct";
    case "organic search":
      return "Organic Search";
    case "organic social":
      return "Organic Social";
    case "paid search":
      return "Paid Search";
    case "paid social":
      return "Paid Social";
    case "email":
      return "Email";
    case "referral":
      return "Referral";
    default:
      return own;
  }
}

/**
 * Named traffic sources ("Google", "Facebook", "ChatGPT"…) for the `source_name` dimension, so a
 * channel can be split by engine or network. First match wins: referrer host rules, then utm_source.
 * Host patterns: "x.com" matches the host and its subdomains; "google.*" matches any TLD.
 */
export const SOURCE_NAMES: readonly { name: string; hosts: readonly string[]; utm?: readonly string[] }[] = [
  { name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"], utm: ["chatgpt", "chatgpt.com", "openai"] },
  { name: "Perplexity", hosts: ["perplexity.ai"], utm: ["perplexity", "perplexity.ai"] },
  { name: "Claude", hosts: ["claude.ai"], utm: ["claude", "claude.ai"] },
  { name: "Gemini", hosts: ["gemini.google.com"], utm: ["gemini"] },
  { name: "Copilot", hosts: ["copilot.microsoft.com"], utm: ["copilot"] },
  { name: "DeepSeek", hosts: ["chat.deepseek.com"], utm: ["deepseek"] },
  { name: "Grok", hosts: ["grok.com"], utm: ["grok"] },
  { name: "Mistral", hosts: ["mistral.ai"], utm: ["mistral"] },
  { name: "Phind", hosts: ["phind.com"], utm: ["phind"] },
  { name: "You.com", hosts: ["you.com"] },
  { name: "Meta AI", hosts: ["meta.ai"] },
  { name: "Gmail", hosts: ["mail.google.com"], utm: ["gmail"] },
  { name: "Outlook", hosts: ["outlook.live.com", "outlook.office.com"], utm: ["outlook"] },
  { name: "Yahoo Mail", hosts: ["mail.yahoo.com"] },
  { name: "Proton Mail", hosts: ["mail.proton.me"] },
  { name: "Google", hosts: ["google.*"], utm: ["google"] },
  { name: "Bing", hosts: ["bing.com"], utm: ["bing"] },
  { name: "DuckDuckGo", hosts: ["duckduckgo.com"], utm: ["duckduckgo"] },
  { name: "Ecosia", hosts: ["ecosia.org"], utm: ["ecosia"] },
  { name: "Yahoo", hosts: ["yahoo.*"], utm: ["yahoo"] },
  { name: "Yandex", hosts: ["yandex.*", "ya.ru"], utm: ["yandex"] },
  { name: "Baidu", hosts: ["baidu.com"], utm: ["baidu"] },
  { name: "Brave Search", hosts: ["search.brave.com"] },
  { name: "Qwant", hosts: ["qwant.com"], utm: ["qwant"] },
  { name: "Startpage", hosts: ["startpage.com"], utm: ["startpage"] },
  { name: "Facebook", hosts: ["facebook.com", "fb.com"], utm: ["facebook", "fb", "facebook.com"] },
  { name: "Instagram", hosts: ["instagram.com"], utm: ["instagram", "ig"] },
  { name: "X", hosts: ["x.com", "twitter.com", "t.co"], utm: ["twitter", "x"] },
  { name: "LinkedIn", hosts: ["linkedin.com", "lnkd.in"], utm: ["linkedin"] },
  { name: "Reddit", hosts: ["reddit.com"], utm: ["reddit"] },
  { name: "YouTube", hosts: ["youtube.com", "youtu.be"], utm: ["youtube"] },
  { name: "TikTok", hosts: ["tiktok.com"], utm: ["tiktok"] },
  { name: "Pinterest", hosts: ["pinterest.*", "pin.it"], utm: ["pinterest"] },
  { name: "WhatsApp", hosts: ["whatsapp.com", "wa.me"], utm: ["whatsapp"] },
  { name: "Telegram", hosts: ["t.me", "telegram.org"], utm: ["telegram"] },
  { name: "Threads", hosts: ["threads.net", "threads.com"], utm: ["threads"] },
  { name: "Bluesky", hosts: ["bsky.app"], utm: ["bluesky"] },
  { name: "Mastodon", hosts: ["mastodon.*"], utm: ["mastodon"] },
  { name: "Hacker News", hosts: ["news.ycombinator.com"], utm: ["hn", "hackernews"] },
  { name: "GitHub", hosts: ["github.com"], utm: ["github"] },
];

/**
 * SQL for `source_name` over a referrer host and utm_source column. Patterns are code constants,
 * checked against a strict charset, so inlining them is safe. Unknown sources fall back to the
 * host (without www.), then the raw utm_source; direct visits are NULL.
 */
export function sourceNameSql(hostCol: string, utmCol: string): string {
  const lit = (s: string) => {
    if (!/^[a-z0-9.%-]+$/.test(s)) throw new Error(`bad source pattern ${s}`);
    return `'${s}'`;
  };
  const h = `LOWER(${hostCol})`;
  const u = `LOWER(${utmCol})`;
  const hostCond = (p: string) =>
    p.endsWith(".*")
      ? `(${h} LIKE ${lit(`${p.slice(0, -1)}%`)} OR ${h} LIKE ${lit(`%.${p.slice(0, -1)}%`)})`
      : `(${h} = ${lit(p)} OR ${h} LIKE ${lit(`%.${p}`)})`;
  const name = (n: string) => `'${n.replace(/'/g, "''")}'`;
  const byHost = SOURCE_NAMES.map((s) => `WHEN ${s.hosts.map(hostCond).join(" OR ")} THEN ${name(s.name)}`);
  const byUtm = SOURCE_NAMES.filter((s) => s.utm?.length).map((s) => `WHEN ${u} IN (${s.utm!.map(lit).join(", ")}) THEN ${name(s.name)}`);
  const fallback = `COALESCE(NULLIF(CASE WHEN ${h} LIKE 'www.%' THEN substr(${h}, 5) ELSE ${h} END, ''), NULLIF(${utmCol}, ''))`;
  return `(CASE ${[...byHost, ...byUtm].join(" ")} ELSE ${fallback} END)`;
}

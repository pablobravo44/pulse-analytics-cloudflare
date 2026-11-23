// Every icon in the dashboard comes from here: Phosphor for the interface (regular weight, filled for the active nav
// item), real flags for countries, brand logos for well-known sources, browsers and systems, and for any other referrer
// its favicon fetched by the Worker (/icons/favicon/<host>, never a third party).
import { useState } from "react";
import type { Icon as PhosphorIcon, IconProps } from "@phosphor-icons/react";
import {
  AppleLogo,
  ArrowRight,
  ArrowSquareOut,
  ArrowsClockwise,
  BellRinging,
  BookmarkSimple,
  BookOpen,
  Broadcast,
  Bug,
  CalendarBlank,
  CalendarCheck,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChartLine,
  Check,
  Compass,
  Copy,
  CursorClick,
  Desktop,
  DeviceMobile,
  Devices,
  DeviceTablet,
  DownloadSimple,
  EnvelopeSimple,
  Eye,
  FileText,
  FunnelSimple,
  Gauge,
  Gear,
  Globe,
  GlobeHemisphereWest,
  GoogleChromeLogo,
  Key,
  LinkedinLogo,
  LinkSimple,
  List,
  MagnifyingGlass,
  Megaphone,
  MicrosoftOutlookLogo,
  Monitor,
  Moon,
  Note,
  OpenAiLogo,
  PaperPlaneTilt,
  Path,
  Pause,
  Play,
  Plus,
  Pulse,
  Repeat,
  Robot,
  ShareNetwork,
  SidebarSimple,
  SignOut,
  SlackLogo,
  SlidersHorizontal,
  Sparkle,
  Sun,
  Target,
  Translate,
  TrendUp,
  UsersThree,
  WindowsLogo,
  X as XIcon,
  RocketLaunch,
  FlagBanner,
  WarningCircle,
  NoteBlank,
} from "@phosphor-icons/react";
// Named imports only, so the bundle carries just these logos (the package has thousands).
import {
  siAndroid,
  siBaidu,
  siBluesky,
  siBrave,
  siClaude,
  siDeepseek,
  siDiscord,
  siDuckduckgo,
  siEcosia,
  siFacebook,
  siFeedly,
  siFirefoxbrowser,
  siFlipboard,
  siGithub,
  siGmail,
  siGoogle,
  siGooglechrome,
  siGooglegemini,
  siGooglenews,
  siInstagram,
  siIos,
  siKagi,
  siLinux,
  siMacos,
  siMastodon,
  siMedium,
  siMistralai,
  siNaver,
  siOpera,
  siPerplexity,
  siPinterest,
  siProtonmail,
  siQuora,
  siQwant,
  siReddit,
  siSafari,
  siSamsung,
  siStartpage,
  siSubstack,
  siTelegram,
  siThreads,
  siTiktok,
  siTumblr,
  siTwitch,
  siUbuntu,
  siVk,
  siWhatsapp,
  siX,
  siYcombinator,
  siYoutube,
} from "simple-icons";

/** The icon component type used across the dashboard (Phosphor's). */
export type LucideIcon = PhosphorIcon;
export type { IconProps };

// The interface set, under the names the pages use.
export {
  Pulse as Activity,
  ArrowRight,
  BellRinging as BellPlus,
  BookmarkSimple as Bookmark,
  BookOpen,
  Bug,
  CalendarCheck as CalendarClock,
  CalendarBlank as CalendarDays,
  ChartLine as ChartSpline,
  Check,
  CaretDown as ChevronDown,
  CaretLeft as ChevronLeft,
  CaretRight as ChevronRight,
  Compass,
  Copy,
  DownloadSimple as Download,
  ArrowSquareOut as ExternalLink,
  Eye,
  FileText,
  FunnelSimple as Filter,
  Gauge,
  GlobeHemisphereWest as Globe,
  Key as KeyRound,
  LinkSimple as Link2,
  FunnelSimple as ListFilter,
  SignOut as LogOut,
  List as Menu,
  Monitor,
  Devices as MonitorSmartphone,
  Moon,
  CursorClick as MousePointerClick,
  Pause,
  Play,
  Plus,
  Broadcast as Radio,
  ArrowsClockwise as RefreshCw,
  Repeat,
  Path as Route,
  PaperPlaneTilt as Send,
  Gear as Settings,
  SlidersHorizontal,
  Sparkle as Sparkles,
  Note as StickyNote,
  Sun,
  Target,
  TrendUp as TrendingUp,
  UsersThree as UsersRound,
  XIcon as X,
  MagnifyingGlass,
  EnvelopeSimple,
  Megaphone,
  Robot,
  ShareNetwork,
  Globe as GlobeSimple,
  RocketLaunch,
  FlagBanner,
  WarningCircle,
  NoteBlank,
  SidebarSimple,
  Translate,
};

// ---------- Flags ----------

// Each flag is its own small SVG file, fetched only when a row shows it.
const FLAG_URLS = import.meta.glob("../../../../node_modules/country-flag-icons/3x2/*.svg", {
  eager: true,
  query: "?no-inline",
  import: "default",
}) as Record<string, string>;
const flagUrl = (code: string) =>
  FLAG_URLS[`../../../../node_modules/country-flag-icons/3x2/${code.toUpperCase()}.svg`];

export function Flag({ code, className = "" }: { code: string | null | undefined; className?: string }) {
  const url = code ? flagUrl(code) : undefined;
  if (!url)
    return (
      <GlobeHemisphereWest size={16} aria-hidden="true" className={`shrink-0 text-ink-3 ${className}`} />
    );
  return (
    <img
      src={url}
      alt=""
      width={18}
      height={12}
      loading="lazy"
      className={`h-3 w-[18px] shrink-0 rounded-[3px] object-cover shadow-[0_0_0_1px_var(--line)] ${className}`}
    />
  );
}

// ---------- Brand logos ----------

type SimpleIcon = { path: string; title: string };
const BRAND: Record<string, SimpleIcon> = {
  google: siGoogle,
  duckduckgo: siDuckduckgo,
  ecosia: siEcosia,
  brave: siBrave,
  qwant: siQwant,
  startpage: siStartpage,
  kagi: siKagi,
  baidu: siBaidu,
  naver: siNaver,
  perplexity: siPerplexity,
  claude: siClaude,
  gemini: siGooglegemini,
  mistral: siMistralai,
  deepseek: siDeepseek,
  facebook: siFacebook,
  instagram: siInstagram,
  x: siX,
  reddit: siReddit,
  youtube: siYoutube,
  tiktok: siTiktok,
  pinterest: siPinterest,
  telegram: siTelegram,
  whatsapp: siWhatsapp,
  mastodon: siMastodon,
  bluesky: siBluesky,
  threads: siThreads,
  hackernews: siYcombinator,
  github: siGithub,
  gmail: siGmail,
  discord: siDiscord,
  medium: siMedium,
  substack: siSubstack,
  googlenews: siGooglenews,
  vk: siVk,
  tumblr: siTumblr,
  quora: siQuora,
  twitch: siTwitch,
  flipboard: siFlipboard,
  feedly: siFeedly,
  proton: siProtonmail,
  chrome: siGooglechrome,
  firefox: siFirefoxbrowser,
  safari: siSafari,
  opera: siOpera,
  samsung: siSamsung,
  macos: siMacos,
  ios: siIos,
  android: siAndroid,
  linux: siLinux,
  ubuntu: siUbuntu,
};
// Brands simple-icons doesn't carry: Phosphor's logo set.
const BRAND_PHOSPHOR: Record<string, PhosphorIcon> = {
  chatgpt: OpenAiLogo,
  linkedin: LinkedinLogo,
  slack: SlackLogo,
  outlook: MicrosoftOutlookLogo,
  windows: WindowsLogo,
  apple: AppleLogo,
  chromeos: GoogleChromeLogo,
};

/** Referrer host (without www.) → brand key. Hosts of a service's other domains point to the same key. */
const HOST_BRAND: [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/^news\.google\./, "googlenews"],
  [/^mail\.google\.com$/, "gmail"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo"],
  [/(^|\.)ecosia\.org$/, "ecosia"],
  [/(^|\.)search\.brave\.com$/, "brave"],
  [/(^|\.)qwant\.com$/, "qwant"],
  [/(^|\.)startpage\.com$/, "startpage"],
  [/(^|\.)kagi\.com$/, "kagi"],
  [/(^|\.)baidu\.com$/, "baidu"],
  [/(^|\.)naver\.com$/, "naver"],
  [/^(chatgpt\.com|chat\.openai\.com)$/, "chatgpt"],
  [/(^|\.)perplexity\.ai$/, "perplexity"],
  [/^claude\.ai$/, "claude"],
  [/^gemini\.google\.com$/, "gemini"],
  [/(^|\.)chat\.mistral\.ai$/, "mistral"],
  [/(^|\.)deepseek\.com$/, "deepseek"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "facebook"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/^(x\.com|twitter\.com|t\.co)$/, "x"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)pinterest\.[a-z.]+$/, "pinterest"],
  [/^(t\.me|telegram\.org|web\.telegram\.org)$/, "telegram"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "whatsapp"],
  [/(^|\.)bsky\.app$/, "bluesky"],
  [/(^|\.)threads\.(net|com)$/, "threads"],
  [/^news\.ycombinator\.com$/, "hackernews"],
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)discord\.(com|gg)$/, "discord"],
  [/(^|\.)medium\.com$/, "medium"],
  [/(^|\.)substack\.com$/, "substack"],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "linkedin"],
  [/(^|\.)slack\.com$/, "slack"],
  [/^outlook\.(live|office)\.com$/, "outlook"],
  [/(^|\.)vk\.com$/, "vk"],
  [/(^|\.)tumblr\.com$/, "tumblr"],
  [/(^|\.)quora\.com$/, "quora"],
  [/(^|\.)twitch\.tv$/, "twitch"],
  [/(^|\.)flipboard\.com$/, "flipboard"],
  [/(^|\.)feedly\.com$/, "feedly"],
  [/(^|\.)proton\.me$/, "proton"],
];

/** Named sources (source_name dimension, channel names) → brand key. */
const NAME_BRAND: Record<string, string> = {
  Google: "google",
  Bing: "",
  DuckDuckGo: "duckduckgo",
  Ecosia: "ecosia",
  Brave: "brave",
  Qwant: "qwant",
  Startpage: "startpage",
  Baidu: "baidu",
  Naver: "naver",
  ChatGPT: "chatgpt",
  Perplexity: "perplexity",
  Claude: "claude",
  Gemini: "gemini",
  "Le Chat": "mistral",
  DeepSeek: "deepseek",
  Facebook: "facebook",
  Instagram: "instagram",
  X: "x",
  Twitter: "x",
  Reddit: "reddit",
  YouTube: "youtube",
  TikTok: "tiktok",
  Pinterest: "pinterest",
  Telegram: "telegram",
  WhatsApp: "whatsapp",
  Mastodon: "mastodon",
  Bluesky: "bluesky",
  Threads: "threads",
  "Hacker News": "hackernews",
  GitHub: "github",
  Gmail: "gmail",
  Discord: "discord",
  Medium: "medium",
  Substack: "substack",
  LinkedIn: "linkedin",
  Slack: "slack",
  Outlook: "outlook",
  Chrome: "chrome",
  "Mobile Chrome": "chrome",
  "Chrome WebView": "chrome",
  Chromium: "chrome",
  Firefox: "firefox",
  "Mobile Firefox": "firefox",
  Safari: "safari",
  "Mobile Safari": "safari",
  Opera: "opera",
  "Samsung Internet": "samsung",
  "Brave Browser": "brave",
  "Mac OS": "macos",
  macOS: "macos",
  iOS: "ios",
  iPadOS: "ios",
  Android: "android",
  Linux: "linux",
  Ubuntu: "ubuntu",
  Windows: "windows",
  "Chrome OS": "chromeos",
  ChromeOS: "chromeos",
};

export function brandFor(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value in NAME_BRAND) return NAME_BRAND[value] || null;
  const host = value.toLowerCase().replace(/^www\./, "");
  for (const [re, key] of HOST_BRAND) if (re.test(host)) return key;
  return null;
}

function BrandGlyph({ brand, size = 16 }: { brand: string; size?: number }) {
  const P = BRAND_PHOSPHOR[brand];
  if (P) return <P size={size} weight="fill" aria-hidden="true" className="shrink-0 text-ink-2" />;
  const icon = BRAND[brand];
  if (!icon) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size - 2}
      height={size - 2}
      aria-hidden="true"
      className="shrink-0 text-ink-2"
      fill="currentColor"
    >
      <path d={icon.path} />
    </svg>
  );
}

const HOSTLIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
let faviconsAllowed = true;
/** Share pages have no session, so they can't use the favicon route: they get a generic glyph instead. */
export function setFaviconsAllowed(v: boolean) {
  faviconsAllowed = v;
}

/**
 * The icon of a traffic source (referrer host, source name or channel value): a brand logo when we know the brand,
 * otherwise the host's favicon through the Worker, otherwise a globe.
 */
export function SourceIcon({ value, size = 16 }: { value: string | null | undefined; size?: number }) {
  const brand = brandFor(value);
  if (brand) {
    const g = <BrandGlyph brand={brand} size={size} />;
    if (g) return g;
  }
  if (value && faviconsAllowed && HOSTLIKE.test(value)) return <Favicon host={value} size={size} />;
  return <Globe size={size} aria-hidden="true" className="shrink-0 text-ink-3" />;
}

function Favicon({ host, size }: { host: string; size: number }) {
  // A host without an icon (or an unreachable one) falls back to the globe, never a blank gap in the list.
  const [failed, setFailed] = useState(false);
  if (failed) return <Globe size={size} aria-hidden="true" className="shrink-0 text-ink-3" />;
  return (
    <img
      src={`/icons/favicon/${encodeURIComponent(host.toLowerCase().replace(/^www\./, ""))}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-[3px]"
      onError={() => setFailed(true)}
    />
  );
}

/** Browser or operating system logo (falls back to a neutral glyph). */
export function TechIcon({ value, size = 16 }: { value: string | null | undefined; size?: number }) {
  const brand = brandFor(value);
  if (brand) return <BrandGlyph brand={brand} size={size} />;
  return <Desktop size={size} aria-hidden="true" className="shrink-0 text-ink-3" />;
}

export function DeviceIcon({ value, size = 16 }: { value: string | null | undefined; size?: number }) {
  const I = value === "mobile" ? DeviceMobile : value === "tablet" ? DeviceTablet : Desktop;
  return <I size={size} aria-hidden="true" className="shrink-0 text-ink-2" />;
}

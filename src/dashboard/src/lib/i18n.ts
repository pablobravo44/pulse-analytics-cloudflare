// Interface language: the browser's (English or Spanish), English when it is neither; a person can pin one
// (localStorage "pulse-lang", a per-viewer convenience). Strings are written in English and looked up in the Spanish
// dictionaries, so a missing entry shows the English text instead of a key. Dates, numbers and country names use
// Intl in the same language. test/unit/i18n.test.ts fails when a t("…") string has no Spanish entry.
import { ES } from "./i18n/es.ts";

export type Lang = "en" | "es";

/** The browser's language, as one the interface speaks. */
export function browserLang(): Lang {
  const first =
    (typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language) : "en") || "en";
  return first.toLowerCase().startsWith("es") ? "es" : "en";
}

function detect(): Lang {
  try {
    const pinned = localStorage.getItem("pulse-lang");
    if (pinned === "en" || pinned === "es") return pinned;
  } catch {
    /* storage blocked: follow the browser */
  }
  return browserLang();
}

export const lang: Lang = detect();
/** Locale for Intl: Spanish (Spain) or British-style English (day before month, 24-hour clock). */
export const locale = lang === "es" ? "es-ES" : "en-GB";

/** The interface text for `s` (English source) in the current language; `{name}` placeholders take `vars`. */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = lang === "es" ? (ES[s] ?? s) : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** Plural helper: t(n === 1 ? one : many) with {n} filled. */
export function tn(n: number, one: string, many: string): string {
  return t(n === 1 ? one : many, { n });
}

/** Switch the interface language; picking the browser's own language goes back to following the browser. */
export function setLang(l: Lang | null) {
  try {
    if (l && l !== browserLang()) localStorage.setItem("pulse-lang", l);
    else localStorage.removeItem("pulse-lang");
  } catch {
    /* storage blocked */
  }
  location.reload();
}

if (typeof document !== "undefined") document.documentElement.lang = lang;

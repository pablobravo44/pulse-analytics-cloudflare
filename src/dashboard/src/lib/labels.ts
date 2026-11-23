// Display names for values the API returns in English (channel and device names are stable identifiers in the API
// and filters; only what the person reads is translated).
import { locale, t } from "./i18n.ts";

const CHANNELS: Record<string, string> = {
  "AI Assistants": t("AI Assistants"),
  "Paid Search": t("Paid Search"),
  "Paid Social": t("Paid Social"),
  Email: t("Email"),
  "Organic Search": t("Organic Search"),
  "Organic Social": t("Organic Social"),
  Referral: t("Referral"),
  Direct: t("Direct"),
};

/** A channel's name in the interface's language; unknown values as they are. */
export function channelName(v: string | number | null): string {
  if (v === null) return t("Direct");
  return CHANNELS[String(v)] ?? String(v);
}

const DEVICES: Record<string, string> = {
  desktop: t("Desktop"),
  mobile: t("Mobile"),
  tablet: t("Tablet"),
};

/** A device type's name in the interface's language. */
export function deviceName(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return t("Unknown");
  const key = String(v).toLowerCase();
  return DEVICES[key] ?? String(v);
}

const regionNames = (() => {
  try {
    return typeof Intl !== "undefined" && "DisplayNames" in Intl
      ? new Intl.DisplayNames([locale], { type: "region" })
      : null;
  } catch {
    return null;
  }
})();

/** Country name in the interface's language from an ISO-2 code; falls back to the code. */
export function countryName(code: string | null | undefined): string {
  if (!code) return "";
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** First non-wildcard domain of a site, safe for building https:// links. */
export function linkableDomain(domains: string[] | undefined): string | undefined {
  return domains?.find((d) => !d.startsWith("*."));
}

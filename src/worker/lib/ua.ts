import { isbot } from "isbot";
import { UAParser } from "ua-parser-js";

export interface UaInfo {
  device: "desktop" | "mobile" | "tablet" | "other";
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  os_version: string | null;
}

const HEADLESS = /headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|chrome-lighthouse/i;

export function isBotUa(ua: string | null | undefined): boolean {
  if (!ua || ua.length < 20) return true;
  return isbot(ua) || HEADLESS.test(ua);
}

function major(v: string | undefined): string | null {
  if (!v) return null;
  const m = /^(\d+)(?:\.(\d+))?/.exec(v);
  if (!m) return v;
  return m[2] !== undefined && m[2] !== "0" ? `${m[1]}.${m[2]}` : (m[1] ?? null);
}

export function parseUa(ua: string, screenW?: number | null): UaInfo {
  const r = new UAParser(ua).getResult();
  let device: UaInfo["device"];
  const type = r.device.type;
  if (type === "mobile") device = "mobile";
  else if (type === "tablet") device = "tablet";
  else if (!type) device = screenW && screenW < 768 ? "mobile" : "desktop";
  else device = "other";
  return {
    device,
    browser: r.browser.name ?? null,
    browser_version: major(r.browser.version),
    os: r.os.name ?? null,
    os_version: major(r.os.version),
  };
}

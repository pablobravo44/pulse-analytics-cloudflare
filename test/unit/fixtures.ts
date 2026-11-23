import { enrich, type RequestMeta } from "../../src/worker/ingest/enrich.ts";
import type { TrackerPayload } from "../../src/worker/ingest/types.ts";
import { DEFAULT_SETTINGS, type Site } from "../../src/worker/lib/sites.ts";
import { processHit } from "../../src/worker/queue/consumer.ts";

export const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

export const SITE: Site = {
  id: "test",
  name: "Test",
  domains: ["example.com"],
  timezone: "Europe/Madrid",
  settings: DEFAULT_SETTINGS,
  retention_months: 25,
  created_at: 0,
  archived_at: null,
};

export const OTHER: Site = { ...SITE, id: "other", domains: ["other.com"] };

export async function insertSite(db: D1Database, s: Site): Promise<void> {
  await db
    .prepare(
      "INSERT INTO sites (id, name, domains_json, timezone, settings_json, retention_months, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(s.id, s.name, JSON.stringify(s.domains), s.timezone, JSON.stringify(s.settings), s.retention_months, 0)
    .run();
}

export function meta(now: number, over: Partial<RequestMeta> = {}): RequestMeta {
  return {
    ip: "203.0.113.7",
    ua: CHROME,
    origin: null,
    country: "ES",
    region: "CL",
    city: "Valladolid",
    continent: "EU",
    verifiedBot: false,
    dnt: false,
    hosting: false,
    now,
    ...over,
  };
}

/** Enrich and process synchronously (bypasses the queue). */
export async function hit(
  db: D1Database,
  p: Partial<TrackerPayload> & { u: string },
  now: number,
  over: Partial<RequestMeta> = {},
  site: Site = SITE,
) {
  const h = await enrich({ s: site.id, t: "pageview", ...p } as TrackerPayload, site, meta(now, over), "salt-1");
  if (typeof h === "string") return h;
  await processHit(db, h);
  return h;
}

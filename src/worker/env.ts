import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { EnrichedHit } from "./ingest/types.ts";

export interface Env {
  ENVIRONMENT: "production" | "development" | "test";
  PUBLIC_ORIGIN: string;
  RP_ID: string;
  DB: D1Database;
  EVENTS: Queue<EnrichedHit>;
  OAUTH_KV: KVNamespace;
  BACKUPS: R2Bucket;
  ASSETS: Fetcher;
  INGEST_LIMITER: RateLimit;
  API_LIMITER: RateLimit;
  LOGIN_LIMITER: RateLimit;
  /** Injected by workers-oauth-provider on routed requests. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /** Optional: API token for backups, database checks and the size warning (D1 Edit + Account Settings Read). */
  PULSE_OPS_TOKEN?: string;
  /** 32 random bytes, base64: encrypts notification channel secrets (webhook URLs, bot tokens). */
  PULSE_SECRET_KEY?: string;
  CF_ACCOUNT_ID?: string;
  ALERT_EMAIL?: string;
  ALERT_FROM?: string;
  /** Cloudflare Access sign-in (src/worker/auth/access.ts): team domain, application AUD tag, allowed emails (comma-separated). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_EMAILS?: string;
  SEND_EMAIL?: SendEmail;
  OPS_BACKUPS?: R2Bucket;
}

export type Waiter = { waitUntil(p: Promise<unknown>): void };

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

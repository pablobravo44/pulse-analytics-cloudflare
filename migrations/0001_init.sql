-- Pulse initial schema. Never edit after it has been applied; add a new file instead.

CREATE TABLE sites (
  id TEXT PRIMARY KEY,                       -- slug
  name TEXT NOT NULL,
  domains_json TEXT NOT NULL DEFAULT '[]',   -- allowed hostnames (exact or listed subdomain)
  timezone TEXT NOT NULL DEFAULT 'UTC',
  legacy_ids_json TEXT NOT NULL DEFAULT '[]',
  settings_json TEXT NOT NULL DEFAULT '{}',  -- features, query_allowlist, respect_dnt
  retention_months INTEGER NOT NULL DEFAULT 25,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,                       -- ULID or deterministic import hash
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                       -- ms UTC
  local_day TEXT NOT NULL,                   -- YYYY-MM-DD in site tz
  local_hour INTEGER NOT NULL,
  type TEXT NOT NULL,                        -- pageview|event|engagement|outbound|download|vitals|error
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  pageview_id TEXT,
  hostname TEXT,
  pathname TEXT,
  query TEXT,
  title TEXT,
  referrer TEXT,
  referrer_host TEXT,
  channel TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  continent TEXT,
  device TEXT,
  browser TEXT,
  browser_version TEXT,
  os TEXT,
  os_version TEXT,
  screen_w INTEGER,
  screen_h INTEGER,
  language TEXT,
  name TEXT,
  props_json TEXT,
  engaged_ms INTEGER,
  scroll_pct INTEGER,
  url TEXT,
  lcp REAL,
  inp REAL,
  cls REAL,
  fcp REAL,
  ttfb REAL,
  source TEXT NOT NULL DEFAULT 'pulse'
);
CREATE INDEX events_site_ts ON events (site_id, ts);
CREATE INDEX events_site_day ON events (site_id, local_day);
CREATE INDEX events_site_type_day ON events (site_id, type, local_day);
CREATE INDEX events_session ON events (session_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  local_day TEXT NOT NULL,
  entry_path TEXT,
  exit_path TEXT,
  pageviews INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  engaged_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  bounced INTEGER NOT NULL DEFAULT 1,
  hostname TEXT,
  referrer TEXT,
  referrer_host TEXT,
  channel TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  continent TEXT,
  device TEXT,
  browser TEXT,
  browser_version TEXT,
  os TEXT,
  os_version TEXT,
  screen_w INTEGER,
  screen_h INTEGER,
  language TEXT,
  source TEXT NOT NULL DEFAULT 'pulse'
);
CREATE INDEX sessions_visitor ON sessions (site_id, visitor_id, last_seen_at);
CREATE INDEX sessions_site_day ON sessions (site_id, local_day);

CREATE TABLE salts (
  day TEXT PRIMARY KEY,                      -- UTC YYYY-MM-DD
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- pageview|event|outbound
  definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX goals_site ON goals (site_id);

CREATE TABLE funnels (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  window_minutes INTEGER NOT NULL DEFAULT 30,
  created_at INTEGER NOT NULL
);
CREATE INDEX funnels_site ON funnels (site_id);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  site_id TEXT,                              -- NULL = all sites
  ts INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX annotations_site_ts ON annotations (site_id, ts);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL,                        -- owner|admin|viewer
  site_ids_json TEXT,                        -- viewer scope; NULL = all
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,        -- base64url
  public_key TEXT NOT NULL,                  -- base64url COSE key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ua_summary TEXT,
  label TEXT
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,                     -- register|login
  user_id TEXT,
  invite_hash TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  site_ids_json TEXT,                        -- NULL = all sites
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  meta_json TEXT
);
CREATE INDEX audit_log_ts ON audit_log (ts);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  source TEXT NOT NULL,
  range_from TEXT,
  range_to TEXT,
  rows_events INTEGER NOT NULL DEFAULT 0,
  rows_sessions INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  report_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE ingest_stats (
  day TEXT NOT NULL,
  site_id TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  dropped_bot INTEGER NOT NULL DEFAULT 0,
  dropped_invalid INTEGER NOT NULL DEFAULT 0,
  dropped_rate INTEGER NOT NULL DEFAULT 0,
  legacy_hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site_id)
);

CREATE TABLE rollups_daily (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  visitors INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  engaged_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, dimension, value)
);

CREATE TABLE kv_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

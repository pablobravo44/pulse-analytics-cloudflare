-- Notifications, alerts, saved views, share links, tracked links, site search, annotation categories.

-- Where alerts go. Secrets (webhook URLs, bot tokens, signing keys) are AES-GCM encrypted with PULSE_SECRET_KEY;
-- config_hint is a safe preview for lists ("hooks.slack.com/…/9f2c").
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- email | webhook | slack | discord | telegram | ntfy
  name TEXT NOT NULL,
  config_enc TEXT,
  config_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  last_error TEXT
);
-- The existing behavior (email to ALERT_EMAIL) becomes the default channel.
INSERT INTO notification_channels (id, kind, name, config_hint, created_at) VALUES ('email-owner', 'email', 'Email to the owner', 'ALERT_EMAIL', 0);

ALTER TABLE monitors ADD COLUMN channel_ids_json TEXT;         -- NULL = every enabled channel

-- Traffic alerts, evaluated by the 5-minute cron through the query engine.
CREATE TABLE alert_rules (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- above | below | change_pct | no_data | event | new_error
  metric TEXT NOT NULL DEFAULT 'visitors',
  event_name TEXT,
  filters_json TEXT NOT NULL DEFAULT '[]',
  window_min INTEGER NOT NULL DEFAULT 60,
  threshold REAL NOT NULL DEFAULT 0,
  cooldown_min INTEGER NOT NULL DEFAULT 60,
  channel_ids_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_value REAL,
  last_checked_at INTEGER,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX alert_rules_site ON alert_rules (site_id);
CREATE TABLE alert_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL,
  message TEXT NOT NULL
);
CREATE INDEX alert_events_rule_ts ON alert_events (rule_id, ts);

-- Saved filter sets ("segments"), shared by everyone who can see the site.
CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '[]',
  date_range TEXT,
  compare TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX saved_views_site ON saved_views (site_id);

-- Read-only public links to a site's dashboard. Only the token's hash is stored.
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  view_id TEXT,                    -- optional saved view whose filters are enforced
  password_hash TEXT,              -- sha256(salt:password)
  expires_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX share_links_site ON share_links (site_id);

-- Short links /l/<slug> that record a link_click event and redirect.
CREATE TABLE links (
  slug TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  target TEXT NOT NULL,
  campaign TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX links_site ON links (site_id);

ALTER TABLE annotations ADD COLUMN category TEXT;        -- deploy | content | campaign | incident | other
ALTER TABLE events ADD COLUMN search_term TEXT;          -- site search, from the site's search_params

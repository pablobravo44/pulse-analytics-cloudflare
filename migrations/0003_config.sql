-- Owner-editable configuration: settings, editable keys/users, self-serve sites, editable status checks.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,            -- e.g. 'ops'
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Hits whose hostname isn't one of the site's domains (install diagnostics).
ALTER TABLE ingest_stats ADD COLUMN dropped_host INTEGER NOT NULL DEFAULT 0;

ALTER TABLE invites ADD COLUMN site_ids_json TEXT;
ALTER TABLE api_keys ADD COLUMN updated_at INTEGER;

-- Internal sites are flagged instead of being filtered by id in code.
UPDATE sites SET settings_json = json_set(settings_json, '$.hidden', json('true')) WHERE id = 'pulse-smoke';

-- Status checks: per-check configuration, schedule, pause, grouping by site.
ALTER TABLE monitors ADD COLUMN site_id TEXT;
ALTER TABLE monitors ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE monitors ADD COLUMN interval_min INTEGER NOT NULL DEFAULT 5;
ALTER TABLE monitors ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE monitors ADD COLUMN failures_to_alert INTEGER NOT NULL DEFAULT 2;
ALTER TABLE monitors ADD COLUMN degraded_ms INTEGER;
ALTER TABLE monitors ADD COLUMN paused_until INTEGER;
ALTER TABLE monitors ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
ALTER TABLE monitors ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitors ADD COLUMN last_ping_at INTEGER;
ALTER TABLE monitors ADD COLUMN updated_at INTEGER;
ALTER TABLE incidents ADD COLUMN note TEXT;
ALTER TABLE incidents ADD COLUMN acknowledged_at INTEGER;
ALTER TABLE incidents ADD COLUMN acknowledged_by TEXT;

UPDATE monitors SET sort = 100 WHERE id IN ('pulse-healthz', 'pulse-ingest');

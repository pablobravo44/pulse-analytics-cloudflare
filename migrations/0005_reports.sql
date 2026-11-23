-- Scheduled reports, strict funnels, embeddable share links, more ingest counters.

-- Hits dropped by the site's own exclusion rules (paths, hostnames, countries), and revenue values ignored
-- because their currency didn't match the site's revenue_currency (the event itself is kept).
ALTER TABLE ingest_stats ADD COLUMN dropped_excluded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_stats ADD COLUMN revenue_ignored INTEGER NOT NULL DEFAULT 0;

-- Funnel step order: flexible (other pages may happen between steps; the old behavior) or strict.
ALTER TABLE funnels ADD COLUMN step_order TEXT NOT NULL DEFAULT 'flexible';

-- Origins allowed to embed a share link in an iframe (space-separated https origins). NULL = no embedding.
ALTER TABLE share_links ADD COLUMN embed_origins TEXT;

-- Scheduled reports, sent through notification channels. The weekly ops digest becomes the first report.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site_ids_json TEXT,                   -- NULL = every site with include_in_digest on
  frequency TEXT NOT NULL DEFAULT 'weekly',   -- weekly | monthly
  weekday INTEGER NOT NULL DEFAULT 1,   -- weekly: 0 = Sunday … 6 = Saturday
  day_of_month INTEGER NOT NULL DEFAULT 1, -- monthly: 1–28
  hour INTEGER NOT NULL DEFAULT 8,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  sections_json TEXT NOT NULL DEFAULT '["kpis","pages","sources","ai","goals","movers"]',
  include_ops INTEGER NOT NULL DEFAULT 0,
  channel_ids_json TEXT,                -- NULL = every enabled channel
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER,                 -- any send, including "send now"
  last_period TEXT,                     -- first day of the last period sent on schedule (once per period)
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

-- Carry over the digest schedule from ops settings (defaults: Monday 08:00 Europe/Madrid), email only as before.
INSERT INTO reports (id, name, frequency, weekday, hour, timezone, include_ops, channel_ids_json, enabled, created_by, created_at)
SELECT 'weekly-digest', 'Weekly digest', 'weekly',
  COALESCE(json_extract(o.v, '$.digest.weekday'), 1),
  COALESCE(json_extract(o.v, '$.digest.hour'), 8),
  COALESCE(json_extract(o.v, '$.digest.timezone'), 'Europe/Madrid'),
  1, '["email-owner"]',
  CASE WHEN json_extract(o.v, '$.digest.enabled') = 0 THEN 0 ELSE 1 END,
  'migration', 0
FROM (SELECT (SELECT value_json FROM settings WHERE key = 'ops') AS v) o;

-- The last digest send carries over so the first run doesn't send the same week twice. The old digest covered
-- Monday–Sunday of the previous week, which is the period the report would claim on the following Monday.
UPDATE reports SET
  last_sent_at = (SELECT json_extract(value, '$.at') FROM kv_meta WHERE key = 'last_digest'),
  last_period = (SELECT date(json_extract(value, '$.range.to'), '+1 day', 'weekday 1', '-7 days') FROM kv_meta WHERE key = 'last_digest')
WHERE id = 'weekly-digest';

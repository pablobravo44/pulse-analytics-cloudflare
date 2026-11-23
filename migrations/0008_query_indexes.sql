-- Measured on production D1 (wrangler d1 insights, 3 days to 2026-11-06): the two error-report queries were 87% of all
-- rows read. They filter on type = 'error' and walked every event of the site in the range through events_site_ts.
-- Partial, so ordinary events (pageviews, engagement) skip it on ingest and pay no extra write.
CREATE INDEX IF NOT EXISTS events_errors_site_ts ON events (site_id, ts) WHERE type = 'error';

-- The retention sweep in ops/alerts.ts runs with every alert check and scanned the whole table each time.
CREATE INDEX IF NOT EXISTS alert_events_ts ON alert_events (ts);

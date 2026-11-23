-- Data-quality annotations: `affects` lists (JSON) the metrics whose definition or source changed at that moment, so
-- reports don't show their change across it (src/worker/lib/annotations.ts).
ALTER TABLE annotations ADD COLUMN affects TEXT;

-- Where each finished import ends, Pulse's own tracking begins: Rybbit and Pulse define bounce and time measures
-- differently (the overview showed a -42.5 % bounce rate that was only this switch).
INSERT OR IGNORE INTO annotations (id, site_id, ts, title, body, url, category, affects, created_by, created_at)
SELECT 'dq_import_' || site_id, site_id, CAST(strftime('%s', range_to, '+1 day') AS INTEGER) * 1000,
  'Data before this comes from ' || source,
  'Imported ' || source || ' data ends here and Pulse''s own tracking begins. Bounce rate and time measures are defined differently, so their change across this point isn''t shown.',
  NULL, 'data', '["bounce_rate","avg_engaged_time","avg_session_duration","views_per_session"]', 'pulse', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM imports WHERE status = 'done' AND range_to IS NOT NULL
  AND range_to = (SELECT MAX(i2.range_to) FROM imports i2 WHERE i2.site_id = imports.site_id AND i2.status = 'done')
GROUP BY site_id;

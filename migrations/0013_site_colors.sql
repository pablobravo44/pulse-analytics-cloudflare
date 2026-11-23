-- Store each existing site's colour (the one it shows today: the next of the six by creation order), so adding or
-- removing a site never repaints the others (src/worker/lib/sites.ts siteColorSlot / pickSiteColor).
UPDATE sites SET settings_json = json_set(COALESCE(settings_json, '{}'), '$.color', (
  SELECT CASE (r.n - 1) % 6 WHEN 0 THEN 'violet' WHEN 1 THEN 'teal' WHEN 2 THEN 'amber' WHEN 3 THEN 'magenta' WHEN 4 THEN 'blue' ELSE 'olive' END
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n FROM sites) r WHERE r.id = sites.id
))
WHERE json_extract(COALESCE(settings_json, '{}'), '$.color') IS NULL;

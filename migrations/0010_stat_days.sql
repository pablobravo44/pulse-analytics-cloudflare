-- Daily rollups read by the query engine (src/worker/query/rollup.ts; docs/PERFORMANCE.md).
-- One row per site × dimension × local day × value with additive parts of every metric, plus the share of each
-- session-level part that continues from the day before (c_*), so sums over several days count a session or a
-- visitor that crosses midnight once, exactly like the raw engine does.
-- `value` has no declared type so numbers (hour) stay numbers; NULL is stored as char(1) (WITHOUT ROWID keys can't be NULL).
CREATE TABLE IF NOT EXISTS stat_days (
  site_id TEXT NOT NULL,
  dim TEXT NOT NULL,
  day TEXT NOT NULL,
  value NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0,
  pv INTEGER NOT NULL DEFAULT 0,
  ce INTEGER NOT NULL DEFAULT 0,
  eng INTEGER NOT NULL DEFAULT 0,
  sc_sum INTEGER NOT NULL DEFAULT 0,
  sc_n INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  dur INTEGER NOT NULL DEFAULT 0,
  ent INTEGER NOT NULL DEFAULT 0,
  ext INTEGER NOT NULL DEFAULT 0,
  rev REAL NOT NULL DEFAULT 0,
  rev_n INTEGER NOT NULL DEFAULT 0,
  c_sessions INTEGER NOT NULL DEFAULT 0,
  c_visitors INTEGER NOT NULL DEFAULT 0,
  c_bounces INTEGER NOT NULL DEFAULT 0,
  c_dur INTEGER NOT NULL DEFAULT 0,
  c_ent INTEGER NOT NULL DEFAULT 0,
  c_ext INTEGER NOT NULL DEFAULT 0,
  c_rev_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, dim, day, value)
) WITHOUT ROWID;

-- Per site: every day up to built_through is final in stat_days; days after it up to open_to were built at open_built_at
-- (today and, until it closes, yesterday). version changes when the builder does, which rebuilds everything.
CREATE TABLE IF NOT EXISTS stat_state (
  site_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  built_through TEXT NOT NULL,
  open_to TEXT,
  open_built_at INTEGER,
  goals_sig TEXT,        -- JSON {goal id: id#definition hash} of the goals stored under dim 'goal'
  goals_through TEXT     -- goal rows are complete up to this day (in step with built_through once caught up)
);

-- Rybbit-imported visitor ids were the same user across days; Pulse's rotate daily ("visitors" over several days counts
-- visitor-days, docs/API.md). Give imported sessions a per-day visitor id (user + the session's start day) and their
-- events the id of their session, so imported and live days count the same way.
UPDATE sessions SET visitor_id = visitor_id || '_' || local_day WHERE source = 'rybbit' AND visitor_id LIKE 'rb\_%' ESCAPE '\' AND visitor_id NOT LIKE '%\_____-__-__' ESCAPE '\';
UPDATE events SET visitor_id = (SELECT s.visitor_id FROM sessions s WHERE s.id = events.session_id)
  WHERE source = 'rybbit' AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = events.session_id AND s.visitor_id <> events.visitor_id);

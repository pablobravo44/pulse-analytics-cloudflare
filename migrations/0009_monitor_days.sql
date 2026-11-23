-- Status board cells, kept up to date as checks are recorded. The board read every check of the last 90 days
-- (159k rows) on each load, and every dashboard page polled it once a minute (docs/PERFORMANCE.md).
-- day = UTC day number (ts / 86400000), like the cells the status page draws.
CREATE TABLE IF NOT EXISTS monitor_days (
  monitor_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  up INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, day)
) WITHOUT ROWID;

INSERT OR REPLACE INTO monitor_days (monitor_id, day, checks, up)
SELECT monitor_id, CAST(ts / 86400000 AS INTEGER), COUNT(*), SUM(ok) FROM checks GROUP BY 1, 2;

-- Ops hub (plan §10.6 Z1, Z4, Z7): uptime monitors, checks, incidents and database metrics.

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- http | json_nonempty | scraper_freshness | pulse_ingest
  url TEXT NOT NULL,
  expect_status INTEGER NOT NULL DEFAULT 200,
  enabled INTEGER NOT NULL DEFAULT 1,
  temporary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE checks (
  monitor_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  ms INTEGER,
  error TEXT,
  PRIMARY KEY (monitor_id, ts)
);
CREATE INDEX checks_ts ON checks (ts);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  error TEXT,
  notified_open INTEGER NOT NULL DEFAULT 0,
  notified_resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX incidents_monitor ON incidents (monitor_id, resolved_at);

CREATE TABLE ops_metrics (
  day TEXT NOT NULL,
  name TEXT NOT NULL,              -- e.g. d1:my-app-production
  value REAL NOT NULL,
  PRIMARY KEY (day, name)
);

INSERT INTO monitors (id, name, kind, url, created_at) VALUES
  ('pulse-healthz', 'Pulse healthz', 'http', 'self:/healthz', 0),
  ('pulse-ingest', 'Pulse ingest lag', 'pulse_ingest', 'self:ingest', 0);

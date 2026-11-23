-- Hits dropped because the site reached its daily event cap (settings.daily_event_cap), see src/worker/ingest/cap.ts.
ALTER TABLE ingest_stats ADD COLUMN dropped_cap INTEGER NOT NULL DEFAULT 0;

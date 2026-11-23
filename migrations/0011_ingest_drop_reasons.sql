-- Two drop reasons that used to be mixed into dropped_bot: hits from hosting/cloud networks and DNT/GPC opt-outs.
ALTER TABLE ingest_stats ADD COLUMN dropped_hosting INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_stats ADD COLUMN dropped_dnt INTEGER NOT NULL DEFAULT 0;

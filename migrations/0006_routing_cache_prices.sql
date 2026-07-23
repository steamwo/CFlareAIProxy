PRAGMA foreign_keys = ON;

ALTER TABLE model_prices ADD COLUMN cache_micros_per_million INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;

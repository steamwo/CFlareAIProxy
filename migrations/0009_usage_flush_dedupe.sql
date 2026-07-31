-- Activity aggregates are now delivered as per-flush deltas instead of cumulative
-- snapshots, so request_activity_5m rows must be summed rather than MAX()-merged.
-- Queue redelivery (max_retries=3 + DLQ) is made idempotent by recording each flush id
-- inside the same D1 batch transaction that applies its delta.
CREATE TABLE IF NOT EXISTS usage_flush_dedupe (
  flush_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_flush_dedupe_created_at
  ON usage_flush_dedupe(created_at);

CREATE TABLE IF NOT EXISTS request_activity_5m (
  bucket INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  gateway_key_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  credential_id TEXT NOT NULL DEFAULT '',
  public_model TEXT NOT NULL DEFAULT '',
  upstream_model TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  latency_sum_ms INTEGER NOT NULL DEFAULT 0,
  first_token_sum_ms INTEGER NOT NULL DEFAULT 0,
  first_token_samples INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, source_id, provider_id, credential_id, public_model, upstream_model, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_request_activity_credential_bucket
  ON request_activity_5m(credential_id, bucket);

CREATE INDEX IF NOT EXISTS idx_request_activity_provider_bucket
  ON request_activity_5m(provider_id, bucket);

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS discovered_models (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT 'chat',
  owned_by TEXT NOT NULL DEFAULT '',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  raw_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY(provider_id, credential_id, model_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_discovered_models_lookup
  ON discovered_models(model_id, endpoint, enabled, provider_id);
CREATE INDEX IF NOT EXISTS idx_discovered_models_provider
  ON discovered_models(provider_id, discovered_at DESC);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown',
  quota_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_quota_snapshots_provider
  ON quota_snapshots(provider_id, fetched_at DESC);

DELETE FROM model_routes WHERE id IN ('route-kimi-default','route-qoder-auto');
UPDATE providers SET endpoints_json=json_set(endpoints_json,'$.models','/models'), updated_at=unixepoch()
WHERE id='codex' AND json_extract(endpoints_json,'$.models') IS NULL;

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS provider_proxies (
  provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  bridge_url TEXT NOT NULL DEFAULT '',
  proxy_url_ciphertext TEXT,
  bridge_token_ciphertext TEXT,
  no_proxy_json TEXT NOT NULL DEFAULT '[]',
  connect_timeout_ms INTEGER NOT NULL DEFAULT 20000,
  request_timeout_ms INTEGER NOT NULL DEFAULT 120000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_proxies_enabled ON provider_proxies(enabled);

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  pool_strategy TEXT NOT NULL DEFAULT 'round_robin',
  endpoints_json TEXT NOT NULL DEFAULT '{}',
  auth_json TEXT NOT NULL DEFAULT '{}',
  headers_json TEXT NOT NULL DEFAULT '{}',
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  refresh_ciphertext TEXT,
  expires_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 1,
  max_concurrency INTEGER NOT NULL DEFAULT 4,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_provider_enabled
  ON credentials(provider_id, enabled, priority, created_at);

CREATE TABLE IF NOT EXISTS model_routes (
  id TEXT PRIMARY KEY,
  public_model TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT 'chat',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 1,
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_routes_lookup
  ON model_routes(public_model, endpoint, enabled, priority);

CREATE TABLE IF NOT EXISTS gateway_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  rpm INTEGER NOT NULL DEFAULT 60,
  max_concurrency INTEGER NOT NULL DEFAULT 8,
  monthly_token_limit INTEGER NOT NULL DEFAULT 0,
  allowed_models_json TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  state TEXT NOT NULL UNIQUE,
  flow TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_state ON oauth_sessions(state);

CREATE TABLE IF NOT EXISTS request_logs (
  request_id TEXT PRIMARY KEY,
  gateway_key_id TEXT,
  provider_id TEXT,
  credential_id TEXT,
  public_model TEXT,
  upstream_model TEXT,
  endpoint TEXT,
  status_code INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  first_token_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_key_created ON request_logs(gateway_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS model_prices (
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_micros_per_million INTEGER NOT NULL DEFAULT 0,
  output_micros_per_million INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(provider_id, model)
);

INSERT OR IGNORE INTO providers (
  id, name, kind, base_url, enabled, pool_strategy,
  endpoints_json, auth_json, headers_json, options_json, created_at, updated_at
) VALUES
(
  'codex', 'OpenAI Codex OAuth', 'codex', 'https://chatgpt.com/backend-api/codex', 1, 'round_robin',
  '{"responses":"/responses","chat":"/responses","completions":"/responses","models":"/models"}',
  '{"flow":"authorization_code_pkce","authorize_url":"https://auth.openai.com/oauth/authorize","token_url":"https://auth.openai.com/oauth/token","client_id":"app_EMoamEEZ73f0CkXaXp7hrann","scopes":["openid","profile","email","offline_access","api.connectors.read","api.connectors.invoke"],"redirect_uri":"http://localhost:1455/auth/callback","authorize_param_id_token_add_organizations":"true","authorize_param_codex_cli_simplified_flow":"true","authorize_param_originator":"codex_cli_rs"}',
  '{"OpenAI-Beta":"responses=experimental","originator":"codex_cli_rs"}',
  '{"session_affinity":true}',
  unixepoch(), unixepoch()
),
(
  'kimi', 'Kimi Coding OAuth', 'kimi', 'https://api.kimi.com/coding/v1', 1, 'round_robin',
  '{"responses":"/responses","chat":"/chat/completions","completions":"/completions","models":"/models"}',
  '{"flow":"device_code","device_url":"https://auth.kimi.com/api/oauth/device_authorization","token_url":"https://auth.kimi.com/api/oauth/token","client_id":"17e5f671-d194-4dfb-9706-5516cb48c098"}',
  '{}', '{"session_affinity":true,"request_overrides":{"temperature":0.6}}', unixepoch(), unixepoch()
),
(
  'qoder', 'Qoder OAuth', 'qoder', 'https://api3.qoder.sh', 1, 'round_robin',
  '{"chat":"/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common","models":"/algo/api/v2/model/list"}',
  '{"flow":"qoder_pkce_device","login_url":"https://qoder.com/device/selectAccounts","poll_url":"https://openapi.qoder.sh/api/v1/deviceToken/poll"}',
  '{}', '{"session_affinity":true}', unixepoch(), unixepoch()
);

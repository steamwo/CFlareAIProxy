PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_ciphertext TEXT,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO providers(id,name,kind,base_url,enabled,pool_strategy,endpoints_json,auth_json,headers_json,options_json,created_at,updated_at) VALUES
('codex','OpenAI Codex','codex','https://chatgpt.com/backend-api/codex',1,'round_robin','{}','{}','{}','{}',unixepoch(),unixepoch()),
('kimi','Kimi Coding','kimi','https://api.kimi.com/coding/v1',1,'round_robin','{}','{}','{}','{}',unixepoch(),unixepoch()),
('qoder','Qoder','qoder','https://api3.qoder.sh',1,'round_robin','{}','{}','{}','{}',unixepoch(),unixepoch()),
('opencode','OpenCode Zen','opencode','https://opencode.ai/zen/v1',1,'round_robin','{}','{}','{}','{}',unixepoch(),unixepoch());


-- Built-in channels are code-owned. Preserve only operational state that users
-- are allowed to change: enabled and pool strategy.
UPDATE providers SET
  name='OpenAI Codex',
  kind='codex',
  base_url='https://chatgpt.com/backend-api/codex',
  endpoints_json='{"responses":"/responses","chat":"/responses","completions":"/responses","models":"/models"}',
  auth_json='{"flow":"authorization_code_pkce","issuer":"https://auth.openai.com","authorize_url":"https://auth.openai.com/oauth/authorize","token_url":"https://auth.openai.com/oauth/token","client_id":"app_EMoamEEZ73f0CkXaXp7hrann","scopes":["openid","profile","email","offline_access","api.connectors.read","api.connectors.invoke"],"redirect_uri":"http://localhost:1455/auth/callback","local_exchange_recommended":true,"authorize_param_id_token_add_organizations":"true","authorize_param_codex_cli_simplified_flow":"true","authorize_param_originator":"codex_cli_rs"}',
  headers_json='{"OpenAI-Beta":"responses=experimental","originator":"codex_cli_rs"}',
  options_json='{"session_affinity":true}',
  updated_at=unixepoch()
WHERE id='codex';

UPDATE providers SET
  name='Kimi Coding',
  kind='kimi',
  base_url='https://api.kimi.com/coding/v1',
  endpoints_json='{"responses":"/responses","chat":"/chat/completions","completions":"/completions","models":"/models"}',
  auth_json='{"flow":"device_code","device_url":"https://auth.kimi.com/api/oauth/device_authorization","token_url":"https://auth.kimi.com/api/oauth/token","client_id":"17e5f671-d194-4dfb-9706-5516cb48c098"}',
  headers_json='{}',
  options_json='{"session_affinity":true,"request_overrides":{"temperature":0.6}}',
  updated_at=unixepoch()
WHERE id='kimi';

UPDATE providers SET
  name='Qoder',
  kind='qoder',
  base_url='https://api3.qoder.sh',
  endpoints_json='{"chat":"/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common","models":"/algo/api/v2/model/list"}',
  auth_json='{"flow":"qoder_pkce_device","login_url":"https://qoder.com/device/selectAccounts","poll_url":"https://openapi.qoder.sh/api/v1/deviceToken/poll"}',
  headers_json='{}',
  options_json='{"session_affinity":true}',
  updated_at=unixepoch()
WHERE id='qoder';

UPDATE providers SET
  name='OpenCode Zen',
  kind='opencode',
  base_url='https://opencode.ai/zen/v1',
  endpoints_json='{"responses":"/responses","chat":"/chat/completions","messages":"/messages","google":"/models/{model}:{action}","models":"/models"}',
  auth_json='{"header":"Authorization","prefix":"Bearer "}',
  headers_json='{}',
  options_json='{"session_affinity":true,"model_protocol_prefixes":{"gpt-":"responses","claude-":"anthropic","qwen":"anthropic","gemini-":"google"}}',
  updated_at=unixepoch()
WHERE id='opencode';

-- Legacy user-created custom records are standard OpenAI-compatible upstreams.
UPDATE providers
SET kind='openai-compatible', updated_at=unixepoch()
WHERE id NOT IN ('codex','kimi','qoder','opencode')
  AND kind='custom';

-- Old provider proxy rows keep only the encrypted proxy URL. Bridge address and
-- token are now deployment-level secrets, not user-facing database settings.
UPDATE provider_proxies
SET enabled=CASE WHEN proxy_url_ciphertext IS NULL OR proxy_url_ciphertext='' THEN 0 ELSE 1 END,
    bridge_url='',
    bridge_token_ciphertext=NULL,
    no_proxy_json='[]',
    connect_timeout_ms=20000,
    request_timeout_ms=120000,
    updated_at=unixepoch();

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO providers (
  id, name, kind, base_url, enabled, pool_strategy,
  endpoints_json, auth_json, headers_json, options_json, created_at, updated_at
) VALUES (
  'opencode', 'OpenCode Zen', 'opencode', 'https://opencode.ai/zen/v1', 1, 'round_robin',
  '{"responses":"/responses","chat":"/chat/completions","messages":"/messages","google":"/models/{model}:{action}","models":"/models"}',
  '{"header":"Authorization","prefix":"Bearer "}',
  '{}',
  '{"session_affinity":true,"model_protocol_prefixes":{"gpt-":"responses","claude-":"anthropic","qwen":"anthropic","gemini-":"google"}}',
  unixepoch(), unixepoch()
);

-- Upgrade a manually-created 0.4.0 OpenCode Zen provider without touching
-- unrelated custom providers that merely reuse the same id.
UPDATE providers
SET kind = 'opencode',
    base_url = 'https://opencode.ai/zen/v1',
    endpoints_json = json_patch(endpoints_json, '{"responses":"/responses","chat":"/chat/completions","messages":"/messages","google":"/models/{model}:{action}","models":"/models"}'),
    auth_json = json_patch(auth_json, '{"header":"Authorization","prefix":"Bearer "}'),
    options_json = json_patch(options_json, '{"session_affinity":true,"model_protocol_prefixes":{"gpt-":"responses","claude-":"anthropic","qwen":"anthropic","gemini-":"google"}}'),
    updated_at = unixepoch()
WHERE id = 'opencode'
  AND (base_url = 'https://opencode.ai/zen/v1' OR base_url LIKE 'https://opencode.ai/zen/v1/%');

UPDATE providers
SET auth_json = json_set(
      auth_json,
      '$.issuer', 'https://auth.openai.com',
      '$.authorize_url', 'https://auth.openai.com/oauth/authorize',
      '$.token_url', 'https://auth.openai.com/oauth/token',
      '$.client_id', 'app_EMoamEEZ73f0CkXaXp7hrann',
      '$.redirect_uri', 'http://localhost:1455/auth/callback',
      '$.scopes', json('["openid","profile","email","offline_access","api.connectors.read","api.connectors.invoke"]'),
      '$.local_exchange_recommended', json('true'),
      '$.authorize_param_id_token_add_organizations', 'true',
      '$.authorize_param_codex_cli_simplified_flow', 'true',
      '$.authorize_param_originator', 'codex_cli_rs'
    ),
    updated_at = unixepoch()
WHERE id = 'codex';

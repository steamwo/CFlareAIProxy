PRAGMA foreign_keys = ON;

-- Qoder uses one upstream agent endpoint for Chat Completions, Responses and
-- Anthropic Messages. Keep the existing model refresh implementation focused on
-- the upstream catalogue, then mirror every Qoder chat discovery row into the
-- two compatibility endpoints at the D1 boundary. The trigger also normalizes
-- Qoder-specific live model metadata into CFlare's generic capability shape.
CREATE TRIGGER IF NOT EXISTS trg_qoder_discovered_protocols
AFTER INSERT ON discovered_models
WHEN NEW.provider_id = 'qoder' AND NEW.endpoint = 'chat'
BEGIN
  UPDATE discovered_models
  SET capabilities_json = json_set(
    CASE WHEN json_valid(NEW.capabilities_json) THEN NEW.capabilities_json ELSE '{}' END,
    '$.contextWindow', COALESCE(
      (SELECT MAX(CAST(json_extract(value, '$.token_count') AS INTEGER))
       FROM json_each(NEW.raw_json, '$.context_config')),
      CAST(json_extract(NEW.raw_json, '$.max_input_tokens') AS INTEGER)
    ),
    '$.supportsTools', json('true'),
    '$.supportsImages', CASE WHEN json_extract(NEW.raw_json, '$.is_vl') = 1 THEN json('true') ELSE json('false') END,
    '$.inputModalities', CASE WHEN json_extract(NEW.raw_json, '$.is_vl') = 1 THEN json('["text","image"]') ELSE json('["text"]') END,
    '$.outputModalities', json('["text"]'),
    '$.reasoningLevels', (
      SELECT CASE
        WHEN json_type(NEW.raw_json, '$.thinking_config.disabled') IS NOT NULL
          AND json_type(NEW.raw_json, '$.thinking_config.disabled') <> 'null'
          THEN json_insert(COALESCE(json_group_array(key), json('[]')), '$[#]', 'none')
        ELSE COALESCE(json_group_array(key), json('[]'))
      END
      FROM json_each(NEW.raw_json, '$.thinking_config.enabled.efforts')
    )
  )
  WHERE provider_id = NEW.provider_id
    AND credential_id = NEW.credential_id
    AND model_id = NEW.model_id
    AND endpoint = 'chat';

  INSERT OR REPLACE INTO discovered_models(
    provider_id, credential_id, model_id, display_name, endpoint, owned_by,
    capabilities_json, raw_json, enabled, discovered_at
  )
  SELECT provider_id, credential_id, model_id, display_name, 'responses', owned_by,
         capabilities_json, raw_json, enabled, discovered_at
  FROM discovered_models
  WHERE provider_id = NEW.provider_id
    AND credential_id = NEW.credential_id
    AND model_id = NEW.model_id
    AND endpoint = 'chat';

  INSERT OR REPLACE INTO discovered_models(
    provider_id, credential_id, model_id, display_name, endpoint, owned_by,
    capabilities_json, raw_json, enabled, discovered_at
  )
  SELECT provider_id, credential_id, model_id, display_name, 'messages', owned_by,
         capabilities_json, raw_json, enabled, discovered_at
  FROM discovered_models
  WHERE provider_id = NEW.provider_id
    AND credential_id = NEW.credential_id
    AND model_id = NEW.model_id
    AND endpoint = 'chat';
END;

-- Enrich rows that already existed before this migration.
UPDATE discovered_models
SET capabilities_json = json_set(
  CASE WHEN json_valid(capabilities_json) THEN capabilities_json ELSE '{}' END,
  '$.contextWindow', COALESCE(
    (SELECT MAX(CAST(json_extract(value, '$.token_count') AS INTEGER))
     FROM json_each(discovered_models.raw_json, '$.context_config')),
    CAST(json_extract(raw_json, '$.max_input_tokens') AS INTEGER)
  ),
  '$.supportsTools', json('true'),
  '$.supportsImages', CASE WHEN json_extract(raw_json, '$.is_vl') = 1 THEN json('true') ELSE json('false') END,
  '$.inputModalities', CASE WHEN json_extract(raw_json, '$.is_vl') = 1 THEN json('["text","image"]') ELSE json('["text"]') END,
  '$.outputModalities', json('["text"]'),
  '$.reasoningLevels', (
    SELECT CASE
      WHEN json_type(discovered_models.raw_json, '$.thinking_config.disabled') IS NOT NULL
        AND json_type(discovered_models.raw_json, '$.thinking_config.disabled') <> 'null'
        THEN json_insert(COALESCE(json_group_array(key), json('[]')), '$[#]', 'none')
      ELSE COALESCE(json_group_array(key), json('[]'))
    END
    FROM json_each(discovered_models.raw_json, '$.thinking_config.enabled.efforts')
  )
)
WHERE provider_id = 'qoder' AND endpoint = 'chat';

INSERT OR REPLACE INTO discovered_models(
  provider_id, credential_id, model_id, display_name, endpoint, owned_by,
  capabilities_json, raw_json, enabled, discovered_at
)
SELECT provider_id, credential_id, model_id, display_name, 'responses', owned_by,
       capabilities_json, raw_json, enabled, discovered_at
FROM discovered_models
WHERE provider_id = 'qoder' AND endpoint = 'chat';

INSERT OR REPLACE INTO discovered_models(
  provider_id, credential_id, model_id, display_name, endpoint, owned_by,
  capabilities_json, raw_json, enabled, discovered_at
)
SELECT provider_id, credential_id, model_id, display_name, 'messages', owned_by,
       capabilities_json, raw_json, enabled, discovered_at
FROM discovered_models
WHERE provider_id = 'qoder' AND endpoint = 'chat';

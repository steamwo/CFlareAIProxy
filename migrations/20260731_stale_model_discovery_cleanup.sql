-- Discovery snapshots are valid only for the credential/provider identity that produced them.
-- Remove them before an asynchronous refresh so a failed refresh cannot leave old models public.

CREATE TRIGGER IF NOT EXISTS credentials_delete_model_discovery
AFTER DELETE ON credentials
BEGIN
  DELETE FROM discovered_models WHERE credential_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS credentials_update_model_discovery_identity
AFTER UPDATE OF provider_id, auth_type, secret_ciphertext, metadata_json ON credentials
WHEN NEW.provider_id IS NOT OLD.provider_id
  OR NEW.auth_type IS NOT OLD.auth_type
  OR (
    OLD.auth_type = 'api_key'
    AND (
      NEW.secret_ciphertext IS NOT OLD.secret_ciphertext
      OR NEW.metadata_json IS NOT OLD.metadata_json
    )
  )
BEGIN
  DELETE FROM discovered_models WHERE credential_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS providers_delete_model_discovery
AFTER DELETE ON providers
BEGIN
  DELETE FROM discovered_models WHERE provider_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS providers_update_model_discovery_identity
AFTER UPDATE OF base_url, endpoints_json, options_json ON providers
WHEN NEW.base_url IS NOT OLD.base_url
  OR NEW.endpoints_json IS NOT OLD.endpoints_json
  OR COALESCE(json_extract(NEW.options_json, '$.models_url'), '')
     IS NOT COALESCE(json_extract(OLD.options_json, '$.models_url'), '')
  OR COALESCE(json_extract(NEW.options_json, '$.models_method'), '')
     IS NOT COALESCE(json_extract(OLD.options_json, '$.models_method'), '')
  OR COALESCE(json_extract(NEW.options_json, '$.models_body'), '')
     IS NOT COALESCE(json_extract(OLD.options_json, '$.models_body'), '')
  OR COALESCE(json_extract(NEW.options_json, '$.models_headers'), '')
     IS NOT COALESCE(json_extract(OLD.options_json, '$.models_headers'), '')
  OR COALESCE(json_extract(NEW.options_json, '$.discovery_endpoints'), '')
     IS NOT COALESCE(json_extract(OLD.options_json, '$.discovery_endpoints'), '')
BEGIN
  DELETE FROM discovered_models WHERE provider_id = OLD.id;
END;

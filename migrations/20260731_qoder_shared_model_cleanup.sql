-- Qoder publishes display-name mappings through channel-level discovery rows whose
-- credential_id is empty. Those rows must not outlive every enabled Qoder account,
-- otherwise /v1/models and automatic Qoder routing advertise models that cannot run.
--
-- The one-time delete repairs deployments that already have stale shared snapshots.
DELETE FROM discovered_models
WHERE provider_id = 'qoder'
  AND credential_id = ''
  AND NOT EXISTS (
    SELECT 1 FROM credentials
    WHERE provider_id = 'qoder' AND enabled = 1
  );

CREATE TRIGGER IF NOT EXISTS qoder_credentials_delete_shared_model_discovery
AFTER DELETE ON credentials
WHEN OLD.provider_id = 'qoder'
  AND NOT EXISTS (
    SELECT 1 FROM credentials
    WHERE provider_id = 'qoder' AND enabled = 1
  )
BEGIN
  DELETE FROM discovered_models
  WHERE provider_id = 'qoder' AND credential_id = '';
END;

CREATE TRIGGER IF NOT EXISTS qoder_credentials_update_shared_model_discovery
AFTER UPDATE OF enabled, provider_id ON credentials
WHEN OLD.provider_id = 'qoder'
  AND (NEW.provider_id <> 'qoder' OR NEW.enabled <> 1)
  AND NOT EXISTS (
    SELECT 1 FROM credentials
    WHERE provider_id = 'qoder' AND enabled = 1
  )
BEGIN
  DELETE FROM discovered_models
  WHERE provider_id = 'qoder' AND credential_id = '';
END;

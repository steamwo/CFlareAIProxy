-- The administrator model catalogue reads raw discovery rows, not only the public
-- channel snapshot. Remove Qoder account-scoped rows that no longer belong to an
-- enabled Qoder credential so disabled/deleted accounts cannot remain visible there.
--
-- This is a follow-up migration rather than an edit to the previous migration because
-- deployed D1 migrations are immutable once their filename is recorded as applied.
DELETE FROM discovered_models
WHERE provider_id = 'qoder'
  AND credential_id <> ''
  AND NOT EXISTS (
    SELECT 1 FROM credentials
    WHERE credentials.id = discovered_models.credential_id
      AND credentials.provider_id = 'qoder'
      AND credentials.enabled = 1
  );

CREATE TRIGGER IF NOT EXISTS qoder_credentials_disable_account_model_discovery
AFTER UPDATE OF enabled, provider_id ON credentials
WHEN OLD.provider_id = 'qoder'
  AND (NEW.provider_id <> 'qoder' OR NEW.enabled <> 1)
BEGIN
  DELETE FROM discovered_models
  WHERE provider_id = 'qoder' AND credential_id = OLD.id;
END;

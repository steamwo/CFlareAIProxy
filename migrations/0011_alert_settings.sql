-- Failure alerting (generic webhook).
--
-- The webhook URL is a secret in the same sense as a provider proxy URL: it usually embeds a
-- bearer token in its path (Discord/Slack/DingTalk all do), so it is stored encrypted in
-- system_settings.value_ciphertext under the existing MASTER_KEY envelope, exactly like
-- 'system_proxy_url'. Non-secret options (enabled flag, dedupe window) go in value_json so
-- they can be read without a decrypt.
--
-- No new table: system_settings already exists (migration 0005) and this is a single
-- singleton row, so the schema addition is the seed below plus nothing else. The row is
-- seeded disabled with a NULL ciphertext so a fresh deployment has a well-formed default
-- and the admin PUT is a pure UPDATE.
--
-- Deduplication state lives in KV (CONFIG_CACHE), not D1: it is written once per alert per
-- window and is worthless after expiry, and D1 bills rows-written ~1000x rows-read.

INSERT OR IGNORE INTO system_settings(key, value_ciphertext, value_json, updated_at)
VALUES ('alert_webhook', NULL, '{"enabled":false,"dedupeWindowMinutes":15}', unixepoch());

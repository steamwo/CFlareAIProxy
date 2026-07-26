-- Read-path indexes for the admin console and the Qoder channel alias lookup.
-- D1 bills rows-written ~1000x higher than rows-read, so every index below is
-- justified against the write amplification it adds.

-- credentials: /admin/api/credentials, /admin/api/credentials/paged and
-- /admin/api/auth-files all ORDER BY created_at DESC (optionally scoped by
-- provider_id). idx_credentials_provider_enabled leads with
-- (provider_id, enabled, priority, created_at), so it cannot serve that
-- ordering: every page pays a temp B-tree sort plus a linear OFFSET walk.
-- Write cost: credentials is a small, rarely inserted table, and the frequent
-- UPDATE statements only touch enabled/priority/weight/label/secret/updated_at.
-- SQLite skips index maintenance when no indexed column changes, so these two
-- indexes are only written on credential INSERT/DELETE.
CREATE INDEX IF NOT EXISTS idx_credentials_created_at
  ON credentials(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credentials_provider_created_at
  ON credentials(provider_id, created_at DESC);

-- discovered_models: gatewayKeyAllowsModel() and the Qoder branch of
-- listRoutesForModel() both filter on
-- (provider_id='qoder', credential_id='', display_name=?, endpoint=?, enabled=1).
-- idx_discovered_models_lookup leads with model_id and
-- idx_discovered_models_provider leads with (provider_id, discovered_at), so
-- neither can seek on display_name; both queries degrade into scans of the
-- provider's rows. The listRoutesForModel() lookup runs on every inference
-- request, so this is a request-hot-path latency win.
-- Write cost: discovered_models is only rewritten by model-discovery refreshes
-- (batched, low frequency, bounded by catalogue size), never by request traffic.
CREATE INDEX IF NOT EXISTS idx_discovered_models_channel_alias
  ON discovered_models(provider_id, credential_id, display_name, endpoint, enabled);

-- request_logs: idx_request_logs_created(created_at DESC) from 0001 and
-- idx_request_logs_created_at(created_at) from 0008 are equivalent in SQLite --
-- a single-column index is walked in either direction, so DESC is not a distinct
-- structure. request_logs is the highest-write table in the schema (one row per
-- proxied request), so the duplicate is pure write amplification with zero read
-- benefit. Keep the 0001 index, which the retention DELETE and the
-- /admin/api/logs ORDER BY created_at DESC LIMIT query both already use.
DROP INDEX IF EXISTS idx_request_logs_created_at;

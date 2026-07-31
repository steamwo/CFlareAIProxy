-- Persist the last model-refresh attempt independently from successful discovery so
-- repeatedly failing accounts cannot monopolize the head of every bounded refresh batch.
CREATE TABLE IF NOT EXISTS credential_refresh_attempts (
  credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  model_attempted_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_credential_refresh_attempts_model
  ON credential_refresh_attempts(model_attempted_at);

-- Device OAuth polling uses a conditional UPDATE on this column as its atomic claim.
ALTER TABLE oauth_sessions ADD COLUMN last_polled_at INTEGER;

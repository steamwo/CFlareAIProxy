CREATE INDEX IF NOT EXISTS idx_request_logs_created_at
  ON request_logs(created_at);

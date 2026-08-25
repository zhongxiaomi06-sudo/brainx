-- Database growth guard: support hash-based recommendation throttling and
-- retention scans without repeatedly sorting the largest tables.
CREATE INDEX IF NOT EXISTS idx_sync_runs_consultant_completed
  ON sync_runs(consultant_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_input_hash
  ON sync_runs(consultant_id, input_hash, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_created
  ON decision_runs(consultant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_run_rank
  ON recommendations(run_id, rank);
CREATE INDEX IF NOT EXISTS idx_events_decision_type
  ON decision_events(decision_id, event_type);

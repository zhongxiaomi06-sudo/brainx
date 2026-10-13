CREATE TABLE judgment_notice_deliveries (
  draft_id TEXT NOT NULL REFERENCES judgment_drafts(draft_id),
  group_scope_id TEXT NOT NULL REFERENCES agent_group_scopes(group_scope_id),
  status TEXT NOT NULL CHECK(status IN ('SENDING','SENT','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(draft_id,group_scope_id)
);

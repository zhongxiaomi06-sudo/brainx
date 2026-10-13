-- 自由条件搜索没有 job_facts 外键；原群与每轮结果独立持久化，避免续搜覆盖待投递结果。
CREATE TABLE sourcing_group_deliveries (
  delivery_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  search_key TEXT NOT NULL,
  consultant_id TEXT NOT NULL REFERENCES consultants(consultant_id),
  binding_id TEXT NOT NULL REFERENCES feishu_identity_bindings(binding_id),
  group_scope_id TEXT NOT NULL REFERENCES agent_group_scopes(group_scope_id),
  search_brief TEXT,
  search_round INTEGER NOT NULL,
  excluded_candidate_refs_json TEXT NOT NULL DEFAULT '[]',
  result_status TEXT CHECK(result_status IN ('done','needs_input','failed')),
  result_text TEXT,
  error TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'WAITING'
    CHECK(delivery_status IN ('WAITING','PENDING','SENDING','SENT','FAILED','CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, group_scope_id)
);
CREATE INDEX idx_sourcing_group_delivery_queue
  ON sourcing_group_deliveries(delivery_status, next_attempt_at);

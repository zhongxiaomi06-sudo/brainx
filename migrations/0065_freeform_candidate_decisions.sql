-- 自由找人没有职位；独立记录个人搜索中的候选动作，不伪造 job_facts。
CREATE TABLE freeform_candidate_decisions (
  tenant_id TEXT NOT NULL,
  consultant_id TEXT NOT NULL REFERENCES consultants(consultant_id),
  search_key TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('SCREENED','REJECTED','RESTORED')),
  source_task_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,consultant_id,search_key,candidate_ref)
);
CREATE TABLE freeform_candidate_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  consultant_id TEXT NOT NULL,
  search_key TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

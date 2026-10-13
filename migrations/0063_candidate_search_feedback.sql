-- 候选排除是顾问在具体项目中的决定，不扩散为全公司人才黑名单。
CREATE TABLE candidate_search_feedback (
  tenant_id TEXT NOT NULL,
  consultant_id TEXT NOT NULL REFERENCES consultants(consultant_id),
  project_id TEXT NOT NULL REFERENCES job_facts(project_id),
  candidate_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('REJECTED','RESTORED')),
  reason TEXT,
  source_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,consultant_id,project_id,candidate_ref)
);
CREATE TABLE candidate_search_feedback_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  consultant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('REJECTED','RESTORED')),
  reason TEXT,
  source_task_id TEXT,
  occurred_at TEXT NOT NULL
);

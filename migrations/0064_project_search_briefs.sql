-- 项目权威判据与每轮搜索快照分离；群消息补充不写此表。
CREATE TABLE project_search_briefs (
  project_id TEXT PRIMARY KEY REFERENCES job_facts(project_id),
  search_brief TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  updated_by TEXT NOT NULL REFERENCES consultants(consultant_id),
  updated_at TEXT NOT NULL
);

-- specs/036：每轮搜索结果拆行落库，append-only；群内检索（brainx_sourcing_recall）的数据地基。
-- 列宽全部 TEXT 不设限：拆行时对超长字段显式报错，不做静默截断。
CREATE TABLE IF NOT EXISTS sourcing_candidates (
  search_key TEXT NOT NULL,
  consultant_id TEXT NOT NULL REFERENCES consultants(consultant_id),
  search_round INTEGER NOT NULL,
  candidate_ref TEXT NOT NULL,
  name TEXT,
  company TEXT,
  title TEXT,
  city TEXT,
  experience TEXT,
  education TEXT,
  evaluation TEXT,
  score_raw TEXT,
  score_num REAL,
  talent_url TEXT,
  resume_url TEXT,
  profile_url TEXT,
  career_status TEXT NOT NULL DEFAULT 'recommended'
    CHECK(career_status IN ('recommended','screened','in_pool','rejected','restored')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (search_key, consultant_id, search_round, candidate_ref)
);
CREATE INDEX IF NOT EXISTS idx_sourcing_candidates_city
  ON sourcing_candidates(consultant_id, city);
CREATE INDEX IF NOT EXISTS idx_sourcing_candidates_updated
  ON sourcing_candidates(consultant_id, updated_at);

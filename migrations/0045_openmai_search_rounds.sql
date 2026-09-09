-- 找人轮次与累计 TTC 排除编号；仍只保留当前结果，但下一轮不会重复历史候选人。
ALTER TABLE openmai_results ADD COLUMN search_round INTEGER NOT NULL DEFAULT 1 CHECK(search_round >= 1);
ALTER TABLE openmai_results ADD COLUMN excluded_candidate_refs_json TEXT NOT NULL DEFAULT '[]';

-- 冻结离线排序输入。历史行保持 NULL，禁止用当前 job_facts 伪造旧快照。
ALTER TABLE recommendations ADD COLUMN feature_snapshot_json TEXT;

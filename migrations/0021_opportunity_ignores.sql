-- “忽略”是顾问对职位的持久排除事实，不再作为项目承接状态。
CREATE TABLE IF NOT EXISTS opportunity_ignores (
  consultant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  ignored_at TEXT NOT NULL,
  PRIMARY KEY (consultant_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_ignores_consultant
  ON opportunity_ignores (consultant_id, ignored_at);

-- 兼容旧数据：只有当前仍停在 DISMISSED 的职位才转成忽略；后续已经重新
-- 跟进的职位不会被误排除。
INSERT OR IGNORE INTO opportunity_ignores
  (consultant_id, project_id, idempotency_key, ignored_at)
SELECT consultant_id, project_id,
       'legacy-dismissed:' || consultant_id || ':' || project_id,
       state_since
FROM current_engagement
WHERE state='DISMISSED';

-- 旧版会把“暂不考虑”留在我的项目里；迁移后关闭当前归属，只保留历史。
UPDATE job_memberships
SET valid_to = COALESCE((
  SELECT ignored_at FROM opportunity_ignores i
  WHERE i.consultant_id=job_memberships.consultant_id
    AND i.project_id=job_memberships.project_id
), datetime('now'))
WHERE valid_to IS NULL
  AND relation IN ('MY_JOB','TEAM_SHARED')
  AND EXISTS (
    SELECT 1 FROM opportunity_ignores i
    WHERE i.consultant_id=job_memberships.consultant_id
      AND i.project_id=job_memberships.project_id
  );

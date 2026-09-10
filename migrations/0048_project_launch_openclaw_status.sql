-- 0048: 项目群的 OpenClaw 准入状态与补偿记账（specs/013）。
-- 准入降级为发卡后的 best-effort：卡片先发，准入失败记 PENDING 由后台补偿重放。
-- 存量行默认 PENDING（历史行均未成功准入），会被补偿任务捡起重试。
ALTER TABLE project_launches ADD COLUMN openclaw_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE project_launches ADD COLUMN openclaw_error TEXT;
ALTER TABLE project_launches ADD COLUMN openclaw_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_launches ADD COLUMN openclaw_updated_at TEXT;

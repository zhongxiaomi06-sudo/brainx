-- 0040: 项目群启动后的 OpenMai 状态，群就绪与找人任务分别诚实呈现。
ALTER TABLE project_launches ADD COLUMN search_status TEXT;
ALTER TABLE project_launches ADD COLUMN search_task_id TEXT;
ALTER TABLE project_launches ADD COLUMN search_started_at TEXT;

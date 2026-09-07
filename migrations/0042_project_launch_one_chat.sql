-- 0042: 一个职位只能启动一个共享项目群；保留历史冲突供人工核对，阻止新增重复记录。
CREATE TRIGGER IF NOT EXISTS project_launches_one_chat_per_project_insert
BEFORE INSERT ON project_launches
WHEN EXISTS (SELECT 1 FROM project_launches WHERE project_id=NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_LAUNCH_ALREADY_EXISTS');
END;

CREATE TRIGGER IF NOT EXISTS project_launches_one_chat_per_project_update
BEFORE UPDATE OF project_id ON project_launches
WHEN NEW.project_id<>OLD.project_id
  AND EXISTS (SELECT 1 FROM project_launches WHERE project_id=NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_LAUNCH_ALREADY_EXISTS');
END;

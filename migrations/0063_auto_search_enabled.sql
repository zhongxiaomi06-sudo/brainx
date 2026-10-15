-- 0063: project_launches 加 auto_search_enabled 字段（specs/037 建群后按 JD 自动找人）。
-- 咪 2026-10-15 指令：「建群之后按照 JD 就开始第一轮的找人 不要用户说开始找人
-- 后续能一直长期招人」+「除了 mia 之外的群都实现自动触发」。
-- 存量项目默认开启（auto_search_enabled=1），可手动关闭特定项目（kill switch）。
ALTER TABLE project_launches ADD COLUMN auto_search_enabled INTEGER DEFAULT 1;

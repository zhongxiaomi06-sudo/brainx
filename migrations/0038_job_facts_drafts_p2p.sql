-- 0038: job_facts_drafts 支持私聊 JD 直接提交（specs/005-private-jd-job-draft）
-- origin 区分来源通道：'group'=登记群消息提炼（存量默认）；'p2p_jd'=顾问私聊提交整段 JD。
-- submitted_by 记录提交人 consultant_id，可见性 = 提交人本人（tools-job-facts VISIBLE_DRAFT 扩展）。
-- 部分唯一索引：同一顾问重复提交同一 JD（message_id 由 sha256(consultant_id+JD) 派生）数据库层兜底防重。
ALTER TABLE job_facts_drafts ADD COLUMN origin TEXT NOT NULL DEFAULT 'group';
ALTER TABLE job_facts_drafts ADD COLUMN submitted_by TEXT;

CREATE INDEX IF NOT EXISTS idx_jfd_submitted_by ON job_facts_drafts(submitted_by);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jfd_p2p_message
  ON job_facts_drafts(message_id) WHERE origin = 'p2p_jd';

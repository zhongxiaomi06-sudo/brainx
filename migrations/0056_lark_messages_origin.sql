-- 0056: lark_messages 来源列（specs/022 信号层第二批回填前置）。
-- 网关事件写入保持 origin='gateway'（DEFAULT 兜底存量行）；
-- user 身份 lark-cli 历史回填写 origin='backfill'（received_at=回填时刻，
-- create_time 保留飞书分钟精度，秒/毫秒补零）。
-- 下游（job-extract / judgment-extract / specs/022 规则抽取）可按 origin
-- 区分审计语义：backfill 行不是网关实时事件，勿用于送达时效类指标。
ALTER TABLE lark_messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'gateway';

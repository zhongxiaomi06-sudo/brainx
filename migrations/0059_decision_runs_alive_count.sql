-- 0059: decision_runs.alive_count —— 轮次级「确认在招」计数（2026-09-28 数据准确度修正）
-- 起因：卡片「从 N 个职位中筛选」的 N = candidate_count 是含 20.5k 个 UNKNOWN（无状态信号）
-- 职位的全库评估数，用户侧读成「和我相关的职位总量」→ 不准确。alive_count 记录同轮
-- evaluated 中 active_state='OPEN' 的数量，卡片展示以它为主口径。只加列不改语义，
-- 历史行 NULL（展示层回退旧文案）。
ALTER TABLE decision_runs ADD COLUMN alive_count INTEGER;

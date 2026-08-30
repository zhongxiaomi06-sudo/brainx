-- 推荐快照属于 recommendations，不是用户决策轨迹。
-- 清除历史机器事件，保留 VIEWED/WATCHED/ACCEPTED/DISMISSED/进展与结果等真实操作。
DELETE FROM decision_events WHERE event_type='RECOMMENDED';

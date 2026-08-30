---
name: brainx-data-explorer
description: 用 query_sql 对 BrainX SQLite 决策库做自定义只读查询(统计/联表/历史追溯/导出)。内含 24 张表速查与常用 SQL。需要 MCP/领域工具覆盖不到的数据时使用。
---

# BrainX SQLite 只读直查(query_sql 版)

`query_sql({sql})`:仅 SELECT/WITH/EXPLAIN 单语句,自动 LIMIT 500,写语句/PRAGMA/ATTACH 一律被守门拒绝。

## 表速查(24 张)

| 表 | 内容 | 关键列 |
|---|---|---|
| job_facts | 职位事实(权威) | project_id, company, role, city, hc, active_state, raw_json |
| job_memberships | 顾问×职位关系(当前=valid_to IS NULL) | consultant_id, project_id, relation |
| cockpit_facts | Felix 驾驶舱事实 | membership_status, current_stage, next_action |
| job_classifications | LLM 岗位方向分类 | primary_direction, is_leadership |
| job_occupancy | HC 占用 | headcount_total, remaining_hc, occupancy_status |
| decision_runs | 推荐轮次 | run_id, consultant_id, policy_version |
| recommendations | 冻结推荐(回放只读此表) | decision_id, action, score, rank, reasons_json |
| decision_events | 事件账本(只追加) | event_type, actor, project_id, next_state |
| job_outcomes | 结果观察(面试/Offer/入职) | stage, value_json, kind |
| commitment_actions | 承接行动项 | action_id, title, due_at, status(OPEN/BLOCKED/DONE) |
| sync_runs | 同步批次(complete=0 不可用于推荐) | sync_id, source, complete, rows_read |
| consultants | 花名册+画像 | consultant_id, display_name, profile_json |
| recommendation_feedback | 不感兴趣反馈 | feedback, reason, snapshot_id |
| recommendation_impressions | 推荐曝光 | run_id, rank, slot_kind |
| openmai_results | OpenMai 找人结果 | project_id, status, result_text(markdown) |
| manual_fact_overrides | 人工事实覆盖 | field, value_json |
| push_log | 推送记录(幂等) | consultant_id, kind, run_id, status |
| consultant_tokens / ttc_tokens | 加密令牌 | 密文,**不要查、不要引用** |
| job_messages / job_message_visibility | 飞书群消息与可见性 | text, matched_project_id |
| bridge_cursor | 桥接游标 | source, checkpoint |
| recommendation_batches | 推荐分页游标 | batch_id, cursor |
| workbench_preferences | 工作台 UI 偏好 | tray_json, folders_json |
| ttc_field_reports | TTC 字段覆盖报告 | report_json |
| fact_override_events | 覆盖历史 | before/after/changes |

## 常用查询

```sql
-- 当前顾问承接中职位(把 ? 换成用户 consultant_id)
SELECT j.company, j.role, c.title, c.due_at, c.status
FROM commitment_actions c JOIN job_facts j USING(project_id)
WHERE c.consultant_id=? AND c.status='OPEN';

-- 最新一轮推荐 Top10
SELECT r.rank, j.company, j.role, r.score, r.action, r.confidence_band
FROM recommendations r JOIN job_facts j USING(project_id)
WHERE r.run_id=(SELECT run_id FROM decision_runs WHERE consultant_id=? ORDER BY created_at DESC LIMIT 1)
ORDER BY r.rank;

-- 职位事件流水
SELECT event_type, occurred_at, actor, prev_state, next_state FROM decision_events
WHERE project_id=? ORDER BY occurred_at;

-- 各方向职位分布(盘点用)
SELECT c.primary_direction, count(*) n FROM job_classifications c
GROUP BY 1 ORDER BY n DESC;
```

## 纪律

- 只读:写意图一律拒绝并走 brainx-engagement 的"建议+指引"剧本
- consultant_id 一律用当前会话用户的,不代查他人(严格隔离)
- 结果行多时先用 count(*) 探规模,再取明细;raw_json 大字段少 SELECT *

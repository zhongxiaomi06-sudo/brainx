# Phase 1 Data Model: Hub 事件骨干重整

> 规格：[spec.md](spec.md) · 研究：[research.md](research.md)

## 既有结构（本期不改）

- `workflow_event_log`（append-only；event_id PK、idem_key 唯一、payload JSON、evidence_refs 引用制）
- `processed_events`（event_id + consumer_name 消费标记，恰好一次语义根基）
- `event_dlq`（0027，死信：事件 + 消费者 + 原因，可重放）
- `job_outcomes`、`openmai_results`、`job_facts_drafts`、`judgment_drafts`（业务结果与草稿，均已有幂等键）

## 新增：feedback_metrics（migrations/0052_feedback_metrics.sql）

反馈指标快照表。append-only；同一窗口可重算，重算产生新快照行（superseded_by 链接），不改写历史。

| 列 | 类型 | 说明 |
|---|---|---|
| snapshot_id | TEXT PK | uuid |
| window_start / window_end | TEXT | 统计窗口（ISO 8601） |
| metric_key | TEXT | 指标键：`recommendation.accept_rate`、`extract.field_confirm_rate`、`sourcing.channel_conversion`、`job.terminal_cycle_days` 等 |
| dimension | TEXT | 维度切片（如 channel=openmai、domain=judgment；无维度为空串） |
| sample_size | INTEGER | 样本量（0 样本的指标也必须落行，防止静默漏数） |
| value_num | REAL | 指标值（比率 0..1 或天数） |
| inputs_json | TEXT | 口径输入摘要（事件类型、过滤条件、版本），供重算追溯 |
| computed_at | TEXT | 计算时间 |

索引：`(metric_key, dimension, window_end)` 查询最新趋势。

## 新增事件类型的载荷形状（信封沿用既有 envelope.js 校验）

所有类型：`evidence_refs` 指向业务表行（如 `{table:'job_outcomes', id:...}`），payload 无 PII 正文。

- `job.accepted`：`{ project_id, consultant_id, source }`
- `sourcing.search_started`：`{ project_id, channel, round }`
- `sourcing.search_finished`：`{ project_id, channel, round, status, result_count }`
- `job_fact.reviewed`：`{ domain, draft_id, action, project_id? }`
- `job.terminal_recorded`：`{ project_id, stage, kind }`

## 状态与流转

- 消费者状态：未消费 →（dispatcher 派发）→ 已消费（processed_events）| 死信（event_dlq，可重放回到未消费）。
- 草稿状态（既有，不变）：pending → confirmed | rejected；本期只是让这两个流转产事件。
- 反馈快照：append-only；口径变更升 `inputs_json` 中的版本字段，不回填旧行。

## 校验规则

- 事件信封：沿用 `src/hub/envelope.js` zod 校验（evidence_refs 仅 {table,id}、occurred_at ISO 8601、payload ≤64KB）。
- 幂等：五类事件的幂等键全部复用业务写入点既有键（见 research.md 决策 3），账本唯一索引兜底。
- feedback_metrics：window_start < window_end；sample_size ≥ 0；value_num 为空时必须有 inputs_json 说明原因。

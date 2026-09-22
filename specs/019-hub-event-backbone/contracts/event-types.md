# Contracts: 业务事件类型目录（信封契约）

> 规格：[../spec.md](../spec.md) · 数据模型：[../data-model.md](../data-model.md)
>
> 本文件是五类业务事件的唯一契约来源。新增/修改事件类型必须先改本文件，再改代码；消费者按 `event_type` 路由。

## 公共信封

全部走 `appendEvent(db, input)` + `validateEnvelope`：

```json
{
  "event_id": "uuid",
  "idem_key": "见各事件",
  "event_type": "见各事件",
  "case_id": "可空",
  "actor": "user:<consultant_id> | agent:<tool> | system:<job>",
  "occurred_at": "ISO 8601",
  "payload": "见各事件（无 PII 正文）",
  "evidence_refs": [{ "table": "...", "id": "..." }],
  "schema_version": 1
}
```

## job.accepted — 接单

- 触发：`src/agent-gateway/tools-actions.js` acceptJob 成功路径（含 already 幂等命中不重复发）。
- idem_key：`job.accepted:{project_id}:{consultant_id}`
- payload：`{ project_id, consultant_id, source: "daily_card"|"private_chat"|"group_card" }`
- actor：`user:<consultant_id>`

## sourcing.search_started — 找人启动

- 触发：找人任务登记处（integration-jobs 生产 handler）。
- idem_key：`sourcing.started:{project_id}:{run_key}`
- payload：`{ project_id, channel: "openmai"|"supermai"|"reloop", round: <int> }`
- actor：`agent:<tool_name>`

## sourcing.search_finished — 找人完成/失败

- 触发：`src/openmai-delivery.js` 结果投递（含失败分支）。
- idem_key：`sourcing.finished:{project_id}:{run_key}`
- payload：`{ project_id, channel, round, status: "success"|"error", result_count: <int> }`
- actor：`system:worker`

## job_fact.reviewed — 草稿确认/拒绝

- 触发：`src/job-extract/confirm.js`、`src/judgment-extract/confirm.js` 的 confirm/reject 成功路径。
- idem_key：`job_fact.reviewed:{domain}:{draft_id}`（复用草稿状态终态幂等：非 pending 即 409，天然防重）
- payload：`{ domain: "job"|"judgment", draft_id, action: "confirm"|"reject", project_id? }`
- actor：`user:<consultant_id>`

## job.terminal_recorded — 终局记录

- 触发：`src/replay.js` recordOutcome 成功路径。
- idem_key：复用 `job_outcomes.idempotency_key`
- payload：`{ project_id, stage, kind }`
- actor：`user:<consultant_id>`

## 消费者注册契约（dispatcher）

```js
// 注册项形状（src/hub/dispatcher.js 的唯一事实源）
{
  name: 'job-extract',                    // processed_events.consumer_name
  eventTypes: ['lark.message_received'],  // 订阅过滤；空数组 = 全量
  maxRetries: 3,                          // 超限进 event_dlq
  prepare: async (event, deps) => any,    // 可选：异步 IO（LLM/HTTP），不进事务
  apply: (db, event, prepared) => void,   // 必填：同步事务内落库（consumeOnce 包裹）
}
```

规则：`apply` 必须为纯同步（SQLite 写锁不跨 await）；`prepare` 抛错按重试/DLQ 语义处理，不产生任何业务写入。

## 反馈指标口径契约（feedback_metrics.metric_key）

| metric_key | 口径 | 数据来源事件 |
|---|---|---|
| `recommendation.accept_rate` | 窗口内 job.accepted 数 / 推荐曝光数 | job.accepted + 既有曝光表 |
| `extract.field_confirm_rate` | confirm/(confirm+reject)，按 domain 切片 | job_fact.reviewed |
| `sourcing.channel_conversion` | 各渠道 search_finished(success) 且后续有候选保留的比例 | sourcing.search_finished + 候选保留事件（后续专项补） |
| `job.terminal_cycle_days` | job.accepted → job.terminal_recorded 的中位天数 | 两类事件 join |

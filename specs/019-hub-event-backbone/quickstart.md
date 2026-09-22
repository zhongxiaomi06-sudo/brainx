# Quickstart: Hub 事件骨干重整端到端验证

> 规格：[../spec.md](../spec.md) · 契约：[../contracts/event-types.md](../contracts/event-types.md)

## 前置

```bash
npm ci
npm run verify:quick   # 基线必须全绿
```

## 场景 1：业务动作产事件（US1）

1. 运行 `node --test tests/business-events.test.mjs`。
2. 期望：五类动作（接单/找人启动/找人完成/草稿确认/终局）各自在内存库产生对应 `event_type` 事件；以相同幂等键重放同一动作，账本行数不变（`deduplicated: true`）。

## 场景 2：dispatcher 派发与故障隔离（US2）

1. 运行 `node --test tests/hub-dispatcher.test.mjs`。
2. 期望覆盖：
   - 注册表新消费者无需改动生产代码即收到存量未消费事件；
   - 消费者抛错 → 按 maxRetries 重试 → 超限进 `event_dlq`；
   - 一个消费者持续失败时，其余消费者与消息落账照常；
   - DLQ 事件修复后可重放且不产生二次副作用。

## 场景 3：消费移出 bridge 调用栈（US2 结构验收）

1. `grep -n "consumeJobExtract\|consumeJudgmentExtract" src/job-extract/bridge-producer.js src/bridge.js` 应无结果（消费调用已全部移到 dispatcher 注册的消费者内）。
2. bridge 停摆模拟：杀掉 dispatcher 进程后向 bridge 喂消息，消息仍落 `lark_messages` + 账本；重启 dispatcher 后积压被补消费。

## 场景 4：反馈指标可重算（US3）

1. 运行 `node --test tests/feedback-rollup.test.mjs`。
2. 期望：构造已知结果的推荐/确认/终局事件集，rollup 产出的 `feedback_metrics` 快照数值与人工计算一致；同一窗口重算产生新快照行且历史行不变。

## 场景 5：接口漂移门禁（US5 地基）

1. 人为在 `src/agent-gateway/tool-registry.js` 加一行工具定义而不同步插件清单。
2. 运行 `npm run verify:quick`。
3. 期望：契约一致性测试失败，摘要指出漂移的工具名。

## 完成判据

场景 1-5 全绿 + `npm run verify:quick` 16/16 + `npm test` 全量通过，即满足 spec.md 的 SC-001~SC-005、SC-007 的可自动化部分；SC-006（300 顾问隔离）在本期只验原则测试，完整验收属后续子规格。

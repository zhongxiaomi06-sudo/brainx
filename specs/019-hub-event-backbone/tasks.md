# Tasks: Hub 事件骨干重整

**Input**: Design documents from `/specs/019-hub-event-backbone/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/event-types.md ✅

**Tests**: 本仓库宪法 IV 要求测试先行——每个故事先写 node:test 用例（必须能失败），再写实现。

**Organization**: 按用户故事分阶段；US1（业务事件）与 US2（dispatcher）同属 P1，US1 先行为反馈环供料。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 对应 spec.md 的用户故事（US1-US5）

---

## Phase 1: Setup

**Purpose**: 基线确认，无新项目结构（全部落在既有分层）

- [x] T001 运行 `npm run verify:quick` 确认基线 16/16 全绿；通读 specs/019-hub-event-backbone/ 的 spec.md、plan.md、research.md、contracts/event-types.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有故事共用的测试基座与事件发射辅助

**⚠️ CRITICAL**: 完成前不得开始任何用户故事

- [x] T002 新建 `tests/helpers/event-ledger.js`：内存库建账本金表（workflow_event_log/processed_events/event_dlq）+ 快捷 appendEvent 的测试工具函数，供 US1/US2/US3 测试复用
- [x] T003 新建 `src/hub/emit.js`：`emitEvent(db, {...})` 包装 appendEvent——统一 actor/occurred_at/schema_version 约定，返回 {ok, deduplicated}；业务写入点在同一事务内调用（plan.md 结构中 event-log.js 不动，发射辅助独立成文件）

**Checkpoint**: 测试基座可用，US1/US2 可以开始

---

## Phase 3: User Story 1 - 业务动作全程留痕可回流 (Priority: P1) 🎯 MVP

**Goal**: 接单、找人启动/完成、草稿确认/拒绝、终局记录五类动作全部补发标准信封事件，幂等防重

**Independent Test**: `node --test tests/business-events.test.mjs`——五类动作各产对应事件；同幂等键重放账本行数不变

### Tests for User Story 1（先写，必须能失败）⚠️

- [x] T004 [US1] 新建 `tests/business-events.test.mjs`：五类事件（job.accepted / sourcing.search_started / sourcing.search_finished / job_fact.reviewed / job.terminal_recorded）的产生、幂等回放、evidence_refs 引用制（payload 无正文）用例，按 contracts/event-types.md 逐字段断言

### Implementation for User Story 1

- [x] T005 [P] [US1] `src/agent-gateway/tools-actions.js` acceptJob 成功路径补发 job.accepted（already 幂等命中不重发），idem_key 用 `job.accepted:{project_id}:{consultant_id}`
- [x] T006 [P] [US1] `src/replay.js` recordOutcome 成功路径补发 job.terminal_recorded，idem_key 复用 job_outcomes.idempotency_key
- [x] T007 [P] [US1] `src/job-extract/confirm.js` confirmDraft/rejectDraft 成功路径补发 job_fact.reviewed（domain='job'）
- [x] T008 [P] [US1] `src/judgment-extract/confirm.js` confirmJudgment/rejectJudgment 成功路径补发 job_fact.reviewed（domain='judgment'）
- [x] T009 [P] [US1] `src/openmai-delivery.js` 结果投递（含失败分支）补发 sourcing.search_finished，payload 只放 status+result_count
- [x] T010 [US1] 找人任务登记处（`src/integration-jobs/production-handlers.js`）补发 sourcing.search_started，含 channel/round
- [x] T011 [US1] T004 测试转绿 + 受影响既有测试回归 + `npm run verify:quick` + 原子 commit（`feat(hub): 业务动作补发标准信封事件（US1）`），同步 docs/AGENT_COMMIT_LOG.md

**Checkpoint**: US1 独立成立——五类动作留痕可查可重放，dispatcher 未建也不影响本故事价值

---

## Phase 4: User Story 2 - 消费异步派发，错误可被调度 (Priority: P1)

**Goal**: 消费从 bridge 调用栈移出；注册表驱动的 dispatcher 进程统一派发、重试、DLQ；LLM 以 prepare/apply 两段式回到消费者内部

**Independent Test**: `node --test tests/hub-dispatcher.test.mjs` + quickstart.md 场景 3（bridge-producer/bridge.js 中 grep 不到 consume 调用）

### Tests for User Story 2（先写，必须能失败）⚠️

- [x] T012 [US2] 新建 `tests/hub-dispatcher.test.mjs`：未消费扫描派发、恰好一次、maxRetries 重试后进 event_dlq、单消费者故障不影响其他消费者与消息落账、DLQ 重放无二次副作用、新注册消费者收到存量事件、prepare 抛错零业务写入

### Implementation for User Story 2

- [x] T013 [US2] `src/hub/consumer.js` 新增 `consumeOnceAsync(db, eventId, name, {prepare, apply}, deps)`：先 await prepare（事务外），再把 apply 包进既有同步 consumeOnce；prepare 缺省时等价原同步行为
- [x] T014 [US2] 新建 `src/hub/dispatcher.js`：消费者注册表（形状见 contracts/event-types.md 注册契约）+ 按消费者扫未消费事件（workflow_event_log LEFT JOIN processed_events）+ 逐条派发 + 失败计数重试 + 超限写 event_dlq；单消费者异常 try/catch 隔离
- [x] T015 [US2] 新建 `bin/brainx-dispatcher.mjs` 常驻入口（参照 bin/brainx-integration-worker.mjs 的 21 行循环模式）+ `deploy/systemd/` 新增 brainx-dispatcher.service 单元
- [x] T016 [US2] 迁移既有消费者进注册表：`src/job-extract/index.js` 与 `src/judgment-extract/index.js` 改为 {prepare（内含 LLM 预抽取，原 presetFromLlm 逻辑迁入）, apply} 形状；`src/job-extract/bridge-producer.js` 删除消费调用与双份 try/catch 补偿；`src/bridge.js` 329/361 两处瘦身为只落原文+账本
- [x] T017 [US2] 按 quickstart.md 场景 3 验收：grep 判据通过 + dispatcher 停摆期间消息落账不受影响、重启后积压补消费（测试或手动脚本记录证据）
- [x] T018 [US2] T012 转绿 + 既有 job-extract/judgment-extract 测试全绿（幂等语义不变）+ `npm run verify:quick` + 原子 commit（`feat(hub): dispatcher 调度层——消费移出 bridge 调用栈（US2）`），同步 docs/AGENT_COMMIT_LOG.md

**Checkpoint**: US2 独立成立——错误可调度、消费可插拔、bridge 不再背 LLM 延迟

---

## Phase 5: User Story 3 - 决策结果回流，准不准可测量 (Priority: P2)

**Goal**: 反馈环消费业务事件，周期汇总产出可重算的指标快照

**Independent Test**: `node --test tests/feedback-rollup.test.mjs`——已知结果的事件集，快照数值与人工计算一致；同窗重算历史行不变

**Depends on**: US1（事件原料）；US2（消费者宿主）未完成时可先用 worker 定时触发过渡

### Implementation for User Story 3

- [x] T019 [US3] 新建 `migrations/0052_feedback_metrics.sql`（结构见 data-model.md）+ 跟进 `tests/framework.test.mjs` 迁移记账清单断言
- [x] T020 [US3] 新建 `tests/feedback-rollup.test.mjs`（先红）：四项指标口径（contracts/event-types.md 表）各一组已知答案用例 + 0 样本落行 + 重算 append-only
- [x] T021 [US3] 新建 `src/feedback/rollup.js`：注册为 dispatcher 消费者（增量计数）+ `runRollup(db, window)` 周期汇总写 feedback_metrics
- [x] T022 [US3] 汇总结果读取入口：既有报告 CLI/技能可查询快照（最小实现：只读 SQL 查询脚本或 server 只读端点）
- [x] T023 [US3] 测试转绿 + `npm run verify:quick` + 原子 commit（`feat(feedback): 反馈环指标快照（US3）`），同步 docs/AGENT_COMMIT_LOG.md

**Checkpoint**: SC-005 成立——每周可出推荐采纳率与抽取确认率报告

---

## Phase 6: User Story 4 - 三百顾问会话隔离由系统承载（地基） (Priority: P2)

**Goal**: 本期只落地基：gateway principal 边界为原则契约并补测试；完整隔离形态立子规格

**Independent Test**: 多租户并发用例全绿；风险与路径写入文档

- [ ] T024 [US4] `tests/agent-authorization.test.mjs` 补多租户边界用例：不同 consultant 并发会话互不可见、越权访问 fail-closed（基于现有 authorization.js decide() 五态）
- [ ] T025 [US4] 新建子规格目录 `specs/020-session-isolation-principal/spec.md` 占位：session 隔离从 OpenClaw Agent（maxAgents=20）下沉 gateway principal 的完整形态，引用本规格 US4 验收标准

**Checkpoint**: 隔离原则有测试守护，完整形态有立项入口

---

## Phase 7: User Story 5 - 接口面收敛为单一契约（地基） (Priority: P3)

**Goal**: tool-registry 为唯一权威；三方一致性进门禁；发布含验收步骤

**Independent Test**: 人为制造漂移（registry 加工具不同步），verify:quick 失败并指名漂移工具

- [ ] T026 [US5] 新建 `tests/tool-contract-drift.test.mjs`：`src/agent-gateway/tool-registry.js` ↔ `plugins/brainx-openclaw/openclaw.plugin.json` ↔ `tests/fixtures/openclaw-production/plugin-contract.json` 三方工具名与参数 schema 一致性断言
- [ ] T027 [US5] `deploy/openclaw/install.sh` 或部署文档补「发布后验收」步骤：插件文件清单核对 + 工具数核对，缺失即失败（对接 docs/standards/PRE_PUSH_VERIFICATION.md）

**Checkpoint**: SC-007 成立——接口漂移 100% 被门禁拦截

---

## Phase 8: Polish & Cross-Cutting

- [ ] T028 文档收口：`docs/README.md` 任务路由更新（dispatcher/反馈环/事件目录条目）；`docs/workflow-hub-architecture.md` 加一行指向本规格的回填说明
- [ ] T029 按 `specs/019-hub-event-backbone/quickstart.md` 场景 1-5 全部跑通并记录证据；`npm test` 全量 + `npm run verify` 完整门禁通过
- [ ] T030 每个原子任务 commit 均已同步 docs/AGENT_COMMIT_LOG.md（逐条核对）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖
- **Foundational (Phase 2)**: 依赖 Phase 1——T002/T003 被 US1/US2/US3 全部引用
- **US1 (Phase 3)**: 依赖 Phase 2；为 US3 供料
- **US2 (Phase 4)**: 依赖 Phase 2；与 US1 无代码依赖，但建议 US1 先行（事件契约先冻结，dispatcher 消费者迁移才有稳定目标）
- **US3 (Phase 5)**: 依赖 US1（事件原料）；US2 未完成时可用既有 worker 定时触发过渡
- **US4/US5 (Phase 6/7)**: 地基任务相互独立，依赖 Phase 2 即可
- **Polish (Phase 8)**: 依赖全部完成的故事

### Parallel Opportunities

- T005-T009 五个补事件任务改不同文件，全部可并行
- T012 与 T013/T014 测试先行后可并行实现（不同文件）
- US4（T024/T025）与 US5（T026/T027）互不依赖，可与 US3 并行

### Parallel Example: User Story 1

```bash
# T005-T009 五个发射点改造可并行（不同文件）：
Task: "tools-actions.js acceptJob 补发 job.accepted"
Task: "replay.js recordOutcome 补发 job.terminal_recorded"
Task: "job-extract/confirm.js 补发 job_fact.reviewed"
Task: "judgment-extract/confirm.js 补发 job_fact.reviewed"
Task: "openmai-delivery.js 补发 sourcing.search_finished"
```

---

## Implementation Strategy

### MVP First

1. Phase 1 + Phase 2（基座）
2. Phase 3（US1 业务事件）→ 独立验证 → 可单独交付（反馈环原料就绪）
3. Phase 4（US2 dispatcher）→ 独立验证 → 交付（错误可调度、bridge 解堵）

### Incremental Delivery

US1 → US2 → US3 → (US4 ∥ US5) → Polish。每个故事完成即原子 commit + 门禁，不积压。

## Notes

- 宪法 IV：T004/T012/T020 三个测试任务必须先写且能失败，再写实现
- 每个 Phase 末尾的 commit 任务包含 docs/AGENT_COMMIT_LOG.md 同步
- T016 是本期风险最高的任务（动 bridge-producer 与两个抽取消费者），实施时先跑通既有 job-extract/judgment-extract 全部测试作为回归基线

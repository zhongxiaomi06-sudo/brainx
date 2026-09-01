# Tasks: Step 0 事件账本与幂等消费

**Input**: [spec.md](spec.md) · [plan.md](plan.md) · [data-model.md](data-model.md)

**Tests**: 必须包含——constitution 第 IV 条测试先行；每个任务的测试写在实现之前且初始为失败状态。

**施工者**: Codex。**完成定义**: [quickstart.md](quickstart.md) 核对清单全勾 + `npm run verify:quick` 通过 + 独立 commit（遵守根目录 AGENTS.md 工作锁与提交规范）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，无依赖）
- **[Story]**: 所属用户故事（spec.md 定义 US1-US4）

## Phase 1: 迁移与骨架（无依赖，可并行）

- [ ] **T001** [P] US1 `migrations/0023_workflow_event_log.sql`：按 [data-model.md](data-model.md) 建账本表 + `idx_wel_idem` 唯一索引 + `idx_wel_case`；登记 schema_migrations
- [ ] **T002** [P] US2 `migrations/0024_processed_events.sql`：消费幂等标记表，`UNIQUE(event_id, consumer_name)`
- [ ] **T003** [P] US4 `migrations/0025_entity_links.sql`：跨系统 ID 链接表
- [ ] **T004** [P] US3 `migrations/0026_cases.sql`：Case 表（含 version 乐观锁列、`UNIQUE(position_id, candidate_ref)`）
- [ ] **T005** [P] US1 `migrations/0027_event_dlq.sql`：DLQ 等价表

## Phase 2: US1 事件只落账一次（P1，最高优先）

- [ ] **T006** US1 `tests/hub-event-log.test.mjs` + `tests/fixtures/step0/`：**先写测试**——重复 idem_key 幂等、1000 次投递恒 1 行、并发双连接写入、信封缺字段拒绝（SC-001/002 相关用例）；初始运行必须失败
- [ ] **T007** US1 `src/hub/envelope.js`：zod 信封 schema（event_id/idem_key/event_type/case_id/actor/occurred_at/payload/evidence_refs/schema_version）+ `validateEnvelope()`；evidence_refs 元素必须是 {table, id} 引用
- [ ] **T008** US1 `src/hub/event-log.js`：`appendEvent()`——校验信封 → INSERT，冲突时读回既有行返回；≤80 行

## Phase 3: US2 消费者幂等（P1）

- [ ] **T009** US2 `tests/hub-consumer.test.mjs`：**先写测试**——恰好一次执行、已处理跳过、中途崩溃重放后状态一致（用事务内抛错注入）
- [ ] **T010** US2 `src/hub/consumer.js`：`consumeOnce(eventId, consumerName, fn)`——单事务内：查 processed_events → 执行 fn(db) → 插 processed_events → COMMIT；≤60 行

## Phase 4: US3 Case 状态机（P2）

- [ ] **T011** US3 `tests/hub-case-machine.test.mjs`：**先写测试**——合法相邻推进、非法跳跃拒绝且落 `case.transition_rejected` 事件、双连接并发推进仅一成功（version 冲突）
- [ ] **T012** US3 `src/hub/case-machine.js`：合法迁移表常量 + `advanceCase(caseId, toMilestone)`——`UPDATE ... WHERE case_id=? AND version=?`，rowcount=0 即冲突失败；成功后经 appendEvent 落 `case.stage_advanced`；≤100 行

## Phase 5: US4 身份链接（P3）

- [ ] **T013** US4 `tests/hub-entity-links.test.mjs`：**先写测试**——任一侧 ID 解析全链、重复链接冲突拒绝
- [ ] **T014** US4 `src/hub/entity-links.js`：`linkEntities()` / `resolveEntity(id)`；≤60 行

## Phase 6: upcaster 与门禁收口

- [ ] **T015** US2 `src/hub/upcaster.js` + 测试：schema_version 低于当前时逐级转换；不可转换落 event_dlq（reason=upcast_failed）
- [ ] **T016** 收口：[quickstart.md](quickstart.md) 核对清单逐项验证、`npm run verify:quick`、确认 package.json 依赖变更仅 zod、按 AGENTS.md 提交（每个 Phase 一个原子 commit，中文记录入 docs/AGENT_COMMIT_LOG.md）

## Dependencies

- T006-T008（US1）是 T009-T010（US2）与 T011-T012（US3）的前置：消费与推进都走 appendEvent
- T012 依赖 T004（cases 表）与 T007/T008
- T015 依赖 T005/T008；T016 最后

## Parallel Opportunities

Phase 1 全部五个迁移可并行；Phase 2-5 之间受上述依赖约束，但测试文件编写（T006/T009/T011/T013）可与迁移并行。

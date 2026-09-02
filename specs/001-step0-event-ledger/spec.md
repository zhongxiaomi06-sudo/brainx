# Feature Specification: Step 0 不可逆边界（事件账本与幂等消费）

**Feature Branch**: `001-step0-event-ledger`

**Created**: 2026-09-02

**Status**: Draft（已按[复用与自建边界 PRD](../../docs/prd-2026-09-01-reuse-selfbuild-boundary.md) §3 列为七件必须自建项之首，Codex 施工输入）

**Input**: 依据[全景蓝图](../../docs/architecture-2026-09-01-full-blueprint.md) §5 Step 0 代码逻辑与 [Workflow Hub 架构](../../docs/workflow-hub-architecture.md)第 0 步，落实持久事件账本、消费者幂等、身份链接与 Case 状态推进的最小可运行集。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 事件只落账一次（Priority: P1）

任意生产者（网关、桥、worker）对同一业务事实重试发送时，账本只保留一条事件记录；重复投递不产生第二条账目、不触发二次副作用。

**Why this priority**: 账本是一切跨系统连接（桥 1/桥 2）的信任底座；重复落账会让 Saga 补偿与审计全部失真。

**Independent Test**: 向 `appendEvent()` 投入相同 `idem_key` 两次，账本仅一行，返回值一致；可通过 fixtures 回放独立验证。

**Acceptance Scenarios**:

1. **Given** 账本为空，**When** 以 `idem_key="evt-001"` 写入事件，**Then** 账本新增一行且函数返回该行。
2. **Given** `evt-001` 已存在，**When** 再次以相同 `idem_key` 写入，**Then** 账本行数不变，函数返回既有行且不抛错（幂等成功）。
3. **Given** 两个并发连接同时写相同 `idem_key`，**When** 事务提交，**Then** 账本仅一行（唯一索引 `idx_wel_idem` 兜底），另一方读到既有行。

---

### User Story 2 - 消费者崩溃后重放不产生副作用（Priority: P1）

消费者处理事件中途崩溃（已做一半业务动作），重启重放同一事件时不会重复执行业务动作。

**Why this priority**: 没有 at-least-once + 幂等消费，Saga 与推人循环在 9/8 前都不敢开自动挡。

**Independent Test**: `consumeOnce()` 在业务事务内标记 `processed_events`；用测试注入"标记前崩溃"与"标记后崩溃"两种时序，重放后业务表状态一致。

**Acceptance Scenarios**:

1. **Given** 事件未消费，**When** `consumeOnce()` 成功，**Then** `processed_events` 有记录且业务动作执行恰好一次。
2. **Given** 事件已标记 processed，**When** 再次投递给 `consumeOnce()`，**Then** 直接跳过，业务动作零执行。
3. **Given** 处理中途崩溃（processed 未标记），**When** 重启后重放，**Then** 业务动作以事务整体回滚/重做，最终状态与"恰好一次"一致。

---

### User Story 3 - Case 双轴状态机只按合法路径推进（Priority: P2）

Case（职位×人选）沿 milestone 轴（DISCOVERED→QUALIFIED→CONSENTED→SUBMITTED→INTERVIEW→OFFER→PLACED）与 outreach 轴推进，非法跳转被拒绝且留痕。

**Why this priority**: 状态机是业务事实唯一权威，但演示主线（桥 1）在 9/4 只依赖 P1 的账本；状态机完整推进可略后。

**Independent Test**: 对 `advanceCase()` 依次喂合法与非法迁移序列，断言成功/拒绝结果与账本记录。

**Acceptance Scenarios**:

1. **Given** Case 处于 DISCOVERED，**When** `advanceCase("QUALIFIED")`，**Then** 状态更新、版本号 +1、账本落 `case.stage_advanced`。
2. **Given** Case 处于 DISCOVERED，**When** `advanceCase("OFFER")`，**Then** 拒绝（非法迁移）且账本落 `case.transition_rejected`。
3. **Given** 两个并发 `advanceCase()`，**When** 同时提交，**Then** 仅一个成功（乐观锁版本冲突），另一个显式失败。

---

### User Story 4 - 身份跨系统可解析（Priority: P3）

同一自然人/职位在 BrainX(SQLite)、人才库(MySQL)、reloop、飞书之间的 ID 可通过 `entity_links` 双向解析。

**Why this priority**: 桥 1 联调（9/4）需要 ID 映射，但映射表本身可先建后填。

**Independent Test**: 写入一组 link 后按任一侧 ID 查询得到全部别名。

**Acceptance Scenarios**:

1. **Given** 已写入 (case_id, brainx_id, talent_pool_id, reloop_id, lark_open_id) 链接，**When** 按 reloop_id 查询，**Then** 返回该链全部 ID。
2. **Given** 同一外键被再次链接到新实体，**When** 违反唯一约束，**Then** 写入被拒绝。

### Edge Cases

- 事件负载超过合理体积（>64KB）时如何处理？→ 拒绝入库并在响应中说明（账本存引用不存大对象）。
- `processed_events` 标记成功但业务事务提交失败？→ 同一事务内完成，不存在中间态。
- upcaster：旧版本事件结构到达时，**MUST** 先经 upcast 转换再消费；无法 upcast 的事件进入 DLQ 等价表并告警。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 MUST 提供 append-only 事件账本 `workflow_event_log`，带 `idx_wel_idem` 唯一索引，生产者幂等由 `idem_key` 保证。
- **FR-002**: 系统 MUST 提供 `consumeOnce()` 事务模板：业务动作与 `processed_events` 标记同事务提交。
- **FR-003**: 系统 MUST 提供 `advanceCase()` 乐观锁推进，拒绝非法迁移并留痕。
- **FR-004**: 系统 MUST 提供 `entity_links` 跨系统 ID 链接，任一侧 ID 可解析全链。
- **FR-005**: 事件结构 MUST 经 zod schema 校验后才可入库（信封：event_id/event_type/occurred_at/actor/payload/evidence_refs）。
- **FR-006**: 账本 MUST 只存 `evidence_refs` 引用而非 PII 正文（隐私约束，见群聊工作流 PRD）。
- **FR-007**: 旧结构事件 MUST 经 upcaster 转换；不可转换者进 DLQ 等价表。
- **FR-008**: 全部能力 MUST 零新增 npm 依赖（node:sqlite + node:test + zod）。
- **FR-009**: 每个手写文件 ≤500 物理行；fixtures 回放用例先于实现编写且初始为失败状态（constitution 第 IV 条）。

### Key Entities

- **workflow_event_log**: 单行=一个业务事实；attributes: event_id, idem_key(unique), event_type, case_id, actor, occurred_at, payload, evidence_refs, schema_version。
- **processed_events**: 消费侧幂等标记；attributes: event_id(unique), consumer_name, processed_at。
- **entity_links**: 跨系统身份链接；attributes: case_id, brainx_id, talent_pool_id, reloop_id, lark_open_id。
- **case**: 双轴状态机实体；attributes: case_id, position_id, candidate_ref, milestone, outreach_state, version(乐观锁)。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: fixtures 回放套件全绿：重复事件、崩溃重放、并发推进、非法迁移四类场景各有至少一条用例。
- **SC-002**: 重复投递 1000 次，账本行数恒为 1。
- **SC-003**: 崩溃注入测试下，业务表最终状态与"恰好一次"语义一致。
- **SC-004**: `grep -r workflow_event_log src/ migrations/` 有真实命中（当前为 0）。
- **SC-005**: 零新增 npm 依赖；`npm run verify:quick` 通过。

## Assumptions

- SQLite（node:sqlite, WAL）承载账本；MySQL 侧不在本规格范围（桥 1 另立规格）。
- Case 与事件的最小字段集以 Workflow Hub 架构为准；演示主线外的字段（如 time_quality）后续规格补充。
- 本规格不含 lark-gateway / 能力令牌（Step 1/2 另立规格）。

## 相关文档

- [全景架构与技术施工蓝图 §5](../../docs/architecture-2026-09-01-full-blueprint.md)（分步代码逻辑权威）
- [Workflow Hub 与猎头全链路架构](../../docs/workflow-hub-architecture.md)（契约权威）
- [复用与自建边界及权限需求 PRD §3](../../docs/prd-2026-09-01-reuse-selfbuild-boundary.md)（自建边界）
- [规范驱动研发流程](../../docs/standards/SPEC_DRIVEN_WORKFLOW.md)（流程）

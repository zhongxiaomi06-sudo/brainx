# Implementation Plan: Step 0 不可逆边界（事件账本与幂等消费）

**Branch**: `001-step0-event-ledger` | **Date**: 2026-09-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-step0-event-ledger/spec.md`

## Summary

落实 BrainX 跨系统工作流的信任底座：append-only 事件账本（`workflow_event_log`，`idx_wel_idem` 唯一索引保生产者幂等）、消费者幂等（`consumeOnce()` 同事务标记 `processed_events`）、Case 双轴状态机（`advanceCase()` 乐观锁）、跨系统身份链接（`entity_links`）。全部零新增 npm 依赖（node:sqlite + node:test + 既有约定引入的 zod），fixtures 回放用例先于实现（constitution 第 IV 条）。技术方案在[全景蓝图 §5 Step 0](../../docs/architecture-2026-09-01-full-blueprint.md)已定型，research 阶段结论（sledge 抄设计、reflow-ts 仅条件触发、拒绝 Postgres 系）记录于蓝图 §9/§9.1，本文不重复。

## Technical Context

**Language/Version**: Node.js 22（managed），CommonJS（src/ 现状）

**Primary Dependencies**: 零新增运行时依赖；schema 校验用 zod（蓝图 §6.2 采购清单，随本规格首次落地）；测试用 `node:test`

**Storage**: SQLite（`node:sqlite` DatabaseSync，WAL 模式，复用 `src/db.js` 既有连接与迁移记账 `schema_migrations`）

**Testing**: `node:test` + fixtures 回放（崩溃注入用事务回滚模拟）

**Target Platform**: 本地/服务器单机 Node 进程（server/worker 双进程共享 SQLite WAL）

**Performance Goals**: 单机日均千级事件量级足够（蓝图 §6.1 拍板）；重复投递 1000 次账本行数恒为 1（SC-002）

**Constraints**: 零新增依赖；每文件 ≤500 行；账本 append-only 禁 UPDATE；`evidence_refs` 只存引用不存 PII

**Scale/Scope**: 4 张新表、3 个新模块（约 400-500 行含测试）、不触碰任何既有文件语义

## Constitution Check

| 原则 | 状态 | 说明 |
|---|---|---|
| I 零依赖 | ✅ | 仅引入 zod（已在蓝图 §6.2 采购清单内，属既定决议非新增） |
| II 账本先行 | ✅ | 本规格就是账本本身 |
| III 安全边界 | ✅ | 账本只存 evidence_refs；无 LLM 参与 |
| IV 规格先行 | ✅ | spec → plan → tasks → 测试先行 |
| V 最小 diff | ✅ | 全部新文件，不改既有模块语义 |

## Project Structure

### Documentation (this feature)

```text
specs/001-step0-event-ledger/
├── spec.md              # 已提交（f26a3a9）
├── plan.md              # 本文件
├── data-model.md        # 4 张新表 DDL 与索引
├── quickstart.md        # fixtures 回放运行方法
└── tasks.md             # Phase 2 输出，Codex 施工清单
```

### Source Code (repository root) —— 按仓库既有平铺惯例

```text
migrations/
├── 0023_workflow_event_log.sql   # 账本 + idx_wel_idem
├── 0024_processed_events.sql     # 消费幂等标记
├── 0025_entity_links.sql         # 跨系统 ID 链接
├── 0026_cases.sql                # Case 双轴状态机
└── 0027_event_dlq.sql            # 不可 upcast 事件等价 DLQ

src/hub/                          # 新目录：Workflow Hub 最小集
├── envelope.js                   # zod 事件信封 schema + validateEnvelope()
├── event-log.js                  # appendEvent() 生产者幂等
├── consumer.js                   # consumeOnce() 事务模板
├── case-machine.js               # advanceCase() 乐观锁 + 合法迁移表
├── entity-links.js               # linkEntities() / resolveEntity()
└── upcaster.js                   # schema_version 迁移 + DLQ 落表

tests/
├── hub-event-log.test.mjs        # US1：幂等落账（fixtures 先行）
├── hub-consumer.test.mjs         # US2：崩溃重放
├── hub-case-machine.test.mjs     # US3：合法/非法/并发迁移
├── hub-entity-links.test.mjs     # US4：双向解析
└── fixtures/step0/               # 回放 fixtures（JSON）
```

**Structure Decision**: 遵循仓库现有平铺 + 迁移按序号记账的惯例；`src/hub/` 为蓝图 §4 预留的新代码落点，本规格首次创建。不改 `src/db.js` 以外的任何既有文件。

## Complexity Tracking

无违规项。

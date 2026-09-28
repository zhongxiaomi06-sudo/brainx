# Implementation Plan: Hub 事件骨干重整

**Branch**: `main`（本仓库以 main 直接协作） | **Date**: 2026-09-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/019-hub-event-backbone/spec.md`

## Summary

把「骨架真实、血肉绕开骨架」的现状补齐为三处形态改造，顺序按 2026-09-22 架构核实报告修正：**①业务动作补发标准信封事件**（接入工作，动作都在只是没走账本）→ **②dispatcher 调度层**（消费移出 bridge 同步调用栈，注册表 + 异步 + DLQ）→ **③反馈环**（消费业务事件产出可测量指标）。P2/P3 项（session 隔离下沉、接口面收敛）在本期只落地基与门禁，完整形态各立子规格。

技术路线：全部在既有 `src/hub/` 骨架上扩建（appendEvent/consumeOnce/event_dlq 已存在且经生产验证），零新增运行时依赖；异步 LLM 的形状错配以「prepare（异步）→ apply（同步事务内）」两段式消费者解决，删除 presetFields 注入 hack。

## Technical Context

**Language/Version**: Node.js ≥ 22.13（生产 v26；`node:sqlite`/`node:test` 内置能力）

**Primary Dependencies**: 现有 4 个运行时依赖（mysql2、zod、@larksuiteoapi/node-sdk、pino），本期不新增

**Storage**: SQLite（WAL）`data/brainx.db`；人才库 RDS MySQL（只读引用，不在本期写入路径）

**Testing**: `node --test tests/*.test.mjs`；门禁 `npm run verify:quick` / `npm run verify`

**Target Platform**: Linux server（ECS，systemd 常驻进程：bridge / agent-gateway / integration-worker + 本期新增 dispatcher）

**Project Type**: 后端服务 + 飞书通道插件

**Performance Goals**: 消息落账到派发中位滞后 < 1 分钟；dispatcher 单轮空转 < 200ms；目标规模 15 万条消息/天（≈1.7 条/秒均值）

**Constraints**: 手写文件 ≤500 物理行；事件 payload 不含 PII（evidence_refs 引用制，64KB 上限已存在）；LLM 调用必须有 kill-switch；append-only 账本不可 UPDATE/DELETE

**Scale/Scope**: 300+ 顾问、每日 12-15 万条消息；5 个用户故事，其中 US1/US2 为本期施工主体

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 判定 | 依据 |
|---|---|---|
| I. 零依赖优先 | ✅ 通过 | dispatcher/注册表/DLQ/反馈汇总全部自建（Node 内置 + 既有 zod）；明确拒绝 BullMQ/Temporal |
| II. 账本先行 | ✅ 通过 | 本期正是把业务动作收进账本；不改 append-only 语义，修正以补偿事件表达 |
| III. 安全边界 | ✅ 通过 | LLM 不参与权限判断；事件 payload 无 PII（envelope.js 既有校验沿用）；隔离裁决在 gateway decide() 侧 |
| IV. 规格先行 | ✅ 通过 | 本规格→plan→tasks 流程；每个事件类型先写回放用例（必须能失败）再实现 |
| V. 最小 diff | ✅ 通过 | 复用 appendEvent/consumeOnce/event_dlq/runWorkerOnce 模式；新增文件各自 <500 行 |

## Project Structure

### Documentation (this feature)

```text
specs/019-hub-event-backbone/
├── plan.md              # 本文件
├── research.md          # Phase 0 输出：异步消费形态/事件类型清单/反馈口径
├── data-model.md        # Phase 1 输出：事件类型 + feedback_metrics + DLQ 字段
├── quickstart.md        # Phase 1 输出：端到端验证场景
├── contracts/
│   └── event-types.md   # 业务事件类型目录（信封契约）
└── tasks.md             # /speckit.tasks 产出（本命令不生成）
```

### Source Code (repository root)

```text
src/
├── hub/
│   ├── event-log.js         # 既有：appendEvent（不动）
│   ├── consumer.js          # 既有 consumeOnce + 本期新增 consumeOnceAsync 两段式包装
│   ├── dispatcher.js        # 新增：注册表 + 未消费扫描 + 重试/DLQ 派发
│   └── upcaster.js          # 既有（不动）
├── agent-gateway/
│   └── tools-actions.js     # 改造点：acceptJob 补发 job.accepted 事件
├── replay.js                # 改造点：recordOutcome 补发 job.terminal_recorded 事件
├── job-extract/confirm.js   # 改造点：confirm/reject 补发 job_fact.reviewed 事件
├── judgment-extract/confirm.js  # 同上（judgment 域）
├── openmai-delivery.js      # 改造点：找人结果补发 sourcing.search_finished 事件
├── job-extract/bridge-producer.js  # 改造点：移出消费调用，只落原文+账本
├── bridge.js                # 改造点：调用点瘦身（329/361 两处）
├── feedback/
│   └── rollup.js            # 新增：反馈环消费者 + 周期汇总
└── integration-jobs/
    └── worker.js            # 既有 runWorkerOnce 模式（dispatcher 宿主参照，不动）

bin/
└── brainx-dispatcher.mjs    # 新增：dispatcher 常驻进程入口（systemd 单元同 worker 模式）

migrations/
└── 0052_feedback_metrics.sql  # 新增：反馈指标快照表

tests/
├── hub-dispatcher.test.mjs        # 新增：派发/重试/DLQ/注册即生效/故障隔离
├── business-events.test.mjs       # 新增：五类动作产事件 + 幂等
└── feedback-rollup.test.mjs       # 新增：指标口径可重算
```

**Structure Decision**: 单仓库后端结构不变；新增模块全部落在既有分层内（hub=账本层、feedback=新消费者域、bin=进程入口），与 specs/001 既定结构一致。500 行限制下 dispatcher 与 rollup 各自独立成文件。

## Complexity Tracking

无违反宪法的复杂度项。dispatcher 自建而非引入 BullMQ/Temporal 的论证见 research.md 决策 1。

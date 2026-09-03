# BrainX Constitution

## Core Principles

### I. 零依赖优先（NON-NEGOTIABLE）
核心链路只用 Node 内置模块（`node:sqlite`/`node:crypto`/`node:test`/`node:http`）；引入新 npm 依赖必须证明"自研成本 > 引入成本"且过质量门禁。运行时依赖上限 4 个（mysql2 + zod + @larksuiteoapi/node-sdk + pino；reflow-ts 仅条件触发）。拒绝 Kafka/Express/Prisma/LangChain/BullMQ 及一切 Postgres 系执行引擎。

### II. 账本先行，不可逆边界优先
任何功能动工前，先落 Step 0 不可逆边界：`workflow_event_log` 持久账本、`processed_events` 消费者幂等、`entity_links` 身份映射、Case 双轴状态机。禁止把会被覆盖的 Markdown 当事实存储；一切跨系统连接只认 `case_id`。

### III. 安全边界不可协商
LLM 永不参与权限判断——`decide()` 决策表是唯一裁决权威，模型只消费五态输出（ALLOW/DENY/ALLOW_WITH_REDACTION/REQUIRE_CONFIRMATION/REQUIRE_INTERNAL_APPROVAL）。未登记群默认 DENY；外部只见 `disclosure_bundles` 白名单投影，不见表；能力令牌单次有效；禁止 `execute_shell` 与任意 http 出口类通用工具。

### IV. 规格先行（Test-First）
新功能先经 spec-kit 流程：`/speckit.specify` 规格 → `/speckit.clarify` 去歧义 → `/speckit.plan` 技术方案 → `/speckit.tasks` 拆任务 → `/speckit.implement` 施工。规格批准后先写 node:test 回放用例（必须能失败），再写实现；fixtures 回放全绿是每个 step 的完成门禁。

### V. 最小 diff 与可独立审查
优先复用现有函数/模式，其次标准库，最后才写新代码；每个手写文件 ≤ 500 物理行；一个 commit 只做一个原子任务并同步 `docs/AGENT_COMMIT_LOG.md` 中文记录；文档与代码不得脱节——流程/架构/权限决策必须落 Markdown 并登记 `docs/README.md`。

## Additional Constraints

- **时间盒**：一切施工对齐 14 天作战计划（9/3 全员使用 → 9/4 桥 1 联调 → 9/8 推人循环 → 9/14 决赛）；阶段验收不绑定具体日期，但演示主线节点不可顺延。
- **成本控制**：LLM 调用必须有 kill-switch（如 `AI_ENABLED`）；token 用量可观测。
- **权限最小集**：飞书 scope 仅 `im.message.receive_v1`、`im:message:send_as_bot`、`im:chat:readonly` + 卡片回调；Agent-facing MySQL 账号只读，确定性同步 worker 使用与 Agent 分离的最小 DML 账号，DDL 仅允许临时迁移账号；超出即退回重审（见[复用与自建边界 PRD](../../docs/prd-2026-09-01-reuse-selfbuild-boundary.md) §4）。

## Development Workflow

- 协作边界（工作锁、commit 规范、push 门禁）以根目录 `AGENTS.md` 为准，constitution 与其并行生效、冲突时 AGENTS.md 优先；
- 每个自建件（账本/状态机/权限引擎/投影/令牌/Saga）必须先有 spec-kit 规格，作为 Codex 施工输入；
- 质量门禁：`npm run verify:quick` 期间快速反馈，push 前 `npm run verify` 全量通过。

## Governance

- 本 constitution 约束所有 Agent 与人类协作者；修订必须：改文档 → 登记总目录 → commit 说明修订理由；
- 复杂性必须证明价值；安全原则（I/II/III）不可被任何"临时绕过"稀释；
- 运行时开发指引见 `docs/README.md` 任务路由。

**Version**: 1.0.1 | **Ratified**: 2026-09-01 | **Last Amended**: 2026-09-03

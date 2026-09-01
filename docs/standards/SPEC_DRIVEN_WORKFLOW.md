# 规范驱动研发流程（spec-kit）

> 上级入口：[文档书总目录](../README.md) · 相关规则：[上传前完整验证](PRE_PUSH_VERIFICATION.md)

本仓库自 2026-09-01 起接入 [github/spec-kit](https://github.com/github/spec-kit) 做规格驱动开发（Spec-Driven Development）。本文说明它在本仓库的用法，以及与既有协作准则的分工。

## 1. 定位与分工

| 层 | 文件 | 管什么 |
|---|---|---|
| 协作边界 | 根目录 `AGENTS.md` | 工作锁、commit 规范、push 门禁、文档登记——谁在什么时候能写什么 |
| 工程原则 | `.specify/memory/constitution.md` | 零依赖、账本先行、安全边界、规格先行、最小 diff——写代码时必须遵守什么 |
| 单功能规格 | `specs/<branch>/spec.md` 等 | 每个功能的规格、方案、任务清单——这次具体做什么 |

冲突时：用户当前指令 > `AGENTS.md` > constitution > 单功能规格。

## 2. 环境与安装

- CLI：`specify` v1.0.4（`uv tool install specify-cli --from git+https://github.com/github/spec-kit.git`；升级用 `uv tool upgrade specify-cli`）。
- 仓库产物：`.specify/`（模板、脚本、workflow、constitution）+ `.codebuddy/commands/speckit.*.md`（10 个命令）。

## 3. 单功能流程

1. `/speckit.constitution`——修订工程原则（低频，改完必须登记总目录）；
2. `/speckit.specify <功能描述>`——生成规格（做什么、为什么、验收标准）；
3. `/speckit.clarify`（可选，推荐）——对模糊点结构化提问；
4. `/speckit.plan`——技术方案（选型必须符合 constitution 第 I 条零依赖原则）；
5. `/speckit.checklist`（可选）——需求完整性检查；
6. `/speckit.tasks`——拆任务；
7. `/speckit.analyze`（可选）——跨产物一致性核对；
8. `/speckit.implement`——按任务施工，先写能失败的 node:test 回放用例，再实现。

## 4. 与 14 天作战计划的关系

[复用与自建边界 PRD](../prd-2026-09-01-reuse-selfbuild-boundary.md) §3 的七件必须自建项（账本/状态机/五信任域/能力令牌/权限引擎/投影/Saga）应逐项转成 spec-kit 规格，作为 Codex 等施工 Agent 的输入；演示主线（桥 1、推人循环）优先建规格。

## 5. 注意事项

- spec-kit 模板与脚本是第三方资产，升级 CLI 后如产物变化，diff 核对后再提交；
- `.specify/` 与 `.codebuddy/commands/` 随仓库提交，团队成员无需重复 init；
- constitution 修订 = 文档变更，必须走 commit + `docs/AGENT_COMMIT_LOG.md` 记录。

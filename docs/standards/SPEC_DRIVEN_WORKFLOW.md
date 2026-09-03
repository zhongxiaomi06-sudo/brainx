# 规范驱动研发流程（spec-kit）

> 上级入口：[文档书总目录](../README.md) · 相关规则：[上传前完整验证](PRE_PUSH_VERIFICATION.md)

本仓库自 2026-09-01 起接入 [github/spec-kit](https://github.com/github/spec-kit) 做规格驱动开发（Spec-Driven Development）。本文说明它在本仓库的用法，以及与既有协作准则的分工。

## 1. 定位与分工

| 层 | 文件 | 管什么 |
|---|---|---|
| 协作边界 | 根目录 `AGENTS.md` | 工作锁、commit 规范、push 门禁、文档登记——谁在什么时候能写什么 |
| 产品目标 | `docs/prd-2026-09-02-brainx-workflow.md` | 唯一项目产品 PRD——为什么做、为谁做、产品边界与产品 DoD |
| 工程原则 | `.specify/memory/constitution.md` | 零依赖、账本先行、安全边界、规格先行、最小 diff——写代码时必须遵守什么 |
| 单功能规格 | `specs/<feature>/spec.md` 等 | 每个功能的规格、方案、任务清单——这次具体做什么 |
| 状态证据 | CI、质量门禁、审核台账、Commit 记录 | 当前 commit 是否真的实现、发布并经真实数据验证 |

冲突时：用户当前指令 > `AGENTS.md` > constitution > 单功能规格。

## 2. 环境与安装

- CLI：从 GitHub 官方 `v1.0.2` 标签固定安装；该标签当前的包元数据与 `specify version` 均显示 `1.0.4.dev0`，因此以标签和安装提交作为来源证据。升级前必须先获得确认并审查生成文件 diff。
- 共享产物：`.specify/`（模板、脚本、workflow、constitution）。
- CodeBuddy 入口：`.codebuddy/commands/speckit.*.md`（10 个 `/speckit.*` 命令），保留为默认集成。
- Codex 入口：`.agents/skills/speckit-*/SKILL.md`（10 个 `$speckit-*` skills），与 CodeBuddy 并存。

全局 Codex 门禁位于 `~/.codex/AGENTS.md` 和 `~/.codex/skills/spec-kit-workflow/`：新项目会话首次准备写入且未发现 `.specify/` 时，必须先询问是否启用，不得静默初始化。

## 3. 单功能流程

以下使用逻辑命令名；CodeBuddy 用 `/speckit.<command>`，Codex 用 `$speckit-<command>`。

1. `constitution`——修订工程原则（低频，改完必须登记总目录）；
2. `specify <功能描述>`——生成规格（做什么、为什么、验收标准）；
3. `clarify`（可选，推荐）——对模糊点结构化提问；
4. `plan`——技术方案（选型必须符合 constitution 第 I 条零依赖原则）；
5. `checklist`（可选）——需求完整性检查；
6. `tasks`——拆任务；
7. `analyze`（可选）——跨产物一致性核对；
8. `implement`——按任务施工，先写能失败的 node:test 回放用例，再实现；
9. `converge`——对照 spec、plan、tasks 收敛剩余差异，直到报告 Converged。

每个 feature 目录固定使用以下职责，禁止把动态状态重新写成第二份项目 PRD：

```text
specs/<NNN-feature>/
├── spec.md       # 用户场景、需求边界、验收标准（做什么）
├── plan.md       # 架构选择、数据模型、接口与验证策略（怎么做）
├── tasks.md      # 依赖有序、可勾选、能对应到文件和测试的任务
├── research.md   # 仅在确有调研结论时存在
├── data-model.md # 仅在涉及数据模型时存在
└── quickstart.md # 联调或人工验收步骤
```

同一时刻只激活一个待实现 feature。没有激活 feature 且已有规格均完成时属于正常状态；维护性修复可以由失败测试、Commit 记录和 PR 直接追踪，但若改变产品行为、接口契约或数据模型，必须新建或激活 feature 后再施工。

## 4. 与 14 天作战计划的关系

[复用与自建边界 PRD](../prd-2026-09-01-reuse-selfbuild-boundary.md) §3 的七件必须自建项（账本/状态机/五信任域/能力令牌/权限引擎/投影/Saga）应逐项转成 spec-kit 规格，作为 Codex 等施工 Agent 的输入；演示主线（桥 1、推人循环）优先建规格。

## 5. 注意事项

- spec-kit 模板与脚本是第三方资产，升级 CLI 后如产物变化，diff 核对后再提交；
- `.specify/`、`.codebuddy/commands/` 与 `.agents/skills/` 随仓库提交，团队成员无需重复 init；
- constitution 修订 = 文档变更，必须走 commit + `docs/AGENT_COMMIT_LOG.md` 记录。

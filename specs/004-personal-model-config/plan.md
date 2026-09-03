# Implementation Plan: 顾问个人模型配置

**Branch**: `codex/braintex-deployment-manual` | **Date**: 2026-09-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-personal-model-config/spec.md`

## Summary

将当前共享 StepFun 默认模型改为飞书私聊“一人一 OpenClaw Agent”。官方 Feishu 动态 Agent 负责建立独立 workspace、session、agentDir 和认证库；BrainX 工作台提供已登录顾问的自助配置页，通过受控、无 shell 的 OpenClaw CLI 子进程把密钥从 stdin 写入本人认证库，并只把供应商、模型、同意和状态写入 BrainX 审计表。共享 Skills 改装到 state 级目录供所有个人 Agent 使用；共享群不借用个人密钥。

## Technical Context

**Language/Version**: Node.js 24、JavaScript ESM、React/TypeScript

**Primary Dependencies**: Node 内置 `node:child_process`、`node:crypto`、`node:sqlite`、现有 OpenClaw 2026.7.1-2；不新增 npm 运行时依赖

**Storage**: BrainX SQLite 只保存非敏感个人模型状态和同意；OpenClaw 每 Agent SQLite 保存 API Key；OpenClaw JSON 保存 Agent 路由和非敏感模型引用

**Testing**: `node:test`、现有前端静态适配测试、OpenClaw 临时 state 集成测试、生产只读/真机验收

**Target Platform**: Ubuntu ECS systemd、飞书 iOS/桌面端、现代浏览器 HTTPS 工作台

**Project Type**: Node 单体 Web 服务 + OpenClaw Gateway/插件 + React 工作台

**Performance Goals**: 状态读取 3 秒内；配置操作 15 秒内成功或明确失败；同一顾问并发配置串行；不增加每次普通 Agent 问答的额外模型调用

**Constraints**: API Key 不进入参数列表、日志、URL、业务库或浏览器存储；个人模型仅用于私聊；无配置时失败关闭；动态 Agent 上限 20；现有服务器磁盘空间紧张，不引入容器或大型依赖

**Scale/Scope**: 首批 6 名顾问、最多 20 个动态 Agent、4 个批准供应商；架构可扩展但本次不开放任意自定义 Base URL

## Constitution Check

*GATE: PASS before research; PASS after design.*

| Principle | Result | Evidence |
|---|---|---|
| I 零依赖优先 | PASS | 复用 OpenClaw CLI 与 Node 内置模块，不新增依赖 |
| II 账本先行 | PASS | 非敏感配置/同意先入迁移表；凭据由 OpenClaw 认证库存储 |
| III 安全边界 | PASS | 飞书可信身份与 Web session 双路绑定；LLM 不参与身份；禁 Shell、任意 URL 和跨 Agent 会话 |
| IV 规格先行 | PASS | `spec.md` 与质量清单完成；先写配置、接口、权限和泄密负向测试 |
| V 最小 diff | PASS | 扩展现有 server route、设置中心、安装器和生产配置；每个新文件 ≤500 行 |
| 成本控制 | PASS | 配置状态不调用模型；不自动探测消耗额度；调用失败有限超时 |
| 权限最小集 | PASS | 个人 Agent 继承既有 BrainX 工具白名单，API Key 只写本人 agentDir |

## Project Structure

### Documentation (this feature)

```text
specs/004-personal-model-config/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/model-profile-api.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
migrations/
└── 0036_consultant_model_profiles.sql

src/
├── personal-model-config.js
├── personal-model-routes.js
└── server.js

frontend/btex-frontend/app/
├── personal-model-api.ts
├── personal-model-panel.tsx
├── personal-model-panel.css
├── settings-center-review.tsx
└── workbench-settings-page.tsx

deploy/openclaw/
├── openclaw.production.json
├── openclaw.env.example
└── install.sh

plugins/brainx-openclaw/
└── onboarding.js

tests/
├── personal-model-config.test.mjs
├── personal-model-routes.test.mjs
├── personal-model-ui.test.mjs
└── openclaw-production-config.test.mjs
```

**Structure Decision**: 继续使用现有单仓 Node/React/OpenClaw 部署，不建立第二个 Web 服务。OpenClaw 命令适配封装在独立模块并可注入测试替身；主服务只通过固定可执行文件、固定参数数组和 stdin 传递密钥。

## Complexity Tracking

无 constitution 例外。个人认证写入必须调用 OpenClaw 自有 CLI，不能直接写其内部 SQLite schema；这是复用稳定契约而不是引入新服务。

# Implementation Plan: 群消息到职位事实运行闭环

**Branch**: `codex/york-gray-release` | **Date**: 2026-09-03 | **Spec**: [spec.md](spec.md)

## Summary

在现有 `brainx-worker → workflow_event_log/lark_messages → job_facts_drafts` 链路上补齐安全群登记、本人可见草稿列表与显式确认工具，并完成六名在职顾问的生产灰度。York 仅是业务展示主体；稳定技术账号承载飞书渠道；每次权限判断和审计继续使用真实 `open_id → consultant_id`。Otto 只做可恢复撤权，不删除历史。

## Technical Context

**Language/Version**: Node.js 22（ESM）

**Primary Dependencies**: Node 内置模块、现有 OpenClaw plugin SDK、现有 SQLite 封装；不新增依赖

**Storage**: `/opt/brainx/data/brainx.db`（SQLite/WAL）；既有 RDS 人才域保持独立

**Testing**: `node:test`，`npm run verify:quick`，`npm run verify`

**Target Platform**: 阿里云 ECS、systemd、nginx、飞书长连接

**Project Type**: 单仓库 Web/API + Worker + Agent Gateway + OpenClaw 插件

**Performance Goals**: 已登记群消息 10 秒内形成草稿；草稿列表返回不超过 20 条；工具调用 10 秒超时

**Constraints**: 默认拒绝；群必须显式登记；真实操作者不可被 York 替代；写操作须 `confirm=true`；不向模型发送手机号、邮箱或完整简历；不开放通用 SQL/网络/文件工具

**Scale/Scope**: 首轮 6 名在职顾问、已核验灰度群、467 条存量待审草稿；后续逐群扩容

## Constitution Check

- **零依赖优先**：通过，复用现有数据库、工具注册表和插件运行时。
- **账本先行**：通过，消息已有持久账本和幂等消费者；确认沿用草稿与血缘表。
- **安全边界**：通过，群登记、身份绑定和资源关系由确定性代码裁决，LLM 不参与授权。
- **规格先行/Test-First**：通过，先补规格、契约和失败测试，再实现。
- **最小 diff**：通过，只新增草稿审阅 handler，扩展既有工具目录与部署契约。
- **生产门禁**：部署前必须备份 SQLite/环境/systemd/nginx，完整质量门禁通过并保留回滚 commit。

## Project Structure

```text
src/
├── agent-gateway/
│   ├── tool-registry.js
│   └── tools-job-facts.js
├── gateway/chat-contexts.js
└── job-extract/confirm.js
plugins/brainx-openclaw/runtime.js
deploy/openclaw/openclaw.production.json
bin/brainx-lark-gateway.mjs
tests/agent-job-facts-tools.test.mjs
specs/003-group-message-job-facts-loop/
```

**Structure Decision**: 草稿审阅进入现有 Agent Gateway 窄工具面；OpenClaw 不读取 SQLite、不复用旧 MCP 宽工具面。群同步继续由 `brainx-worker` 承担，`chat_contexts` 是唯一群登记权威。

## Delivery Phases

1. 测试先行：本人可见、跨人拒绝、Otto inactive 拒绝、确认幂等。
2. 增加 pending/review 两个 Gateway 工具并加入 OpenClaw allowlist。
3. 备份生产，停用 Otto，登记首轮已授权群，部署并重启相关服务。
4. 六人私聊与灰度群验收，观察日志与积压；通过后再迁移 York 展示主题和稳定技术账号名称。

## Post-design Constitution Check

设计未新增依赖、未新增数据库表、未扩大模型数据面，也未把历史 108 个群自动授权。写工具强制私聊和显式确认，满足最小权限与审计要求。

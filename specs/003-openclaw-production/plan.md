# Implementation Plan: OpenClaw 多顾问生产化

**Branch**: `codex/feishu-agent-prd-20260901` | **Date**: 2026-09-03 | **Spec**: [spec.md](spec.md)

## Summary

在不改变现有 Web/MCP 对外语义的前提下，新增三块最小组件：服务端只读 Agent Gateway、OpenClaw 原生工具插件、可恢复的人才数据 worker。生产 OpenClaw 与 BrainX 同机部署，插件通过回环 HTTP 调 Gateway；nginx 只公开现有 BrainX HTTPS 页面。身份只来自 OpenClaw 运行时的 Feishu sender/account/delivery context，经短时 HMAC 主体声明传递，模型参数不含 tenant/consultant/sender/scope。Gateway 完成 App 维度绑定、群范围、对象授权、字段投影、审计、限流和幂等后才调用现有领域函数。

## Technical Context

**Language/Version**: BrainX 使用 Node.js >=22.5 ESM；生产固定 Node 24 LTS 镜像/安装版本。OpenClaw 与插件固定 `2026.7.1-2`。

**Primary Dependencies**: BrainX 继续使用现有 `mysql2`、`zod`、`@larksuiteoapi/node-sdk`；插件单独使用 OpenClaw peer dependency 和官方示例要求的 `typebox@1.1.39`。PDF/DOCX 解析器是隔离的可选 Python worker，固定 MarkItDown 版本，不进入 Node 核心依赖。

**Storage**: SQLite 保存身份绑定、群范围、Agent 审计、nonce、任务和 outbox；MySQL RDS 保存人才授权、文档、事实、证据、职位条件、匹配运行和同步游标。

**Testing**: `node:test` 契约/负向/重放/HTTP 集成测试；插件使用本机锁定 OpenClaw 的运行时 inspect 与打包安装测试；人才解析使用脱敏 fixtures；生产用飞书私聊、白名单群和 HTTPS 深链烟雾测试。

**Target Platform**: 阿里云 ECS systemd。`brainx.service` 监听 127.0.0.1:3101；`brainx-agent-gateway.service` 监听 127.0.0.1:3102；OpenClaw Gateway 只监听回环并通过官方 Feishu WebSocket 出站连接。nginx 仅公开 `https://base.yorkteam.cn`。

**Constraints**: 首期业务只读；Gateway 不公网开放；不记录完整 prompt/简历/密钥；每个手写文件 ≤500 行；每个外部调用有超时；RDS 不可用 fail-closed；不改变正式排序直到评测签署。

**Scale/Scope**: 首批 1 个租户、3 名以内灰度顾问、2 个白名单群、至少 383 份 Mia 授权结构化档案；架构支持继续增加同租户白名单顾问，不包含跨租户自助开通和计费。

## Constitution Check

| 原则 | 设计结论 | 证据 |
|---|---|---|
| I 零依赖优先 | ✅ BrainX 不新增 Node 运行时依赖；插件依赖为官方契约要求且包内隔离；解析 worker 独立部署 | [research.md](research.md) R1/R6 |
| II 账本先行 | ✅ Agent run/tool call、nonce、integration job/outbox 先迁移后接工具；跨库只认稳定 request/run/job/ref | [data-model.md](data-model.md) |
| III 安全边界 | ✅ 服务端唯一授权；未绑定/未登记默认 DENY；模型不能提供身份；工具白名单和字段投影双重执行 | [contracts/agent-gateway.md](contracts/agent-gateway.md) |
| IV 规格先行 | ✅ spec → plan → tasks；所有非平凡实现先写失败测试 | [tasks.md](tasks.md) |
| V 最小 diff | ✅ 独立 Gateway 进程避免继续扩张 666 行 `src/server.js`；复用现有领域函数和人才契约 | 本计划结构 |

## Architecture

```text
飞书客户端（顾问无需本机安装）
  → OpenClaw 官方 Feishu 插件（WS、allowlist、会话隔离）
  → BrainX 原生 OpenClaw 工具插件
      · 读取 requesterSenderId / deliveryContext / accountId
      · 生成短时 HMAC assertion，固定 Gateway URL
  → 127.0.0.1:3102 BrainX Agent Gateway
      · 服务 token + assertion 验签 + nonce 消费
      · App 身份映射 + 群 scope + 对象/字段授权
      · 只读工具分发 + 统一 envelope + 审计/限流
  → SQLite 决策域 / RDS 人才域 / 持久 worker

浏览器/卡片
  → https://base.yorkteam.cn
  → 飞书 OAuth + Web 现有对象权限再次校验
```

## Project Structure

### Documentation

```text
specs/003-openclaw-production/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/agent-gateway.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
```

### BrainX source

```text
migrations/
├── 0032_agent_gateway.sql
└── 0033_integration_jobs.sql

src/agent-gateway/
├── assertion.js          # canonical JSON、HMAC、过期、body hash
├── audit.js              # run/tool call 生命周期和脱敏摘要
├── authorization.js      # App 身份、群范围、用途、对象裁决
├── envelopes.js          # 统一成功/错误 envelope
├── rate-limit.js         # 按主体/工具固定窗口限流
├── tool-registry.js      # 唯一生产工具白名单
├── tools-jobs.js         # me/daily/job/gap/personal review
├── tools-talent.js       # shortlist/facts/fit/interview prep
└── server.js             # 回环 HTTP，body cap、超时、路由

src/integration-jobs/
├── repository.js         # PENDING/RUNNING/终态、租约和恢复
├── outbox.js             # 原会话通知可靠投递
└── worker.js             # 有界轮询、取消、失败收口

src/talent-pipeline/
├── grants.js             # 授权与撤权传播
├── sync-cursor.js        # 结构化来源增量游标
├── document.js           # hash、质量状态、解析作业
├── facts.js              # candidate_fact_v1 持久化
└── evaluation.js         # 固定集与排序报告

bin/
├── brainx-agent-gateway.mjs
├── brainx-agent-admin.mjs
└── brainx-integration-worker.mjs

plugins/brainx-openclaw/
├── package.json
├── openclaw.plugin.json
└── src/
    ├── index.js
    ├── context.js
    ├── signer.js
    ├── client.js
    └── tools.js

deploy/systemd/
├── brainx-agent-gateway.service
├── brainx-integration-worker.service
└── openclaw-brainx.service
```

### Tests

```text
tests/
├── agent-assertion.test.mjs
├── agent-authorization.test.mjs
├── agent-gateway-http.test.mjs
├── agent-tools.test.mjs
├── agent-isolation.test.mjs
├── agent-audit.test.mjs
├── integration-jobs.test.mjs
├── talent-pipeline.test.mjs
├── talent-revocation.test.mjs
└── openclaw-plugin.test.mjs
```

## Key Decisions

1. **独立 Gateway 进程**：不继续增长已超过 500 行的 `src/server.js`，也不把内部 HMAC 路由混入 Cookie Web 路由。
2. **回环 HTTP**：OpenClaw 和 BrainX 同机；Gateway 只绑定 127.0.0.1，避免额外 TLS/mTLS 复杂度。跨主机部署不在本阶段启用。
3. **版本真实字段**：锁定版工具上下文没有 `nativeChannelId`；插件使用 `requesterSenderId`、`agentAccountId`/`deliveryContext.accountId`、`deliveryContext.channel/to/threadId`，目标前缀 `user:`/`chat:` 决定私聊/群聊，其他形状 fail-closed。
4. **双重服务认证**：固定服务 token 证明调用者是批准插件；HMAC assertion 证明本次渠道主体、body 和时效未被修改；nonce/request ID 只能消费一次。
5. **统一生产工具目录**：只在 `src/agent-gateway/tool-registry.js` 注册 10 个 PRD 工具；现有 MCP 继续供受信本地开发，不进入生产 OpenClaw 配置。
6. **服务端投影**：工具 handler 返回领域结构，envelope 层按 p2p/group 再裁剪；插件和模型不参与脱敏判断。
7. **增量优先**：先把 reloop 已有 383 份结构化档案用游标持续同步；只有缺少结构化来源的 PDF/DOCX 才进入解析 worker。
8. **排序不冒进**：现有 reloop shortlist 保持正式顺序；新增特征进入不可变 shadow run，评测签署后另开切换变更。

## Delivery Phases

1. **Foundation**: 迁移、assertion、身份/群授权、审计、统一 envelope。
2. **Read-only Gateway**: me/daily/job 和 talent 五类核心工具；跨用户/群负向测试。
3. **Native Plugin**: 10 个 manifest 工具、运行时上下文、打包/安装/inspect、安全配置样例。
4. **Talent Pipeline**: 增量同步、撤权传播、事实/fit/gap/interview 工具、解析任务。
5. **Operations**: systemd、环境样例、健康检查、备份恢复、公开 HTTPS 深链。
6. **Release**: 全量质量门禁、OpenClaw doctor/security audit、三名灰度、push 和 PR。

## Complexity Tracking

| 项目 | 必要性 | 收敛措施 |
|---|---|---|
| 独立插件包 | OpenClaw 可信 runtime context 只能在原生插件读取 | 仅工具注册、签名和固定 HTTP 客户端，不含业务逻辑 |
| 独立 Gateway 进程 | 权限边界不同于 Web/MCP，且现有 server.js 超限 | 复用领域函数；单入口、单白名单、仅回环 |
| 可选 Python parser | Node 无可靠 PDF/DOCX 原生解析能力 | 独立 worker、kill-switch、结构化来源优先，不阻塞核心只读闭环 |

## Post-design Constitution Check

全部原则通过。新增复杂度均对应不可削减的身份边界、可恢复任务或文档解析能力；没有引入通用执行、数据库直连 Agent 或公网内部接口。

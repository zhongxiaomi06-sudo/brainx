# Implementation Plan: Step 1 飞书事件网关

**Branch**: `002-step1-lark-gateway` | **Date**: 2026-09-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-step1-lark-gateway/spec.md`

## Summary

在 Step 0 信任底座之上落地飞书群消息入口：`@larksuiteoapi/node-sdk` WS 长连接（免公网回调，SDK 自带 challenge/验签/解密）订阅 `im.message.receive_v1`，解密后事件交纯逻辑层 `processLarkEvent()` 做 chat_contexts 查询 / 默认 DENY / @机器人过滤 / 标准信封映射 / appendEvent / 3s ACK。可本地全量 TDD 的纯逻辑层与 SDK 骨架本轮落地；真实联调需飞书凭证，清单交付。

## Technical Context

**Language/Version**: Node.js 22（managed）

**Primary Dependencies**: 仅新增 `@larksuiteoapi/node-sdk`（蓝图 §6.2 采购清单既定）；运行时 deps 将达 mysql2+zod+@larksuiteoapi/node-sdk=3（≤4 达标）

**Storage**: SQLite（复用 `src/db.js` 与 `src/hub/event-log.js` 的 appendEvent）

**Testing**: `node:test` + fixtures 回放（6 场景）；SDK WS 真实连接不在单元测范围（凭证缺失优雅降级可测）

**Target Platform**: 本地/服务器单机 Node 进程（server/worker 复用 Step 0 账本）

**Constraints**: 仅新增 SDK 一项依赖；每文件 ≤500 行；evidence_refs/payload 不含 PII；网关纯逻辑层 <3s（无网络 IO）

**Scale/Scope**: 1 张新表、4 个新模块（约 350-450 行含测试）、不改既有模块语义

## Constitution Check

| 原则 | 状态 | 说明 |
|---|---|---|
| I 零依赖 | ✅ | 仅新增 SDK（蓝图 §6.2 既定）；运行时 deps=3 ≤4 |
| II 账本先行 | ✅ | 网关即账本的生产者，复用 Step 0 appendEvent |
| III 安全边界 | ✅ | 未登记群默认 DENY；evidence_refs 不存 PII；凭证缺失不崩 |
| IV 规格先行 | ✅ | spec → plan → tasks → 测试先行 |
| V 最小 diff | ✅ | 全部新文件，不改既有模块语义 |

## Project Structure

### Documentation (this feature)

```text
specs/002-step1-lark-gateway/
├── spec.md              # 已提交（815d7b4）
├── plan.md              # 本文件
├── data-model.md        # chat_contexts DDL + 信封映射契约
├── quickstart.md        # 回放门禁 + 飞书凭证清单
└── tasks.md             # 施工清单
```

### Source Code (repository root) —— 按仓库既有平铺惯例，新增 gateway 子目录

```text
migrations/
└── 0029_chat_contexts.sql          # chat_contexts 表

src/gateway/                         # 新目录
├── chat-contexts.js                 # registerChatContext / setChatEnabled / getChatContext / listChatContexts
├── envelope-mapper.js               # 解密后事件 → 标准信封（通过/DENY 两类）
├── lark-gateway.js                  # processLarkEvent(decryptedPayload, db) 纯逻辑层
└── ws-client.js                     # startGateway/stopGateway SDK WS 骨架（凭证缺失优雅降级）

tests/
├── gateway-process.test.mjs         # processLarkEvent 6 场景 fixtures 回放
├── gateway-chat-contexts.test.mjs   # 注册/查询/启停/默认 DENY
└── gateway-ws-client.test.mjs       # 凭证缺失优雅降级（不真实连 WS）
└── fixtures/step1/                  # 6 个场景 JSON
```

**Structure Decision**: `src/gateway/` 为蓝图 §4 预留落点；纯逻辑层（lark-gateway.js）与传输层（ws-client.js）物理分离，使可测部分无凭证依赖。信封映射抽 envelope-mapper.js 单独可测，保持 lark-gateway.js ≤100 行。

## Complexity Tracking

无违规项。

# Feature Specification: Step 1 飞书事件网关

**Feature Branch**: `002-step1-lark-gateway`

**Created**: 2026-09-02

**Status**: Draft（对应[全景蓝图 §5 Step 1](../../docs/architecture-2026-09-01-full-blueprint.md)与[复用与自建边界 PRD §2 Step 1](../../docs/prd-2026-09-01-reuse-selfbuild-boundary.md)；Step 0 已全绿，前置满足）

**Input**: 在 Step 0 信任底座（appendEvent 幂等账本 + entity_links）之上，落地飞书群消息进入 BrainX 的网关薄层：SDK WS 长连接接收 → 解密后事件 → 查 chat_contexts → 未登记群默认 DENY → @机器人过滤 → 映射标准信封 → appendEvent → 3s ACK。本规格覆盖可本地全量 TDD 的纯逻辑层与 SDK 骨架；真实联调需飞书 App 凭证，列清单交付，不阻塞可测部分。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 已登记群消息落标准信封（Priority: P1）

已登记并启用的群里，机器人收到的消息被网关映射成标准信封写入 Step 0 账本，3s 内 ACK，后续业务可从 inbox 消费。

**Why this priority**: 网关是桥 1 全链的入口；9/3 all-hands 前必须能稳定落账。

**Independent Test**: 向 `processLarkEvent()` 喂一个已登记群、@机器人、合法的解密后消息 fixture，断言 appendEvent 被调用且返回 ACK，账本新增一行 `lark.message_received`。

**Acceptance Scenarios**:

1. **Given** chat_contexts 已登记 chat_id=`oc_test`（enabled=true, bot_mode=MENTION_ONLY），**When** 投入含 `@_user_1` 提及机器人的消息事件，**Then** 账本新增 `lark.message_received` 一行，idem_key=`lark:message:<message_id>`，evidence_refs 含 chat_contexts 与消息引用，函数返回 `{ack:true, action:'queued'}`。
2. **Given** 同一 message_id 重复投递，**Then** appendEvent 返回 deduplicated，账本仍 1 行，不二次副作用。

---

### User Story 2 - 未登记群默认 DENY（Priority: P1）

未在 chat_contexts 登记的群消息，网关只记审计留痕，不进业务 inbox，不响应。

**Why this priority**: 默认 DENY 是群聊工作流安全边界的硬约束（constitution 第 III 条）。

**Independent Test**: 投入未登记群的消息 fixture，断言账本无 `lark.message_received`，但有一条 `lark.ignored` 留痕，函数返回 `{ack:true, action:'denied'}`。

**Acceptance Scenarios**:

1. **Given** chat_id 未在 chat_contexts 登记，**When** 投入消息事件，**Then** 账本落 `lark.ignored`（reason=`unregistered_chat`），无 `lark.message_received`，不响应。
2. **Given** chat_contexts 登记 chat_id 但 enabled=false，**When** 投入消息，**Then** 同样 DENY，reason=`chat_disabled`。

---

### User Story 3 - @机器人才响应（Priority: P1）

`bot_mode=MENTION_ONLY` 的群，机器人仅在被 @ 时响应；非 @ 消息 DENY。

**Why this priority**: 外部群噪音控制；蓝图 §5 明确 `bot_mode=MENTION_ONLY`。

**Independent Test**: 同一已登记群，分别投入 @机器人 与非 @ 消息，断言前者进 inbox、后者落 `lark.ignored`（reason=`not_mentioned`）。

**Acceptance Scenarios**:

1. **Given** chat_contexts.bot_mode=MENTION_ONLY，**When** 消息 mentions 列表含机器人 open_id，**Then** 进 inbox（US1）。
2. **Given** 同群，**When** 消息未提及机器人，**Then** 落 `lark.ignored`（reason=`not_mentioned`），不进 inbox。

---

### User Story 4 - 重复投递幂等（Priority: P1）

SDK WS 重连或补偿重投同一 message_id 时，账本不重复落账。

**Why this priority**: at-least-once 投递下的幂等是 Step 0 已验证的硬保证，网关层不得破坏。

**Independent Test**: 同一 message_id 投入两次，断言账本恒 1 行，第二次返回 deduplicated。

**Acceptance Scenarios**:

1. **Given** message_id=`om_test_1` 已落账，**When** 再次投递，**Then** 账本行数不变，函数返回 `{ack:true, action:'duplicate'}`。

---

### User Story 5 - 凭证缺失优雅降级（Priority: P2）

SDK WS 客户端在飞书凭证未配置时启动不抛错，记日志提示，等凭证就绪后可正常连接。

**Why this priority**: 开发态/CI 无凭证时网关模块可被 import 与单元测，不阻塞其他模块。

**Independent Test**: 不设环境变量调 `startGateway()`，断言返回 `{ok:false, reason:'credentials_missing'}` 且不抛异常。

**Acceptance Scenarios**:

1. **Given** 无 `LARK_APP_ID`/`LARK_APP_SECRET`，**When** 调 `startGateway({db})`，**Then** 返回 `{ok:false, reason:'credentials_missing'}`，进程不崩。

### Edge Cases

- 消息无 message_id（非法事件）→ 拒绝并返回 `{ack:false, reason:'malformed_event'}`，不落账。
- chat_id 为空（私聊或异常）→ 按 `reason='no_chat_scope'` DENY。
- evidence_refs 只存引用：消息正文不入 payload，只存 `lark_messages` 引用（FR-006 隐私约束继承 Step 0）。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 MUST 提供 `chat_contexts` 表（chat_id PK, enabled, bot_mode, default_deny_reason, registered_at, updated_at, notes），登记/启停由运营脚本预填，不在事件路径动态注册。
- **FR-002**: 系统 MUST 提供 `processLarkEvent(decryptedPayload, db)` 纯函数：解析 message_id/open_id/chat_id/mentions → 查 chat_contexts → DENY/MENTION 过滤 → 映射信封 → appendEvent → 返回 `{ack, action, reason?}`。
- **FR-003**: 入站幂等 MUST 复用 Step 0 `idx_wel_idem`，idem_key=`lark:message:<message_id>`；不新建独立去重表（零依赖/最小 diff）。
- **FR-004**: 标准信封映射：event_type=`lark.message_received`（通过）/`lark.ignored`（DENY），case_id=null，actor=`user:<open_id>`，occurred_at=消息时间，evidence_refs=`[{table:'chat_contexts',id:chat_id},{table:'lark_messages',id:message_id}]`，payload 仅含 `{message_type, chat_scope}` 等非 PII 元数据。
- **FR-005**: 系统 MUST 提供 chat_contexts 注册工具 `registerChatContext(db, {chat_id, bot_mode, notes})` / `setChatEnabled(db, chat_id, enabled)` / `getChatContext(db, chat_id)` / `listChatContexts(db)`。
- **FR-006**: 系统 MUST 提供 SDK WS 客户端骨架 `startGateway({credentials, db, onEvent?})` / `stopGateway()`；凭证缺失返回 `{ok:false, reason:'credentials_missing'}` 不抛错；凭证就绪时用 `@larksuiteoapi/node-sdk` 的 `WSClient` + `EventDispatcher` 订阅 `im.message.receive_v1`，解密后调 `processLarkEvent`。
- **FR-007**: 3s ACK 语义：`processLarkEvent` 同步返回后 SDK 层立即 ACK；本层逻辑 MUST <3s（无网络/IO 阻塞，仅 SQLite 本地写入）。
- **FR-008**: 全部能力 MUST 仅新增 `@larksuiteoapi/node-sdk` 一项 npm 依赖（蓝图 §6.2 采购清单既定）；每文件 ≤500 行；fixtures 先行（constitution 第 IV 条）。
- **FR-009**: evidence_refs 与 payload 不得含 PII 正文（消息文本/联系方式/简历），仅存引用（继承 Step 0 FR-006）。

### Key Entities

- **chat_contexts**: 群登记表；attributes: chat_id(PK), enabled(bool), bot_mode(enum: MENTION_ONLY/ALL), default_deny_reason, registered_at, updated_at, notes。
- **workflow_event_log**: 复用 Step 0；网关写入 event_type=`lark.message_received`/`lark.ignored`，idem_key=`lark:message:<message_id>`。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: fixtures 6 场景回放全绿：已登记@消息/未登记群/已登记非@/重复投递/非法事件/凭证缺失。
- **SC-002**: 重复 message_id 投递账本恒 1 行（复用 idx_wel_idem）。
- **SC-003**: 未登记群消息不产生 `lark.message_received`，但有 `lark.ignored` 审计留痕。
- **SC-004**: `@机器人才响应`：非 @ 消息不进 inbox。
- **SC-005**: `startGateway()` 无凭证返回 `credentials_missing` 不抛错。
- **SC-006**: `grep -r lark-gateway src/gateway/` 真实命中（当前为 0）。
- **SC-007**: package.json 依赖仅新增 `@larksuiteoapi/node-sdk`（deps=mysql2,zod,@larksuiteoapi/node-sdk，≤4 达标）；`npm run verify:quick` 通过。

## Assumptions

- 传输层采 SDK WS 长连接（蓝图 §9 reuse PRD 决议）；蓝图 §5 伪代码的手写验签/AES/HTTP 公网回调仅作逻辑说明，不实现。
- 入站幂等复用 Step 0 `idx_wel_idem`，不新建 `lark_event_dedupe` 表（Step 0 已提供更强保证）。
- chat_contexts 由运营脚本预填（`registerChatContext`），不在事件路径动态注册。
- 本规格覆盖可本地全量 TDD 的纯逻辑层与 SDK 骨架；真实联调需飞书 App 凭证，清单见 [quickstart.md](quickstart.md)。
- `processLarkEvent` 输入为 SDK 解密后的标准消息事件结构（`{message_id, chat_id, open_id, mentions, message_type, create_time, body}`），解密由 SDK 完成。

## 相关文档

- [全景架构与技术施工蓝图 §5 Step 1](../../docs/architecture-2026-09-01-full-blueprint.md)（逻辑权威，伪代码为说明）
- [复用与自建边界及权限需求 PRD §2 Step 1](../../docs/prd-2026-09-01-reuse-selfbuild-boundary.md)（SDK WS 决议、权限最小集）
- [Step 0 事件账本规格](../001-step0-event-ledger/spec.md)（appendEvent 契约、idx_wel_idem）
- [规范驱动研发流程](../../docs/standards/SPEC_DRIVEN_WORKFLOW.md)

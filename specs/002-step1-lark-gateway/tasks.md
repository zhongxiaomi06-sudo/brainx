# Tasks: Step 1 飞书事件网关

**Input**: [spec.md](spec.md) · [plan.md](plan.md) · [data-model.md](data-model.md)

**Tests**: 必须包含——constitution 第 IV 条测试先行；每个任务的测试写在实现之前且初始为失败状态。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，无依赖）
- **[Story]**: 所属用户故事（spec.md 定义 US1-US5）

## Phase 1: 迁移与骨架（无依赖，可并行）

- [x] **T001** [P] US1 `migrations/0029_chat_contexts.sql`：按 [data-model.md](data-model.md) 建 chat_contexts 表（enabled/bot_mode/default_deny_reason/registered_at/updated_at/notes）
- [x] **T002** [P] US5 `npm install @larksuiteoapi/node-sdk`：采购 SDK（蓝图 §6.2 既定）

## Phase 2: chat_contexts 注册工具（US1 前置）

- [x] **T003** US1 `tests/gateway-chat-contexts.test.mjs`：**先写测试**——registerChatContext 写入、getChatContext 查询、setChatEnabled 启停、listChatContexts 列举、重复 chat_id upsert 刷新
- [x] **T004** US1 `src/gateway/chat-contexts.js`：registerChatContext / setChatEnabled / getChatContext / listChatContexts；≤60 行

## Phase 3: 信封映射与网关纯逻辑层（US1-US4 核心）

- [x] **T005** US1-4 `tests/fixtures/step1/`：6 场景 JSON——①已登记@消息（通过）②未登记群（DENY unregistered_chat）③已登记非@（DENY not_mentioned）④重复投递（同 message_id 两次）⑤非法事件（无 message_id）⑥无 chat_scope（chat_id 空）
- [x] **T006** US1-4 `tests/gateway-process.test.mjs`：**先写测试**——6 场景 fixtures 回放断言（通过落 lark.message_received / DENY 落 lark.ignored 各自幂等 / 非法拒绝不落账）
- [x] **T007** US1-4 `src/gateway/envelope-mapper.js`：解密后事件 → 标准信封（通过/DENY 两类），复用 Step 0 appendEvent；≤80 行
- [x] **T008** US1-4 `src/gateway/lark-gateway.js`：processLarkEvent(decryptedPayload, db) 纯逻辑——解析→查 chat_contexts→MENTION 过滤→映射→appendEvent→返回 {ack,action,reason?}；≤100 行

## Phase 4: SDK WS 传输层骨架（US5）

- [x] **T009** US5 `tests/gateway-ws-client.test.mjs`：**先写测试**——无凭证 startGateway 返回 {ok:false,reason:'credentials_missing'} 不抛错；有凭证 mock 路径（不真实连 WS，只验证参数校验）
- [x] **T010** US5 `src/gateway/ws-client.js`：startGateway({credentials,db,onEvent?}) / stopGateway()；凭证缺失优雅降级；凭证就绪用 SDK WSClient+EventDispatcher 订阅 im.message.receive_v1 解密后调 processLarkEvent；≤120 行

## Phase 5: 门禁收口

- [x] **T011** 收口：[quickstart.md](quickstart.md) 核对清单逐项验证、`node --test tests/gateway-*.test.mjs` 全绿、`npm run verify:quick`、确认 package.json 依赖变更仅 @larksuiteoapi/node-sdk、按 AGENTS.md 提交（每个 Phase 一个原子 commit，中文记录入 docs/AGENT_COMMIT_LOG.md）

## Dependencies

- T004（chat-contexts）是 T008（lark-gateway）的前置
- T007（envelope-mapper）是 T008 的前置
- T008 是 T010（ws-client）的前置（传输层调 processLarkEvent）
- T002（SDK）是 T010 的前置；T001-T008 不依赖 SDK（纯逻辑层）

## Parallel Opportunities

- Phase 1 两个任务可并行；Phase 2-3 的测试文件（T003/T005/T006）可与 T001 并行编写。

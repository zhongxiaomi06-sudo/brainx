# Quickstart: Step 1 飞书事件网关回放验证

## 前置

- Node 22（`/Users/ashley/.workbuddy/binaries/node/versions/22.22.2-2/bin/node`）
- Step 0 已落地（migrations 0023-0028、src/hub/* 可 import）
- 无需飞书凭证即可跑全部回放（纯逻辑层 + SDK 骨架降级测试）

## 运行回放门禁

```bash
# 全量 gateway 回放（实现完成的定义：全绿）
node --test tests/gateway-process.test.mjs tests/gateway-chat-contexts.test.mjs \
  tests/gateway-ws-client.test.mjs

# 快速门禁（含全仓既有测试回归）
npm run verify:quick
```

## 手工验证幂等（复用 Step 0 idx_wel_idem）

```bash
node --input-type=module -e '
import { openDb } from "./src/db.js";
import { processLarkEvent } from "./src/gateway/lark-gateway.js";
import { registerChatContext } from "./src/gateway/chat-contexts.js";
const db = openDb(":memory:");
registerChatContext(db, { chat_id: "oc_demo", bot_mode: "MENTION_ONLY" });
const evt = { message_id: "om_1", chat_id: "oc_demo", open_id: "ou_bot",
  mentions: ["ou_bot"], message_type: "text", create_time: "2026-09-02T02:00:00Z", body: {} };
const a = processLarkEvent(db, evt);
const b = processLarkEvent(db, evt); // 重复投递
console.log(a.action, b.action); // queued duplicate
console.log("rows =", db.prepare("SELECT COUNT(*) c FROM workflow_event_log").get().c); // 必须是 1
'
```

## 真实联调前置（飞书凭证清单，交付后接入）

需用户配置（不在本轮可测范围）：

1. 飞书开放平台创建企业自建应用，记录 **App ID** / **App Secret** / **Encrypt Key** / **Verification Token**。
2. 机器人能力：开启"机器人"，`bot_mode=MENTION_ONLY`。
3. 权限最小集（3 项）：`im.message.receive_v1`（收群消息）、`im:message:send_as_bot`（发消息）、`im:chat:readonly`（读群信息登记 chat_contexts）。
4. 事件订阅：选 **WebSocket 长连接模式**（免公网回调；SDK WSClient 自动连接）。
5. 机器人加入目标群，取 `chat_id`（oc_ 开头）。
6. 凭证写入 `.env`：`LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_ENCRYPT_KEY` / `LARK_VERIFICATION_TOKEN`。
7. 用 `registerChatContext` 登记 chat_id（见 quickstart 手工片段）。
8. `npm install`（SDK 已随本轮加入），`node -e 'import("./src/gateway/ws-client.js").then(m=>m.startGateway({db}))'` 启动；发 @机器人消息，查 `workflow_event_log` 应有 `lark.message_received`。

## 验收核对清单（实施交回时逐项打勾）

- [ ] SC-001 fixtures 6 场景全绿
- [ ] SC-002 重复 message_id 投递账本恒 1 行
- [ ] SC-003 未登记群消息无 lark.message_received 但有 lark.ignored 留痕
- [ ] SC-004 非 @ 消息不进 inbox
- [ ] SC-005 startGateway 无凭证返回 credentials_missing 不抛错
- [ ] SC-006 `grep -r lark-gateway src/gateway/` 真实命中
- [ ] SC-007 package.json 仅新增 @larksuiteoapi/node-sdk、verify:quick 通过
- [ ] 迁移 0029 登记 schema_migrations

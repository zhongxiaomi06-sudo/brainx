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

## 真实联调前置（飞书凭证清单，分工交付后接入）

> 8 步里助手只跑 3 步命令行（5.5 / 7 / 8），其余 5 步由用户在飞书后台/客户端完成。

需用户配置（飞书后台/客户端）：

1. 飞书开放平台创建企业自建应用，记录 **App ID** / **App Secret** / **Encrypt Key** / **Verification Token**。
2. 机器人能力：开启"机器人"，`bot_mode=MENTION_ONLY`。
3. 权限最小集（3 项）：`im.message.receive_v1`（收群消息）、`im:message:send_as_bot`（发消息）、`im:chat:readonly`（读群信息登记 chat_contexts）。
   - **关键一步**：加完权限必须去「版本管理与发布」建版本并申请发布——**没发布权限不生效**；企业自建一般自动过，敏感权限要管理员批。
4. 事件订阅：选 **WebSocket 长连接模式**（免公网回调；SDK WSClient 自动连接）+ 挂 `im.message.receive_v1`。
5. 飞书客户端把机器人拉进目标群（群里加成员即可）。

助手跑（命令行）：

5.5. 取 `chat_id`（用 `im:chat:readonly` 列机器人所在群，不必满世界找）：
    ```bash
    node --env-file=.env bin/brainx-lark-gateway.mjs list-chats
    ```
6. 凭证写入 `.env`：**新增** `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_ENCRYPT_KEY` / `LARK_VERIFICATION_TOKEN` 四行。
    - 旧键 `BRAINX_FEISHU_APP_ID` / `BRAINX_FEISHU_APP_SECRET` **不改不删**（其他模块在用），网关一律读 `LARK_*`。
7. 登记群到 `chat_contexts`：
    ```bash
    node --env-file=.env bin/brainx-lark-gateway.mjs register <chat_id> [--bot-mode MENTION_ONLY] [--notes "备注"]
    ```
8. 启动网关 + 验证：
    ```bash
    # 真实连飞书（WS 长连接）
    node --env-file=.env bin/brainx-lark-gateway.mjs start
    # 预演模式（不真实连飞书，只校验凭证与可启动性 + bot/v3/info 拿真实 open_id）
    node --env-file=.env bin/brainx-lark-gateway.mjs start --mock
    ```
    启动后发 @机器人消息，查 `workflow_event_log` 应有 `lark.message_received`。Ctrl+C 退出（SIGINT/SIGTERM 自动 stopGateway）。

> 已知修复（2026-09-02）：`BOT_OPEN_ID='ou_bot'` 占位符缺陷——真实飞书事件机器人 open_id 是 `ou_xxxx` 永不匹配，导致所有 @机器人 误判 `not_mentioned`。已改为 live 模式启动时调 `GET /open-apis/bot/v3/info` 拿真实 open_id 注入 `processLarkEvent` 的 `botOpenId` 参数；获取失败显式返回 `bot_info_failed` 不静默回落占位值。`processLarkEvent(db, evt, botOpenId)` 第三参数化，mock/测试用约定值 `ou_bot`。

## 验收核对清单（实施交回时逐项打勾，2026-09-02 由 WorkBuddy 会话实施完成可测部分）

- [x] SC-001 fixtures 6 场景全绿（gateway-process 8 用例含 6 场景 + 边界 + 幂等裁决，共 18 用例全绿）
- [x] SC-002 重复 message_id 投递账本恒 1 行（gateway-process 重复投递用例 + 上方手工单行）
- [x] SC-003 未登记群消息无 lark.message_received 但有 lark.ignored 留痕（unregistered_chat / chat_disabled / not_mentioned 三类）
- [x] SC-004 非 @ 消息不进 inbox（not_mentioned DENY）
- [x] SC-005 startGateway 无凭证返回 credentials_missing 不抛错
- [x] SC-006 `grep -r lark-gateway src/gateway/` 真实命中（4 文件命中）
- [x] SC-007 package.json 仅新增 @larksuiteoapi/node-sdk（deps=mysql2,zod,@larksuiteoapi/node-sdk，≤4 达标）、verify:quick 通过
  - 注：verify:quick 14/16，仅余其他协作者未跟踪文件的 2 项既有失败（week-plan HTML 超长行、health-brief 行尾空白），与本规格无关
- [x] 迁移 0029 登记 schema_migrations（:memory: 自动应用，migrations 计数 31）
- [ ] 真实联调（需用户配置飞书凭证，见上方清单 8 步，不在本轮可测范围）

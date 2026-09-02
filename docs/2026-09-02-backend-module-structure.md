# 后端侧模块结构与下一步安排（用户职责边界内）

> 上级入口：[BrainX 文档书](README.md) · [OpenClaw 壳子架构](2026-09-02-openclaw-shell-architecture.md) · [业务工作全景](2026-09-02-business-work-breakdown.md)
>
> 定位（9/2 晚用户明确边界）：**"openclaw 的接口这一块我不负责，我就负责后端的其他点"**。本文只写**后端侧**的模块结构与下一步安排，OpenClaw 侧（Skill 编写、飞书插件、Gateway 配置）不在本文范围。
>
> 本文回答三件事：**群里信息读取归谁**、**后端有哪些模块、各自什么状态**、**下一步按什么顺序做**。

## 1. 边界裁定：群消息读取到底归谁

用户原话：「现在是对于群里的信息的读取，这个是 openclaw 的事情，还是我后端多的」。

**答案：拆三段，两段在你这边，一段在 OpenClaw 那边。而且能读群消息的那条通道，本来就已经在你后端仓库里建成了。**

| 段 | 具体做什么 | 归谁 | 现状 |
|---|---|---|---|
| **① 飞书后台配置** | 创建企业自建应用 → 启用机器人 → 勾选 scope → 订阅 `im.message.receive_v1` → **创建版本并发布** | **你手动**（在飞书后台点，谁都替不了） | 待做，需 4 个凭证（AppID/Secret/EncryptKey/VerificationToken）。步骤见 [specs/002-step1-lark-gateway/quickstart.md](../specs/002-step1-lark-gateway/quickstart.md) |
| **② 通道层（WS 长连接）** | 用飞书 SDK 的 `WSClient` + `EventDispatcher` 订阅消息事件、解密、归一成内部信封 | **后端（你）— 已建成** | ✅ `src/gateway/ws-client.js`（118 行完整实现，非骨架）+ CLI `bin/brainx-lark-gateway.mjs` + 4 个测试 |
| **③ OpenClaw 飞书插件** | 另一条**独立的** WS 连接，负责前台对话（@机器人 触发） | **OpenClaw 侧**（你不负责） | 未验证，9/3 要验它能否透传原始字段 |

> **最重要的纠正（9/2 晚代码核实）**：之前架构文档 §7 写「两条都不能砍」，容易被读成"群消息读取要依赖 OpenClaw"。**不是。**
> - **`src/gateway/ws-client.js` 是一条完整的、独立的、已在后端仓库里的飞书 WS 长连接客户端**——用 `@larksuiteoapi/node-sdk`，`startGateway()` 订阅 `im.message.receive_v1`，解密后交给 `processLarkEvent()` 处理，还会启动时调 `bot/v3/info` 拿机器人真实 open_id（已修掉 `BOT_OPEN_ID` 占位符缺陷）。
> - **这条线不依赖 OpenClaw 任何东西**，配好 4 个凭证就能跑（命令见 §4 今晚第 1 条）。
> - OpenClaw 那条是**额外的前台对话通道**，不是必需的替代品。它挂了不影响后端收消息。

**一句话**：你只负责后端是对的，而**后端本来就已经把"读群消息"这件事做完了**——剩下的是①飞书后台点配置 + ②把消息提炼成业务字段（§3 待补第 5 项）。

## 2. 后端侧模块全景（六层）

```text
┌─ 飞书（群/私聊）────────────────────────────────────────┐
│  ①飞书后台配置（你手动）  ②通道层 src/gateway（已建成） │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌─ L1 事件账本层 · src/hub/（Step 0，已建成）─────────────┐
│  event-log · consumer(consumeOnce 幂等) · envelope      │
│  upcaster · entity-links · case-machine                │
│  → workflow_event_log + idx_wel_idem 唯一留痕权威       │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌─ L2 领域数据层 · src/db.js + migrations/（31 个）────────┐
│  决策库 SQLite data/brainx.db                           │
│  job_facts · commitments · commitment_actions           │
│  job_outcomes · processed_events · entity_links ...     │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌─ L3 业务领域层 · src/*.js（已建成，48 个模块）───────────┐
│  commitment · engagement · replay · recommend           │
│  openmai-task · talent-supply · talent · radar          │
│  scorer · facts · projects · sync · guard · ...         │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌─ L4 调度推送层（已建成且在跑）──────────────────────────┐
│  scheduler.js 早7晚7 · push.js · autopush.js            │
│  → 只推私聊，绝不推群                                    │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌─ L5 MCP 交付层 · mcp/server.mjs（已建成）───────────────┐
│  15 个工具（7 读 8 写）· JSON-RPC 2.0 · 零依赖 stdio    │
│  → 对外唯一写库通道，守门与脱敏都在这层                  │
└─────────────────────────────────────────────────────────┘
```

| 层 | 目录 / 文件 | 状态 | 职责 |
|---|---|---|---|
| **L1 事件账本** | `src/hub/`（6 个文件） | ✅ 已建成 | 事件留痕、`consumeOnce` 幂等消费、信封归一、版本升档、跨系统 ID 映射、Case 状态机 |
| **L2 领域数据** | `src/db.js` + `migrations/`（31 个 SQL） | ✅ 已建成 | 决策库 SQLite，业务真值唯一权威 |
| **L3 业务领域** | `src/*.js`（48 个模块） | ✅ 已建成 | 接单/承诺/进展/回放/推荐/找人/人才供给/雷达/评分/同步 |
| **L4 调度推送** | `src/scheduler.js` `push.js` `autopush.js` | ✅ **已建成且在跑** | 早 7 晚 7 定时推送、私聊卡片、逾期提醒（默认开的那个） |
| **L5 MCP 交付** | `mcp/server.mjs`（272 行） | ✅ 已建成 | 15 个工具，OpenClaw 侧唯一入口 |
| **L0 飞书网关** | `src/gateway/`（4 个文件） | ✅ 已建成，**等凭证** | WS 长连接收消息、信封映射、chat_id 登记 |
| **L6 Skills** | `skills/`（8 个 md，7 个已合规） | ✅ 已生成 | 交给 OpenClaw 侧的 Skill 素材（**不属于"接口"，是纯文本**） |

## 3. 已建成 vs 待补（后端侧一屏对照）

### 已建成（不用再写，配好就能跑）

| 模块 | 位置 | 备注 |
|---|---|---|
| 飞书 WS 长连接 | `src/gateway/ws-client.js` | **118 行完整实现**，非骨架 |
| 事件纯逻辑处理 | `src/gateway/lark-gateway.js` | `processLarkEvent` |
| 信封映射 | `src/gateway/envelope-mapper.js` | 飞书事件 → 内部信封 |
| chat_id 登记 | `src/gateway/chat-contexts.js` | 群上下文 |
| 事件账本 | `src/hub/event-log.js` | `workflow_event_log` + `idx_wel_idem` |
| 幂等消费 | `src/hub/consumer.js` | `consumeOnce` 事务内标记 |
| MCP server | `mcp/server.mjs` | 15 工具，JSON-RPC 2.0 |
| 定时调度 | `src/scheduler.js` | **默认开**，`SLOTS=[7,19]` |
| 推送卡片 | `src/push.js` | lark-cli `--as bot`，**只推私聊** |
| 待办判断 | `src/engagement.js:112` | `need_action_count` 三条规则 |
| 找人任务 | `src/openmai-task.js` | 触发点已有 |

### 待补（后端侧，按优先级）

| # | 待补什么 | 位置 | 工期 | 阻塞 |
|---|---|---|---|---|
| **1** | **挂 MCP 前三个硬前置** | `mcp/server.mjs` | 0.5 天 | **必须先做完才能挂 MCP** |
| 1a | `brainx_sync_now` 进黑名单 | 同上 | 0.2 天 | 默认 `source='fixture'`+`dry_run=false` 会刷库 |
| 1b | `brainx_record_outcome` 补 `jobVisibleTo` | `src/replay.js:35` | 0.3 天 | 现在可给任意职位录结果 |
| 1c | `brainx_talent` 进黑名单 | `mcp/server.mjs` | — | 无 cid 隔离 |
| **2** | **OpenMai 工具暴露到 MCP** | `mcp/server.mjs` | 0.5 天 | 接单自动找人的前置 |
| **3** | **`brainx_talent_mine` cid 隔离改造** | `src/talent.js` | 1.5 天 | 改造完才能外露 |
| **4** | **演示机 IP 加 RDS 白名单** | 运维 | 0.5 天 | `npm run talent:health` 留证 |
| **5** | **群消息提炼成业务字段** | **待新建**（`src/job-extract.js` 或挂 L3） | 2 天 | **① 飞书后台配完才有的验** |
| **6** | **待办提醒卡** | `src/push.js` | 1 天 | 现在推的是"建议看 3 个职位"，方向反了 |
| **7** | **`next_action` 改 `suggestedAction`** | `src/engagement.js:120` | 0.5 天 | 现在是硬编码占位符 |
| **8** | **到期前弹窗 + 逾期加急** | `src/scheduler.js` | 0.5 天 | 现在只有早晚两班 |
| **9** | **约面/一面建模** | migrations + 状态机 | 1.5 天 | **待你拍板要不要做** |
| **10** | 人才供给 / 找人结果脱敏脚本 | `src/talent-supply.js` 等 | 1 天 | 外露前必做 |

> **第 5 项要特别说明**：L0 网关只负责**收到消息并落成事件**，「把一段群消息提炼成结构化的 `job_facts` 字段」这段**还没有代码**。这正是 MVP ① 段缺的那一块，也是 2 天工期的来源。

## 4. 下一步安排

### 今晚（9/2 晚）能做的三件事

| # | 做什么 | 怎么验 |
|---|---|---|
| **1** | **把飞书 4 个凭证配进 `.env`，启动网关跑通** | `node --env-file=.env bin/brainx-lark-gateway.mjs start` → 返回 `credentials_missing` 说明凭证没配好；返回 `{ok:true, mode:'live', botOpenId:'ou_xxx'}` 就成了 |
| **2** | **做挂 MCP 前的三个硬前置**（待补 1a/1b/1c） | 见 [工具外露白名单 §4](2026-09-02-tool-exposure-whitelist.md) |
| **3** | **`npm run verify:quick` 确认基线没破** | `.quality-gate/reports/latest.md` 结论为「通过」 |

> **第 1 条的关键卡点**：`bin/brainx-lark-gateway.mjs` 这个 CLI **存在但没挂 npm script**（package.json 里只在 `bin` 字段登记了 `braintex-lark-gateway`）。建议顺手补一条 `"gateway": "bin/brainx-lark-gateway.mjs"`，避免以后每次手敲全路径。

### 9/3（明天）优先级

| 序 | 做什么 | 工期 | 依赖 |
|---|---|---|---|
| **1** | **跑通「York 群主邀请机器人入群 → 收到群消息 → 落事件」端到端 demo** | 0.5 天 | 今晚第 1 条 |
| **2** | **扫现行 7 个 offer 群群主，确认是否愿意拉 BrainX 机器人** | 0.2 天 | 无（问人） |
| **3** | **验证 OpenClaw 飞书插件能否透传原始字段**（`message_id`/`chat_id`/`open_id`） | 0.5 天 | OpenClaw 侧配合 |
| **4** | 待补 #2 OpenMai 工具暴露到 MCP | 0.5 天 | 硬前置做完 |
| **5** | `engage` ACCEPT 分支挂自动找人钩子 | 0.5 天 | 依赖 4 |

> **第 3 条不影响第 1 条。** 无论 OpenClaw 插件透传结果如何，**后端自建网关都照跑**——它本来就不依赖 OpenClaw。

### 9/4 - 9/14 排期

| 段 | 内容 | 工期 |
|---|---|---|
| **P0（9/14 前必做）** | 硬前置三件 + OpenMai 暴露 + talent cid 隔离 + 演示机白名单 | 3 天 |
| **P1（出效果）** | 待办提醒卡 + `next_action` 改造 + 到期弹窗（**日历助手三件套**） | 2 天 |
| **P2（锦上添花）** | 群消息提炼 + 约面/一面建模 | 3.5 天（待拍板） |

## 5. 与 OpenClaw 的接缝（只有三个点）

你不负责 OpenClaw 接口，但**这三条接缝必须对齐**，否则两边对不上：

| # | 接缝 | 后端给什么 | OpenClaw 侧负责什么 |
|---|---|---|---|
| **1** | **工具调用** | `mcp/server.mjs`（stdio，零依赖）。配置模板见 [下游交付文档 §6.3](2026-09-02-brainx-mcp-deliverable.md) | 在 `openclaw.json` 的 `mcp.servers` 里挂 `brainx-domain` |
| **2** | **身份映射** | 后端只认 `consultant_id` | OpenClaw 侧负责 `open_id ↔ consultant_id` 映射（**后端不碰飞书 open_id**） |
| **3** | **Skill 素材** | `skills/` 8 个 md（7 个已合规） | OpenClaw 侧放置与启用 |

> **红线**：**后端不实现任何飞书 open_id 相关的业务逻辑**。身份映射是 OpenClaw 侧的事，后端只见 `consultant_id`。这条划清楚了，两边才能各改各的。

## 6. 红线（后端侧）

1. **`brainx_sync_now` 在补完守门前必须进黑名单**——默认参数会把决策库刷成 fixture 测试数据，数据破坏比隐私泄漏更致命。
2. **推送只走私聊，绝不推群**——`scheduler.js` / `autopush.js` 现有安全边界，群推送需你显式确认，永不进自动化路径。
3. **新增写工具必须带 `jobVisibleTo` 或等效守门**——`brainx_record_outcome` 就是漏了才出的事。建议加 `tests/mcp-write-guard.test.mjs`。
4. **后端不碰飞书 open_id**——身份映射归 OpenClaw 侧。
5. **敏感字段不进卡片**——候选人只显示占位标识，不显示姓名/联系方式。

## 相关文档

- [OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md) — 技术分层与 OpenClaw 侧职责
- [业务工作全景](2026-09-02-business-work-breakdown.md) — 全链路六段 + York 团队实证（§1.5）
- [下游交付文档](2026-09-02-brainx-mcp-deliverable.md) — MCP server 契约与打包部署
- [工具外露白名单](2026-09-02-tool-exposure-whitelist.md) — 哪些工具能外露、补守门
- [AI leader 工作流 + 日历助手](2026-09-02-ai-leader-workflow.md) — 一面前后两种形态
- [飞书权限清单](2026-09-02-feishu-permission-scopes.md) — §6.1 群主邀请低敏感路径
- `specs/002-step1-lark-gateway/quickstart.md` — 飞书后台 8 步配置清单

# BrainX → OpenClaw 接口包（模块化交付信息）

> 上级入口：[BrainX 文档书](README.md) · [BrainX 下游交付文档](2026-09-02-brainx-mcp-deliverable.md)
>
> 定位：用户 9/2 晚指令「后端的结构我打包给对方模块化的信息」——本文是**交给 OpenClaw 侧的单一打包文档**。对方拿这一份即可完成对接，无需翻后端全部文档。
>
> 本文只描述**接缝上的契约**，不重复后端内部实现；后端内部见[后端侧模块结构](2026-09-02-backend-module-structure.md)，工具逐个守门规则见[工具外露白名单](2026-09-02-tool-exposure-whitelist.md)。

## 1. 一屏总览：接缝只有三个

```text
┌─ OpenClaw 侧（对方负责）──────────────┐        ┌─ BrainX 后端（我方负责）──────────────┐
│                                        │        │                                        │
│  飞书插件（前台对话通道，独立 WS）      │        │  L0 网关 ws-client.js（群消息通道）     │
│  open_id ↔ consultant_id 映射  ────────┼──接缝2─▶  只认 consultant_id，不碰 open_id      │
│  openclaw.json 挂 brainx-domain ───────┼──接缝1─▶  MCP 运行时只外露 7 个工具          │
│  放置/启用 5 个安全 Skill ◀────────────┼──接缝3──  skills/（仓库共 6 个）               │
└────────────────────────────────────────┘        └────────────────────────────────────────┘
```

| 接缝 | 我方给什么 | 对方做什么 |
|---|---|---|
| **1 工具调用** | `mcp/server.mjs`（stdio，JSON-RPC 2.0，零依赖） | `openclaw.json` 的 `mcp.servers` 挂 `brainx-domain` |
| **2 身份映射** | 一切接口只认 `consultant_id` 字符串 | 维护 `open_id ↔ consultant_id` 映射；后端永不接收/存储 open_id |
| **3 Skill 素材** | `skills/` 共 6 个；当前 OpenClaw 安装 5 个安全 Skill | 放置到 OpenClaw Skill 目录并启用；不安装 SQL 探索 Skill |

**三条红线（对方侧同样适用）**：

1. 后端不实现任何飞书 open_id 相关业务逻辑——身份映射的维护与变更完全在 OpenClaw 侧。
2. 推送只走私聊，绝不推群——OpenClaw 侧如需群内播报，走自己的通道，不得要求后端加群推送。
3. 敏感字段（候选人姓名/联系方式）不进卡片与 Skill 输出，只显示占位标识。

## 2. 接缝 1：stdio MCP 工具契约

### 2.1 接入方式（对方侧配置模板）

```json
{
  "mcp": {
    "servers": {
      "brainx-domain": {
        "command": "node",
        "args": ["/path/to/brainx/mcp/server.mjs"],
        "transport": "stdio",
        "env": {
          "BRAINX_ENV_FILE": "/path/to/brainx/.env",
          "BRAINX_MCP_CONSULTANT_ID": "由管理员确认的顾问 ID",
          "BRAINX_MCP_TENANT_ID": "由管理员确认的租户 ID"
        },
        "toolFilter": {
          "include": [
            "brainx_workbench",
            "brainx_recommendations",
            "brainx_opportunity",
            "brainx_progress_suggestion",
            "brainx_replay",
            "brainx_push_preview",
            "brainx_candidate_shortlist"
          ]
        }
      }
    }
  }
}
```

- 协议：JSON-RPC 2.0 over stdio，协议层手写，运行依赖以仓库 lockfile 为准；`node mcp/server.mjs` 直接起。
- `BRAINX_MCP_CONSULTANT_ID` 是单顾问本机 PoC 的身份硬绑定：设置后，工具 schema 不再向模型暴露 `consultant_id`，服务端自动注入；模型显式传入其他顾问 ID 会返回 `-32602`。缺少或无效绑定时不得把该 MCP 挂进飞书 Agent。
- `brainx_candidate_shortlist` 还要求同时设置 `BRAINX_MCP_TENANT_ID`；缺任一绑定时该工具不出现在 `tools/list`。详细授权与脱敏契约见[候选人事实与 shortlist 数据契约](2026-09-03-candidate-data-contracts.md)。
- 上述 `toolFilter.include` 是首轮只读集合；不得把混合读写的 `brainx_profile` 或任何写工具提前加入。
- 该 stdio 方案只用于当前单顾问本机 PoC。多人/生产飞书链路仍以 [OpenClaw 工作流 PRD §8](prd-2026-09-02-openclaw-ai-recruiting-workflow.md#8-brainx-agent-gateway-权限设计) 的原生插件 + Agent Gateway 为准，不能用“一实例一个环境变量”代替正式身份映射。
- 方法：`initialize` / `tools/list` / `tools/call`。对方接入后先调 `tools/list` 拿实时清单——**清单以运行时返回为准**，本文表格是快照。
- 部署与打包细节（Docker、环境凭据、版本）：见[下游交付文档](2026-09-02-brainx-mcp-deliverable.md)，本文不重复。

#### 当天最短闭环：OpenClaw 定时触发个人推荐卡（2026-09-03）

在正式的“飞书对话 → 可信身份 → Agent Gateway”完工前，可以先用 OpenClaw 的 command cron 触发 BrainX 现有推荐卡，验证真实机器人、真实推荐与真实私聊送达：

```text
OpenClaw cron
→ node --env-file=.env bin/brainx-push.mjs --consultant <cid> --slot 0700|1900 --send
→ BrainX 冻结推荐 + 顾问 open_id
→ 飞书官方 tenant_access_token
→ 机器人互动卡片私聊
```

- `src/feishu-bot.js` 使用 `BRAINX_FEISHU_APP_ID` / `BRAINX_FEISHU_APP_SECRET` 直连飞书官方接口，不再要求本机安装 `lark-cli`。
- 接收人默认从 `consultants.open_id` 按 `consultant_id` 解析；自动任务不得传群 `chat_id`。
- `--slot` 会生成“日期 + 时段”幂等键，同一顾问同一时段重复触发只发送一次。
- 这是单顾问、私聊、只推卡的临时闭环，不代表 OpenClaw 飞书对话渠道、Skill 或生产身份网关已经接通。
- 创建任务前必须先手动运行一次真实发送并确认接收人、机器人权限和卡片内容正确。

### 2.2 工具清单快照（以运行时 `tools/list` 为准）

| 工具 | 读/写 | 用途一句话 | 外露状态 |
|---|---|---|---|
| `brainx_workbench` | 读 | 本人同步状态、承接摘要、待行动项和今日 Top 3 | ✅ 当前 OpenClaw 外露 |
| `brainx_recommendations` | 读 | 本人最近一轮冻结推荐 | ✅ 当前 OpenClaw 外露 |
| `brainx_opportunity` | 读 | 本人可见职位的事实、事件、结果和推荐证据 | ✅ 当前 OpenClaw 外露 |
| `brainx_progress_suggestion` | 读 | 生成下一行动草案，不写库 | ✅ 当前 OpenClaw 外露 |
| `brainx_replay` | 读 | 本人决策轨迹回放 | ✅ 当前 OpenClaw 外露 |
| `brainx_push_preview` | 读 | 预览个人推荐卡，不发送 | ✅ 当前 OpenClaw 外露 |
| `brainx_candidate_shortlist` | 读 | 已授权职位的脱敏候选列表 | ⚠️ 当前单顾问 + 单租户 PoC 外露 |
| 其他 MCP 工具 | 混合 | 见白名单文档逐个审 | 🚫 当前 OpenClaw `toolFilter` 不外露 |

> **对方接入时的纪律**：黑名单工具不要挂进自动路径；写工具必须由 Skill 显式发起且带 `consultant_id`；任何工具返回 `forbidden`/`guard` 类错误属正常守门，不要重试绕过。

### 2.3 调用纪律（防止再次出 sync_now 类事故）

1. 当前 OpenClaw 只外露 7 个精确只读工具，任何写工具都不得由 Skill 猜测或绕过 `toolFilter` 调用。
2. 顾问和租户由服务端绑定，模型不传、不猜测、不覆盖身份参数。
3. 错误响应面向日志，不原样展示给终端用户；对象不存在和无权访问对外统一按不可展示处理。

## 3. 接缝 2：consultant_id 身份映射

### 3.1 规则

| 规则 | 说明 |
|---|---|
| 后端唯一身份键 | `consultant_id`（字符串）。所有 MCP 工具入参、数据隔离、job_memberships 关系均以此为准 |
| open_id 不进后端 | OpenClaw 侧把飞书 `open_id` 翻译成 `consultant_id` 后再调工具；后端表结构中没有 open_id 列 |
| 映射的权威在 OpenClaw 侧 | 映射表（含增删改、失效处理）由对方维护；后端不提供映射读写接口 |
| 群维度例外 | 后端网关自行登记 `chat_id`（chat_contexts 表，只存 chat_id/bot_mode/开关），**与 consultant_id 无关**——群消息提炼不经过身份映射 |

### 3.2 边界内的两类通道互不相干

- **前台对话通道**（OpenClaw 插件）：open_id → consultant_id → MCP 工具。
- **群消息通道**（后端网关）：chat_id → 事件账本 → job_facts 提炼，全程无个人身份。

## 4. 接缝 3：Skill 素材

- 仓库当前共 6 个 BrainX Skill：`brainx-workbench`、`brainx-engagement`、`brainx-report`、`brainx-ops`、`brainx-talent`、`brainx-data-explorer`。
- 当前 `brainx` OpenClaw profile 已安装前 5 个，均为 Ready、model-visible、user-invocable；它们只引用本节列出的 7 个精确白名单工具。
- `brainx-data-explorer` **不安装**：它依赖 `query_sql`，会把自然语言输入扩大成数据库查询面，与当前最小权限设计冲突。
- `brainx-workbench` 负责今日优先级、推荐榜、职位详情和回放；`brainx-talent` 负责候选 shortlist；`brainx-report` 只基于可见工具写报告；`brainx-engagement` 对写意图只查证并指引用户去页面操作；`brainx-ops` 只做业务层诊断，不执行 Shell 或查日志。
- 数据责任人已明确授权 Mia 本人可见的职位、客户、承接和进展字段进入当前 OpenAI 模型；仍不包含候选联系方式、原始聊天、密钥或数据库连接信息。真实 smoke run `ff689790-c7fd-4fdf-a1b3-583ccd2cc079` 已成功调用 `brainx_workbench` 和 `brainx_opportunity`，工具失败 0、写操作 0。
- 首次真实回答暴露出时效口径问题：`sync.updated_at` 为 9 月 1 日，回答却使用“今天”。`brainx-workbench` 已补上 24 小时时效规则；超过阈值必须称为“最近一次可用快照”并优先建议同步。

## 5. 后端结构一屏（给对方的上下文，非契约）

对方理解工具行为时的最小背景——后端六层，接缝只发生在 L5 与 skills/：

```text
L0 飞书网关（等凭证） → L1 事件账本（幂等/状态机） → L2 决策库 SQLite（31 迁移）
→ L3 业务领域（模块持续演进） → L4 调度推送（只私聊，在跑） → L5 MCP 交付（运行时清单 ← 接缝1）
                                                    skills/（6 个 md，安全安装集 5 个）
```

- MCP 工具读写的是 L2 决策库，经 L3 业务模块，**守门与脱敏都做在 L5**——所以对方看到的报错都发生在最外层，规则见白名单文档。
- 后端已补完的两块与对方有关：①写工具守门（`brainx_record_outcome` 已转 ✅，P0 三件全部完成）；②`job_facts` 提炼层 E1→E3 闭环已打通（纯后端内部，产出只进决策库，对方经 `brainx_jobs`/`brainx_job_detail` 读到，接口不变；确认动作经新工具 `brainx_confirm_facts` 走 MCP，Skill 可编排）。

## 6. 交付包清单（对方拿走什么）

| # | 交付物 | 位置 | 状态 |
|---|---|---|---|
| 1 | MCP server（运行时） | `mcp/server.mjs` + [部署文档](2026-09-02-brainx-mcp-deliverable.md) | ✅ 可交付 |
| 2 | 本接口包（契约） | 本文 | ✅ 可交付 |
| 3 | Skill 素材 | `skills/`（6 个 md；OpenClaw 安全安装集 5 个） | ✅ 已安装并完成本地白名单校验 |
| 4 | 工具外露白名单（纪律） | [白名单文档](2026-09-02-tool-exposure-whitelist.md) | ✅ 可交付 |
| 5 | open_id ↔ consultant_id 映射表 | OpenClaw 侧自建 | ⬜ 对方职责 |
| 6 | 前台对话 Skill 安装 | 当前 `brainx` OpenClaw profile | ✅ 5 个 Ready；工作台真实烟测通过 |

## 相关文档

- [BrainX 下游交付文档](2026-09-02-brainx-mcp-deliverable.md) — 工具契约、协议、打包部署的权威来源（本文是其接缝摘要）
- [后端侧模块结构与下一步安排](2026-09-02-backend-module-structure.md) — 六层结构与 §5 三接缝的原始裁定
- [工具外露白名单（全量）](2026-09-02-tool-exposure-whitelist.md) — 哪些工具能外露的唯一权威
- [OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md) — OpenClaw 侧技术分层
- [群消息 → job_facts 提炼层研发路径](2026-09-02-job-facts-extraction-roadmap.md) — 同日产出的提炼层路径（§5 提到的后端内部改造）

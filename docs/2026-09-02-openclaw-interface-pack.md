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
│  openclaw.json 挂 brainx-domain ───────┼──接缝1─▶  mcp/server.mjs（15 工具，stdio）    │
│  放置/启用 skills/ 8 个 md  ◀──────────┼──接缝3──  skills/（7 个已合规，纯文本）          │
└────────────────────────────────────────┘        └────────────────────────────────────────┘
```

| 接缝 | 我方给什么 | 对方做什么 |
|---|---|---|
| **1 工具调用** | `mcp/server.mjs`（stdio，JSON-RPC 2.0，零依赖） | `openclaw.json` 的 `mcp.servers` 挂 `brainx-domain` |
| **2 身份映射** | 一切接口只认 `consultant_id` 字符串 | 维护 `open_id ↔ consultant_id` 映射；后端永不接收/存储 open_id |
| **3 Skill 素材** | `skills/` 8 个 md（7 个已合规） | 放置到 OpenClaw Skill 目录并启用 |

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
        "transport": "stdio"
      }
    }
  }
}
```

- 协议：JSON-RPC 2.0 over stdio，零 npm 依赖，`node mcp/server.mjs` 直接起。
- 方法：`initialize` / `tools/list` / `tools/call`。对方接入后先调 `tools/list` 拿实时清单——**清单以运行时返回为准**，本文表格是快照。
- 部署与打包细节（Docker、环境凭据、版本）：见[下游交付文档](2026-09-02-brainx-mcp-deliverable.md)，本文不重复。

### 2.2 工具清单（15 个快照，2026-09-02）

| 工具 | 读/写 | 用途一句话 | 外露状态 |
|---|---|---|---|
| `brainx_summary` | 读 | 顾问级项目概览 | ✅ 可用 |
| `brainx_jobs` | 读 | 职位列表与筛选 | ✅ 可用 |
| `brainx_job_detail` | 读 | 单职位详情 | ✅ 可用 |
| `brainx_commitments` | 读 | 承诺/待办清单 | ✅ 可用 |
| `brainx_engage` | 写 | 对职位表态（接单/跟进），ACCEPT 分支可触发自动找人 | ✅ 可用 |
| `brainx_record_outcome` | 写 | 录入职位结果 | ✅ 可用（`jobVisibleTo` 守门已补，硬前置 1b 完成） |
| `brainx_confirm_facts` | 写 | 确认/驳回职位信息草稿（E3 确认闭环；confirm 支持草稿转正到 job_facts，reject 终态；带 project_id 时校验职位可见性） | ✅ 可用 |
| `brainx_replay` | 读 | 决策轨迹回放 | ✅ 可用 |
| `brainx_recommend` | 读 | 推荐队列 | ✅ 可用 |
| 其余 7 个 | 混合 | 见白名单文档逐个审 | ⚠️ 见白名单 |
| `brainx_sync_now` | 写 | 同步任务 | 🚫 **黑名单**（默认参数刷库，硬前置 1a） |
| `brainx_talent` | 写 | 人才库直查 | 🚫 **黑名单**（无 cid 隔离，硬前置 1c） |

> **对方接入时的纪律**：黑名单工具不要挂进自动路径；写工具必须由 Skill 显式发起且带 `consultant_id`；任何工具返回 `forbidden`/`guard` 类错误属正常守门，不要重试绕过。

### 2.3 调用纪律（防止再次出 sync_now 类事故）

1. **所有写调用必带 `consultant_id`**——后端按此隔离数据视图，缺失即拒绝。
2. **不缓存写结果**——决策库是唯一真值，读后立即用、不长期持有。
3. **错误处理**：JSON-RPC error 对象里的 `code` + `message` 是契约的一部分；`message` 面向日志，不直接展示给终端用户（可能含守门细节）。

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

- 我方产出：`skills/` 目录 8 个 SKILL.md，其中 7 个已通过合规实测（内容见仓库，对方按需复制）。
- 对方职责：放置到 OpenClaw Skill 加载路径、启用、维护本地版本。
- 合规基线（我方已验证，对方改动后需自行复审）：不硬编码任何个人 open_id、不含敏感字段明文示例、不引导绕过 MCP 守门。
- Skill 与工具的对应关系示例：Skill 编排「推荐队列浏览」时调 `brainx_recommend`；「录入结果」时调 `brainx_record_outcome`（守门已补完，可直接编排）；「群消息提炼确认」时调 `brainx_confirm_facts`（草稿列表经后端日历/推送触达顾问，顾问确认后落 job_facts）。

## 5. 后端结构一屏（给对方的上下文，非契约）

对方理解工具行为时的最小背景——后端六层，接缝只发生在 L5 与 skills/：

```text
L0 飞书网关（等凭证） → L1 事件账本（幂等/状态机） → L2 决策库 SQLite（31 迁移）
→ L3 业务领域（48 模块） → L4 调度推送（只私聊，在跑） → L5 MCP 交付（15 工具 ← 接缝1）
                                                    skills/（8 个 md ← 接缝3）
```

- MCP 工具读写的是 L2 决策库，经 L3 业务模块，**守门与脱敏都做在 L5**——所以对方看到的报错都发生在最外层，规则见白名单文档。
- 后端已补完的两块与对方有关：①写工具守门（`brainx_record_outcome` 已转 ✅，P0 三件全部完成）；②`job_facts` 提炼层 E1→E3 闭环已打通（纯后端内部，产出只进决策库，对方经 `brainx_jobs`/`brainx_job_detail` 读到，接口不变；确认动作经新工具 `brainx_confirm_facts` 走 MCP，Skill 可编排）。

## 6. 交付包清单（对方拿走什么）

| # | 交付物 | 位置 | 状态 |
|---|---|---|---|
| 1 | MCP server（运行时） | `mcp/server.mjs` + [部署文档](2026-09-02-brainx-mcp-deliverable.md) | ✅ 可交付 |
| 2 | 本接口包（契约） | 本文 | ✅ 可交付 |
| 3 | Skill 素材 | `skills/`（8 个 md） | ✅ 可交付（对方复审合规） |
| 4 | 工具外露白名单（纪律） | [白名单文档](2026-09-02-tool-exposure-whitelist.md) | ✅ 可交付 |
| 5 | open_id ↔ consultant_id 映射表 | OpenClaw 侧自建 | ⬜ 对方职责 |
| 6 | 前台对话 Skill 编写 | OpenClaw 侧自建 | ⬜ 对方职责 |

## 相关文档

- [BrainX 下游交付文档](2026-09-02-brainx-mcp-deliverable.md) — 工具契约、协议、打包部署的权威来源（本文是其接缝摘要）
- [后端侧模块结构与下一步安排](2026-09-02-backend-module-structure.md) — 六层结构与 §5 三接缝的原始裁定
- [工具外露白名单（全量）](2026-09-02-tool-exposure-whitelist.md) — 哪些工具能外露的唯一权威
- [OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md) — OpenClaw 侧技术分层
- [群消息 → job_facts 提炼层研发路径](2026-09-02-job-facts-extraction-roadmap.md) — 同日产出的提炼层路径（§5 提到的后端内部改造）

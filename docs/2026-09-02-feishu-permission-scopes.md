# 飞书权限清单（2026-09-02 研发对齐会定论版）

> 依据：2026-09-02 16:27「研发对一下」妙记（`minute_token=obcnsf91z37eqqv8d87f591q`，38 分 53 秒，参与者 York 姚堃 / Mia 钟笑咪）。
> 定位：把会议里定的 MVP 能力映射成**飞书后台要勾选的精确 scope 与事件**，可直接照着操作。
> 上游：[OpenClaw 壳子架构](2026-09-02-openclaw-shell-architecture.md)（§4.4 飞书后台 6 步）、[下游交付文档](2026-09-02-brainx-mcp-deliverable.md)（§9 OpenClaw 侧需要什么）。

## 1. 一句话结论

会议定的 MVP 需要**两套身份的权限**，不是一套：

- **日常对话与推送**走**应用身份（bot）**——权限轻、审批快，第一版就能上。
- **读群内全量历史与实时消息**走**用户身份（OAuth）**——这是唯一的高敏感项，且**York 会上那句"直接把机器人拉进所有群，减少接口权限开发"这个假设不成立**。

## 2. 为什么"拉机器人进群"不够（必须先纠正的认知）

飞书把群消息权限拆得很细，机器人入群**不等于**能读群消息：

| 权限 | 实际能读到什么 |
|---|---|
| `im:message.group_at_msg:readonly` | **只有 @机器人 的消息** |
| `im:message.p2p_msg:readonly` | 只有私聊发给机器人的消息 |
| `im:message.group_msg`（应用身份）/ `im:message.group_msg:get_as_user`（用户身份） | **群内所有消息，含历史** |

机器人在群里默认只会收到 `im.message.receive_v1` 事件，而该事件**只在消息发给机器人或 @机器人 时触发**。Mia 与 York 之间、合伙人与候选人之间的对话，机器人一条都收不到。

而会议定的是：

> 「AI 助手接入 York 团队现有所有业务群，**直接读取群内全量历史与实时消息**」
> 「群内信息可通过开源算法 + 自研 Agent 能力提炼为标准化字段」
> 「综合读取群聊信息、CRM 数据库数据核验工作」

这三条**全部依赖"读全量群消息"**，必须走高敏感权限，绕不开。

仓库里已有血泪实证：`src/oauth.js:32` 的注释记录了「`im:message:readonly` 单独不够，必须加 `im:message.group_msg:get_as_user`」。

## 3. 会议定论 → 权限映射

| 会议定的能力 | 依赖的飞书权限 | 走哪个身份 | 敏感度 |
|---|---|---|---|
| 每天推 10 个岗位到对话窗口，用户确认 | `im:message:send_as_bot` + 事件 `im.message.receive_v1` | 应用 | 低 |
| 确认后自动启动后台找人（OpenMai / reloop） | 无（纯后端，不走飞书） | — | — |
| 候选人结果推回对话窗口，接受或回流重筛 | `im:message:send_as_bot` | 应用 | 低 |
| 每日在指定群内报备当日推送人数 | `im:message:send_as_bot` | 应用 | 低 |
| **群内信息提炼为标准化字段 / 目标检查 / 接单自动生成目标** | **`im:message.group_msg:get_as_user` + `im:message:readonly` + `im:chat:read` + `im:chat.members:read`** | **用户** | **高敏感** |
| 解析说话人是谁（不把不同人当同一个） | `contact:user.base:readonly` | 应用 | 低 |
| 第二版：拉群承载独立事项 | `im:chat:create`（或 `im:chat` 写权限） | 应用 | 高敏感，待审批 |
| 第二版：项目 Sheet 管理列表 | `sheets:spreadsheet`（或 `drive:drive`） | 应用 | 中 |

> 会议明确：**第一版 MVP 不做拉群与项目 Sheet**（涉及敏感权限，需单独对接公司审批人）；第二版视审批结果推进。

## 4. 精确 scope 清单（可直接批量导入）

飞书后台「权限管理」页面支持**批量导入 JSON**，比逐个勾选可靠。分应用身份（tenant）与用户身份（user）两组，**不要混在一起申请**。

### 4.1 应用身份（tenant）— 第一版 MVP 最小集

覆盖：对话交互、每日推岗位、报备人数、解析说话人。

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:send_as_bot",
      "im:chat",
      "contact:user.base:readonly",
      "im:resource"
    ]
  }
}
```

| scope | 作用 | 缺了会怎样 |
|---|---|---|
| `im:message` | 获取与发送单聊、群组消息（核心） | 收发消息的基础，没有它什么都做不了 |
| `im:message.p2p_msg:readonly` | 读取用户私聊发给机器人的消息 | 私聊场景收不到 |
| `im:message.group_at_msg:readonly` | 接收群里 @机器人 的消息 | **群里 @机器人 完全没反应**（最常见的坑） |
| `im:message:send_as_bot` | 以机器人身份发消息 | 推不了岗位、报备不了人数 |
| `im:chat` | 获取群信息 / 群成员 | 拿不到 chat_id，无法登记上下文 |
| `contact:user.base:readonly` | 获取用户基本信息 | 报 `99991672`，**无法识别说话人是谁** |
| `im:resource` | 上传下载图片、文件 | 发不了图片附件 |

### 4.2 用户身份（user）— 群消息全量读取（高敏感）

**`src/oauth.js:27-38` 已有一份实证过的 9 项清单，不要动它。** 2026-08-10 实锤：`--recommend` 全量包被管理员驳回，而这 9 项在 Mia 2026-07-09 授权里已存在 = 必然在租户白名单内。

其中与「读群消息」直接相关的是这四项，**必须齐活**：

| scope | 作用 |
|---|---|
| `im:message:readonly` | 获取历史消息（单独不够） |
| `im:message.group_msg:get_as_user` | 群消息读取的「以用户身份」细分 scope —— **关键项** |
| `im:chat:read` | 读群信息 |
| `im:chat.members:read` | 读群成员 |

完整 9 项（含离线刷新，缺 `offline_access` 飞书不发 refresh_token）：

```
offline_access
auth:user.id:read
contact:user.base:readonly
im:message:readonly
im:message.group_msg:get_as_user
im:chat:read
im:chat.members:read
base:app:read
base:table:read
base:record:read
```

## 5. 事件订阅清单

订阅方式必须选**「使用长连接接收事件」**，**不要选 Webhook**（BrainX 自建网关 `src/gateway/ws-client.js` 走的就是长连接）。

| 事件 | 作用 | 必需 |
|---|---|---|
| `im.message.receive_v1` | 接收消息 v2.0 | **必需** |
| `im.message.message_read_v1` | 消息已读 | 建议 |
| `im.chat.member.bot.added_v1` | 机器人进群 | 建议（自动登记 chat_id） |
| `im.chat.member.bot.deleted_v1` | 机器人被移出群 | 建议 |

> 顺序坑：**必须先在本地把 App ID / Secret 配好并重启网关，再去飞书后台配长连接**。反了会提示「未建立长连接」。

## 6. 三条要跑审批的敏感权限（对应妙记里的 todo）

妙记 AI 待办里 Mia 名下有 3 条，其中 2 条是权限审批：

| 权限 / 资源 | 用途 | 找谁 | 状态 |
|---|---|---|---|
| 读群全量消息：`im:message.group_msg`（应用身份）或 `im:message.group_msg:get_as_user`（用户身份） | 群信息提炼、目标检查 | 飞书管理员 / 审批人 | **待沟通**，需确认可开放与不可开放范围 |
| 拉群：`im:chat:create` 一类写权限 | 第二版项目群 | 审批人 | **待沟通**（第二版才需要） |
| 团队人才库整库共享账号 | 拿到即可省掉数据隔离模块（约两个模块开发量） | 人才库 owner | **申请中，暂未通过** |

### 人才库的两条路（会议已拍板：并行推进）

1. **临时方案（先落地）**：组织团队成员把各自人才库共享给 TTC / York AI 助手，每人操作一次，约半小时，开发量极低。
   → 代价：用户需登录 reloop 才能被抓取数据，**必须额外开发数据隔离模块**。
2. **整库权限（同步申请）**：拿到后直接下线数据隔离模块。

> 这条直接回答了 [下游交付文档 §7.1 P0-3](2026-09-02-brainx-mcp-deliverable.md) 的「人才库契约对齐：只读 vs 可写」——会议给的答案是**先走临时方案 + 同步申请整库**，不是二选一。

## 7. 与现有代码的关系

| 位置 | 现状 | 结论 |
|---|---|---|
| `src/oauth.js` `OAUTH_SCOPES` | 9 项用户身份 scope，已实证在租户白名单内 | **不要改**，改了可能触发驳回 |
| `src/gateway/ws-client.js` | 已订阅 `im.message.receive_v1`，路径 A 已实现 | 配好凭证即可跑 |
| `src/gateway/lark-gateway.js` | 纯逻辑层 `processLarkEvent` | 已有 |
| `src/gateway/chat-contexts.js` | chat_id 登记 | 已有 |

## 8. 红线

1. **改完权限必须「版本管理与发布 → 创建版本 → 确认发布」**，否则权限和事件都不生效。这是最常见的「明明勾了却没用」的原因。
2. **不要申请全量包**。2026-08-10 实证：`--recommend` 全量包被管理员驳回。只申请白名单内的最小集。
3. **批量导入 JSON 优于逐个勾选**，避免漏项和手滑。
4. **应用身份与用户身份分开勾选**，不要混在一起申请。
5. 人才库整库权限未落地前，**数据隔离模块不能省**（否则跨人可见，直接踩 `brainx_talent` 那个无 cid 隔离的老雷）。

## 9. 待确认

| 项 | 问谁 | 影响 |
|---|---|---|
| 租户是否允许开 `im:message.group_msg` 系列 | 飞书管理员 | 决定第一版能否做「群信息提炼」 |
| 若不允许，是否接受「群里 @机器人 才响应」的降级方案 | York | 决定第一版范围 |
| 拉群权限的确许可开放范围 | 审批人 | 决定第二版能否做项目群 |
| 团队人才库整库权限申请排期 | 人才库 owner | 决定数据隔离模块是否要写 |
| 会议室里说的「曾老师」是谁、对接什么任务细节 | Mia | 妙记 todo 第 3 条 |

## 相关文档

- [OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md) — §4.3 OpenClaw 侧接入步骤、§4.4 飞书后台 6 步
- [下游交付文档](2026-09-02-brainx-mcp-deliverable.md) — §9 OpenClaw 侧需要什么
- [DataClaw 交流会简报（历史底稿）](2026-09-02-dataclaw-integration-brief.md)
- `src/oauth.js` — 用户身份 scope 的实现与实证注释
- `src/gateway/ws-client.js` — 长连接事件订阅实现

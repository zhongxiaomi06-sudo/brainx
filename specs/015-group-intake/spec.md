# 015 — 机器人进旧群自动发「绑定职位」卡（设计稿，待拍板）

状态：Design（未实现，2026-09-10）
上游：用户 2026-09-10 需求「可以把机器人拉到旧群，拉进去第一件事也是弹出卡片开始找人」。
关联：[014 项目群卡片动作](../014-launch-card-actions/spec.md)、[013 拉群即见卡](../013-launch-card-first/spec.md)。

## 1. 问题

现在只有「工作台接单 → 系统建群」这一条链路会发卡。顾问把一个已有群（比如和客户的老群）拉进机器人时，
openclaw 不在 `groupAllowFrom` 里 → 机器人完全不响应；`agent_group_scopes` 也没有这个群 → 即使响应也会被
`NOT_FOUND_OR_FORBIDDEN` 挡回。结果：群里静悄悄，顾问以为机器人坏了。

## 2. 硬约束（已确认，不要推翻）

1. **不为同一飞书应用启动第二条事件长连接**（`docs/2026-09-03-braintex-feishu-home.md` 明确决定）。
2. **openclaw 飞书插件对 `im.chat.member.bot.added_v1` 只记日志**，没有自定义处理口（`docs/2026-09-03-braintex-server-deployment-agent-manual.md` §347）。
3. 不在仓库里改第三方安装目录里的代码。
4. 卡片输入框的 `form_value` 拿不到（见 014 §2.2），卡片能给的东西有限。

结论：**入群感知只能靠轮询机器人所在群列表**（`GET /open-apis/im/v1/chats`，tenant_access_token，需 `im:chat` 权限），不能靠事件。

## 3. 方案（推荐）

### 3.1 发现新群

新增 `src/group-intake.js`：

- `listBotChats()`：`GET /open-apis/im/v1/chats?page_size=50&user_id_type=open_id`，翻 `has_more/page_token`。
- `startGroupIntakeWorker(db, opts)`：默认每 10 分钟一轮（`BRAINX_GROUP_INTAKE_INTERVAL_MS`），`BRAINX_GROUP_INTAKE_OFF=1` 关闭，挂在 `src/worker.js`。
- **首轮只做基线**：`bot_chat_intake` 表为空时，把当前所有群全部记成 `SEEN` 且**不发卡**——否则一上线就会给历史上所有群（含死群 oc_5494e54）轰炸一遍。之后新出现的群才走发卡流程。

### 3.2 数据模型（migration 0050）

```sql
CREATE TABLE IF NOT EXISTS bot_chat_intake (
  chat_id       TEXT PRIMARY KEY,
  chat_name     TEXT,
  status        TEXT NOT NULL DEFAULT 'SEEN',   -- SEEN | CARD_SENT | BOUND | SKIPPED
  first_seen_at TEXT NOT NULL,
  card_sent_at  TEXT,
  project_id    TEXT,
  updated_at    TEXT NOT NULL
);
```

`agent_group_scopes` 新增一种状态 `PENDING_BINDING`（已有 `scope_status` 字段，无需改表）：
`allowed_purposes_json = ['group_binding']`、`allowed_senders_json = []`、`project_refs_json = []`。

### 3.3 待绑定态的授权（关键设计）

`src/agent-gateway/authorization.js`：当 scope 的 `scope_status='PENDING_BINDING'` 时，

- **放宽 sender 检查为「群内任意成员」**——入群时不知道谁会来绑定，必须放行；
- **但只允许 `group_binding` 这一个 purpose**，其他一切照旧拒绝；
- 绑定成功后把 scope 改为 `ACTIVE`，写入 `allowed_senders`（绑定人 + 项目成员）、`project_refs`（该职位）、完整 purposes，等同于 014 的建群登记。

新增工具 `brainx_bind_group_project({ job_id })`，purpose `group_binding`，群内可用、不要求项目范围，
`chat_id` 取自 `principal.chatId`（不能由参数传，防止越权绑定别人的群）。绑定后按 014 的规则补发找人卡。

### 3.4 卡片内容

进群即发（只发一次，`bot_chat_intake.status` 从 `SEEN` → `CARD_SENT`）：

> **我是 BrainTex 机器人**
> 这个群还没绑定职位，所以我暂时无法在这里找人。请任选一种方式：
> 1. 把 JD 直接粘贴到本群；
> 2. 点下方按钮，从你名下的职位里选一个。

按钮：「绑定我的职位」（指令：调用 `brainx_bind_group_project`，先用 `brainx_job_list` 列出顾问名下职位让他选；拿不到就请他把 JD 贴到群里）＋「打开工作台」。
不做下拉选择——`form_value` 拿不到（约束 4），下拉点了没反应比按钮更糟。

### 3.5 同时要做的事

发现新群时还要：`registerChatContext`、`ensureOpenClawGroupAllowed`（否则群内消息 openclaw 不收）。
这两步与 013 的补偿 worker 同一套函数，复用即可。

## 4. 外部群（阶段二另一半，需要你操作）

- 机器人能在外部群工作，前提是**飞书开放平台开启「对外共享」**：开发者后台 → 应用 → 版本管理与发布 → 对外共享 → 允许机器人被添加到外部群中使用（需企业认证或个人实名认证）。**这一步我无法代做**，需要你登录操作。
- 未开启时，顾问把外部人（如曾老师）拉进已有机器人的群，机器人会失效/被移除，报 `232033`。
- 开启后代码侧要做的：`createProjectChat` 时若职位登记了外部成员 open_id 就带上（群自动变外部群）；拿 `232033` 则回退内部群并记 `error_code`。
- 外部成员 open_id 只能等对方主动与机器人单聊后才能拿到，所以**拉外部人这件事仍由顾问自己在飞书里做**（你已确认）。

## 5. 风险与开关

| 风险 | 应对 |
|---|---|
| 首轮轰炸历史群 | 首轮只做基线不发卡 |
| 轮询拉到无关群（公司大群等） | 只发一次卡；群主可在群里说「退下」置 `SKIPPED`（可选） |
| `PENDING_BINDING` 放宽 sender | 只放行 `group_binding` 单一 purpose，绑定后立即收紧为正常 scope |
| 轮询频率与权限 | 默认 10 分钟；`im:chat` 权限需在开放平台确认已开通 |
| 死群干扰 | 复用 `chat_contexts.enabled`，已禁用的群直接 `SKIPPED` |

## 6. 工作量与验收

工作量约：1 个 migration（0050）+ 3 个模块改动（`group-intake.js` 新、`authorization.js`、`tool-registry.js` 新工具）+ `worker.js` 挂载 + 2 组新测试 + 文档。

验收：
1. 把机器人拉进一个新群 → 10 分钟内群里出现「绑定职位」卡；已存在的老群不会被轰炸。
2. 在卡上点「绑定我的职位」→ 机器人列出顾问名下职位 → 选定后 scope 变 ACTIVE 并补发找人卡。
3. 未绑定时在该群调用其它工具（如 `brainx_candidate_shortlist`）仍被拒。
4. `npm run verify`（full）通过。

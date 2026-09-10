# 015 — 机器人进旧群自动发「绑定职位」卡（设计稿，待拍板）

状态：Implementing（2026-09-10，用户拍板）
上游：用户 2026-09-10 需求「可以把机器人拉到旧群，拉进去第一件事也是弹出卡片开始找人」+「验证结束后发给顾问一个卡片提醒如何拉群，提醒不要拉太多群，不然消息会炸」。
关联：[014 项目群卡片动作](../014-launch-card-actions/spec.md)、[013 拉群即见卡](../013-launch-card-first/spec.md)。

> **范围调整（2026-09-10）**：外部群不做了（用户决定）。本规格只做「机器人进旧群自动发绑定职位卡 + 绑定后发拉群指引/防滥用提醒」。外部群相关条目已删除。

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

**采用 `groupIntakeBinding` 工具标记，不建 PENDING_BINDING scope 行**（比原设计更简单、不动 `authorizeGroup` 安全逻辑）：

- `brainx_bind_group_project` 在 tool-registry 标记 `groupIntakeBinding: true`、purpose `group_binding`、非 p2pOnly、不要求 project 范围。
- `authorization.js`：当 `options.allowIntakeBinding` 为真时，群内放行条件收窄为——①`resolveBinding` 通过（说话人是已登记顾问，这一步本身就把外人挡住）；②该 `chat_id` 在 `bot_chat_intake` 且 `status IN ('CARD_SENT','SEEN')`（即机器人主动接管过的群，不是随便一个群）；③`projectRef` 为 null。**完全跳过 `authorizeGroup`**，不查 `agent_group_scopes`。
- 其余一切工具没有这个标记 → 在未登记群里仍走 `authorizeGroup` → 找不到 ACTIVE scope → `NOT_FOUND_OR_FORBIDDEN`。**效果与 PENDING_BINDING 等价：未绑定时只有 bind 能调，绑完才有全部能力。**
- 绑定后 `activateGroup` 创建 ACTIVE scope（复用 014 的 GROUP_PURPOSES + 协作者 open_id + project_refs），此后该群走正常授权。

`agent_group_scopes.scope_status` 不新增 `PENDING_BINDING` 取值；`bot_chat_intake.status` 的 CARD_SENT 就是「待绑定」语义。

绑定工具 `chat_id` 取自 `principal.chatId`（不能由参数传，防越权绑别人的群）；`job_id` 可选——不传时返回顾问名下可绑职位清单让他选，传了 + `confirm:true` 才真正绑定。

### 3.4 卡片内容

进群即发（只发一次，`bot_chat_intake.status` 从 `SEEN` → `CARD_SENT`）：

> **我是 BrainTex 机器人**
> 这个群还没绑定职位，所以我暂时无法在这里找人。请任选一种方式：
> 1. 把 JD 直接粘贴到本群；
> 2. 点下方按钮，从你名下的职位里选一个。

按钮：「绑定我的职位」（指令：调用 `brainx_bind_group_project`，先用 `brainx_job_list` 列出顾问名下职位让他选；拿不到就请他把 JD 贴到群里）＋「打开工作台」。
不做下拉选择——`form_value` 拿不到（约束 4），下拉点了没反应比按钮更糟。

### 3.5 同时要做的事

发现新群时还要：`registerChatContext`、`ensureOpenClawGroupAllowed(chat_id, [])`（senders 空——顾问已在全局 `groupSenderAllowFrom`，无需再加）。
这两步与 013 的补偿 worker 同一套函数，复用即可。**不建 PENDING_BINDING scope 行**（见 3.3）。

## 4. 绑定后发拉群指引 + 防滥用提醒（用户新增要求）

绑定成功后，**私聊**给该顾问发一张指引卡（p2p，不是群内，避免污染客户群）：

- 标题：BrainTex 拉群使用指引
- 正文：
  - 你已把群「{chatName}」绑定到职位 {company·role}，现在可以在群里点按钮找人了。
  - **如何拉群**：在飞书任意群 → 群设置 → 群机器人 → 添加应用 → 选「BrainTex」。机器人进群后会自动弹「绑定职位」卡，选职位即可开始找人。
  - ⚠️ **不要拉太多群**：每个群机器人都会处理消息、按职位找人，群太多会让消息过载、token 成本飙升。**只给当前在做的职位建群**，做完的群可移除机器人。
- 按钮：「打开工作台」。

这一步在 `bindGroupToProject` 里完成，与找人卡一起发（找人卡发到群里，指引卡发到顾问私聊）。

## 5. 外部群

**不做了**（用户 2026-09-10 决定）。本规格不涉及外部群、对外共享、外部成员 open_id 登记。

## 6. 风险与开关

| 风险 | 应对 |
|---|---|
| 首轮轰炸历史群 | 首轮只做基线不发卡 |
| 轮询拉到无关群（公司大群等） | 只发一次卡；群主可在群里说「退下」置 `SKIPPED`（可选） |
| `PENDING_BINDING` 放宽 sender | 只放行 `group_binding` 单一 purpose，绑定后立即收紧为正常 scope |
| 轮询频率与权限 | 默认 10 分钟；`im:chat` 权限需在开放平台确认已开通 |
| 死群干扰 | 复用 `chat_contexts.enabled`，已禁用的群直接 `SKIPPED` |

## 7. 工作量与验收

工作量约：1 个 migration（0050）+ feishu-bot 增 listBotChats + 2 个模块（`group-intake.js` 新、`authorization.js` 改）+ 1 个新工具 + openclaw 插件同步（runtime.js + openclaw.plugin.json + 插件副本 cp）+ prompt 指引 + 3 组测试 + 文档。

验收：
1. 把机器人拉进一个新群 → 10 分钟内群里出现「绑定职位」卡；已存在的老群不会被轰炸。
2. 在卡上点「绑定我的职位」→ 机器人列出顾问名下职位 → 选定后 scope 变 ACTIVE、群里出现找人卡、顾问私聊收到拉群指引+防滥用提醒。
3. 未绑定时在该群调用其它工具（如 `brainx_candidate_shortlist`）仍被拒；绑定后才能用。
4. 指引卡包含「如何拉群」和「不要拉太多群」两条。
5. `npm run verify`（full）通过。

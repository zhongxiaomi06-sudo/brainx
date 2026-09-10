# 014 — 项目群内直接接单与找人卡片

状态：Implemented（阶段一，2026-09-10）
上游：york 2026-09-10 晚间会话（生产 openclaw 会话 `18cd0bc9…` + 群 `oc_baf49b…` 消息）。

## 1. 事实

| 时间 | 事件 |
|---|---|
| 20:01 | 工作台接单 → 自动建群成功 |
| 20:02 | 群内发「@机器人 找人」→ 无响应（白名单未生效，specs/013 已修） |
| 20:02 | 顾问退单（RELEASED） |
| 22:14 | 点卡片「OpenMai 继续找人」→ `JOB_NOT_ACCEPTED`；机器人回答「可以在这里说帮我接单」 |
| 22:23 | 顾问照做说「帮我接单」→ `brainx_accept_job{job_id,confirm:true}` 返回 `NOT_FOUND_OR_FORBIDDEN`；`brainx_pending_job_facts` / `brainx_me_context` 同样被拒 |
| 22:23 | 机器人放弃：「接单需要在私聊里完成，请去工作台」 |

根因：`brainx_accept_job`（purpose `job_action`）在 tool-registry 声明 `p2pOnly: true`；项目群 scope 的 `GROUP_PURPOSES` 只有 `job_review/candidate_review/candidate_action/interview_prep`，不含 `job_action`。**不是故障，是设计把群内接单堵死了**，而卡片又把用户引向群内接单。

## 2. 阶段一（本次实现）

### 2.1 群内接单放开

- `brainx_accept_job`：`p2pOnly: true` → `groupRequiresProject: true`。群内调用仍需：群已登记 `agent_group_scopes`、说话人在 `allowed_senders`、job_id 属于该群的 `project_refs`；参数仍要 `confirm: true`。
- `project-launch.js` 的 `GROUP_PURPOSES` 增加 `job_action`。
- migration `0049`：存量项目群 scope 的 `allowed_purposes` 补齐 `job_action`（幂等）。
- 只放开 `accept_job`；`start_candidate_search` / `record_job_progress` / `me_context` 等仍保持 p2pOnly，避免扩大群内写权限。

### 2.2 卡片改版（拉群即见卡）

`buildProjectLaunchCard(job, { state })`

- 状态行：显示当前承接状态（未接单 / 已接单）。
- 未接单：只给「接单」主按钮，文案说明接单后才能找人。
- 已接单：给三个找人按钮 —— **OpenMai 找人**（外部寻访）、**Reloop 找人**（内部人才库，`brainx_candidate_shortlist`）、**SuperMai 找人**（判据寻访）。
- 条件输入：卡片放 `input`（name `criteria`）+「按条件找人」按钮；指令要求「输入框有值就用它，否则读群里最近一条『找人条件：』，都没有就按职位事实」。
  - **已知限制**：openclaw 飞书插件不解析 `form_value`（插件 dist 全仓无该字段，card action 只把按钮 `value.text` 合成 text 消息）。因此输入值可能丢失 → 指令含兜底路径，填了没生效时机器人会退回「找人条件：」/职位事实，不会卡死。
  - 后续可选：brainx 自建长连接订阅 `card.action.trigger` 直接消费 `form_value`（不依赖 openclaw）。
- 保留「打开职位工作台」按钮。

### 2.3 外部群（阶段二前置，代码先备好）

飞书事实（官方文档）：
- 由应用创建的群，只要 `user_id_list` 同时含外部用户与内部用户即为外部群；机器人不能当群主（当前 owner=顾问，已满足）。
- 未开启「对外共享」时建外部群报 `232033`。开启路径：开发者后台 → 版本管理与发布 → 对外共享 → 允许机器人被添加到外部群中使用（需企业认证或个人实名认证）。
- 机器人要拉外部用户入群，必须先拿到其 open_id：外部用户主动与机器人单聊触发事件后机器人才能获取。

阶段一不改建群成员逻辑；顾问仍自行在飞书里拉人。

## 3. 阶段二（待飞书后台开启后）

1. 默认建外部群：把职位登记的外部成员 open_id 加入 `user_id_list`；`232033` 自动回退内部群并记 `error_code`。
2. 外部联系人登记：外部用户与机器人单聊 → 记录 open_id + 姓名，供建群时选用。
3. 机器人被拉进旧群：订阅 `im.chat.members:bot_access`（权限已在开放平台申请范围）→ 入群即发「绑定职位」卡：可选已有职位或贴 JD，绑定后再发找人卡。

## 4. 边界与不变量

- 群内接单只放行给「群已登记 + 说话人是项目成员 + job 属于该群」的组合，不放大写权限。
- 接单仍需 `confirm: true`，服务端兜底 goal/due_at/idempotency_key 的语义不变（specs/011）。
- 卡片按钮的指令文本不得承诺「自动通知/自动推送」结果。
- 发卡失败仍然整条失败（specs/013 不变）。

## 5. 验收

1. 项目群内 `brainx_accept_job{job_id,confirm:true}` 成功；非项目群/非成员的调用仍被拒。
2. 未接单卡片只有接单按钮；已接单卡片有三个找人按钮。
3. 存量项目群 scope 的 purposes 含 `job_action`。
4. `registry.requiresP2p('brainx_accept_job') === false` 且 `requiresGroupProject(...) === true`。
5. npm run verify（full）通过。

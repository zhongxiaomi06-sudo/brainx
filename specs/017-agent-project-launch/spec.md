# 017 — agent 侧建群入口 + 私聊 bind 早失败

状态：Implementing（2026-09-11，用户拍板）
上游：2026-09-11 linda 投诉「接单了为啥不给我拉群」。
关联：[011 接单即拉群](../011-accept-simplify-launch/spec.md)、[014 项目群卡片动作](../014-launch-card-actions/spec.md)、[015 机器人进旧群绑定](../015-group-intake/spec.md)。

## 1. 问题（事故复盘）

linda 在飞书**私聊**里完成接单，随后发现没有项目群：

- 10:56:38 她说「接单」→ `brainx_accept_job` SUCCEEDED，`current_engagement` JBC31PR = ACCEPTED。
- 10:59:40 她问「你为啥不给我拉群啊？不是会接了单就拉群吗？」
- 11:03 她说「现在建群吧」→ 模型手上只有 `brainx_bind_group_project`，拿它顶包。
- 11:09:22~31 **私聊里连续 4 次 `GROUP_NOT_INTAKED`**。
- 11:14 她自己建群、拉机器人、点「绑定我的职位」卡片才走通（11:24:48 绑定成功）。

两个根因：

1. **建群只存在于 web 路径**。`server.js` 的 `POST /api/v1/opportunities/:id/engagement` → `postAcceptSideEffects`（011）会建群；而 agent 工具 `brainx_accept_job` 只做 accept + 补发卡。`AGENT_TOOL_ROWS` 里**没有任何建群工具** → 飞书对话里「接单即拉群」这条用户预期根本不成立。
2. **`GROUP_NOT_INTAKED` 不在错误文案表里**。`errorEnvelope` 用白名单，未登记的 code 一律退化成 `INTERNAL`「服务暂时无法完成请求」→ 模型既不知道错在哪，也不知道该去哪儿，只能重试。

叠加一个放大因素：`authorizePrincipal` 的 p2p 分支**绕过了 intake 校验**（只比对 `chat_id === requester_sender_id`），
所以私聊里调 bind 会被放行到 handler，再在 `bindGroupToProject` 里撞上 `GROUP_NOT_INTAKED`——把一个本该在授权层就说清楚的错误，拖到了业务层。

## 2. 硬约束

1. **不重写接单流程**。`brainx_accept_job` 现有语义（accept + 补发卡 + 启动找人）保持不变，群内接单不重复建群。
2. **建群复用 `launchProject`**（013 已有：建群 → 发卡 → OpenClaw 准入 best-effort → 置 READY），不另写一套。
3. 准入依旧不得成为发卡的硬前置（09-10 york 事故结论）。
4. 工具白名单是安全边界，新增工具必须走「网关注册表 + 插件声明 + 生产 openclaw.json」三处同步。

## 3. 方案

### 3.1 新增工具 `brainx_launch_project_chat`

- 语义：为某个**已接单**职位创建（或复用）飞书项目群，并把职位卡发进群。
- 参数：`job_id`（必填）、`confirm`（必填，true 才执行）、`force`（可选，卡片内容变了要重发时用）。
- 幂等键：`agent-launch:<consultantId>:<jobId>`，重复调用返回 `already: true`，不重复建群。
- 授权：`purpose=job_action`、`groupRequiresProject=true`（群内调用时，群必须登记了该项目）。
- 提示词侧：私聊接单成功后，若该职位还没有项目群，**直接**调用本工具建群，不再问顾问要任何参数。

### 3.2 私聊 bind 早失败

`authorizePrincipal`：`allowIntakeBinding` 的工具（目前只有 `brainx_bind_group_project`）在非 group 会话直接
`fail('GROUP_REQUIRED')`；`authorizeIntakeBinding` 里 intake 缺失 → `GROUP_NOT_INTAKED`、已 BOUND → `GROUP_ALREADY_BOUND`。

### 3.3 错误文案补全

`errorEnvelope` 白名单新增可在 agent 侧触达的业务错误，让模型（和顾问）拿到的是**可执行的中文指引**，
而不是 `INTERNAL`：`GROUP_REQUIRED`、`GROUP_NOT_INTAKED`、`GROUP_ALREADY_BOUND`、`PROJECT_MEMBERSHIP_REQUIRED`、
`AGENT_IDENTITY_BINDING_REQUIRED`、`BRAINX_BASE_URL_REQUIRED`、`FEISHU_CHAT_CREATE_FAILED`、`PROJECT_LAUNCH_IN_PROGRESS`。

## 4. 验收

1. 私聊调 `brainx_bind_group_project` → `GROUP_REQUIRED`，文案明确指向「先拉机器人进群再点绑定卡」。
2. 群里调 bind 但群未接管 → `GROUP_NOT_INTAKED`（不再是 INTERNAL）。
3. 私聊调 `brainx_launch_project_chat`（job_id + confirm）→ 建群、发卡、置 READY；重复调用幂等返回已存在。
4. 未接单 / 无成员关系 / 身份未绑定的职位 → 对应 blocker 文案，不产生半成品群。
5. 插件与网关工具清单一致（25 个），`npm run verify` 全绿。

## 5. 非目标

- 不做「接单时后端自动建群」的流程改造（本轮用工具 + 提示词对齐，避免动 011 主链路）。
- 不改外部群、不改准入策略。

# 015 — 实施计划

## 改动清单

| 文件 | 改动 |
|---|---|
| migrations/0050_bot_chat_intake.sql | 新建 bot_chat_intake（chat_id PK, status SEEN/CARD_SENT/BOUND/SKIPPED, first_seen_at, card_sent_at, project_id, updated_at） |
| src/feishu-bot.js | 新增 listBotChats（GET /open-apis/im/v1/chats 翻页） |
| src/group-intake.js | 新增：startGroupIntakeWorker（首轮基线不发卡、新群登记+发绑定卡）、buildBindCard、buildGuidanceCard、bindGroupToProject（激活范围+发找人卡+发指引卡）、listBindableJobs |
| src/agent-gateway/authorization.js | authorizePrincipal 增 allowIntakeBinding 分支：群内只校验 bot_chat_intake 状态(CARD_SENT/SEEN)+purpose=group_binding+已登记身份，跳过 authorizeGroup |
| src/agent-gateway/tool-registry.js | 新增 brainx_bind_group_project（purpose group_binding, groupIntakeBinding:true, job_id 可选+confirm 必填）+ requiresIntakeBinding 方法 |
| src/agent-gateway/tools-actions.js | 新增 bindGroupProject handler：无 job_id 列职位；有 job_id+confirm 调 bindGroupToProject |
| src/agent-gateway/server.js | 透传 allowIntakeBinding |
| src/worker.js | 挂载 startGroupIntakeWorker（BRAINX_GROUP_INTAKE_OFF=1 关闭） |
| plugins/brainx-openclaw/runtime.js | BRAINX_OPENCLAW_TOOLS 增 brainx_bind_group_project；PLUGIN_VERSION 1.3.9→1.4.0 |
| plugins/brainx-openclaw/openclaw.plugin.json | tools 数组加 brainx_bind_group_project |
| plugins/brainx-openclaw/package.json | 版本 1.3.6→1.4.0 |
| plugins/brainx-openclaw/prompt.js | 增绑定流程指引（按钮即确认、列职位让顾问选、不问 job_id） |
| deploy/openclaw/openclaw.production.json | tools.allow 加 brainx_bind_group_project |
| tests/group-intake.test.mjs | 新增 9 组 |
| tests/{framework,agent-golden-workflow,agent-gateway-http,openclaw-plugin,openclaw-production-config}.test.mjs | 工具数 24→25、契约 fixture 加项、插件版本同步 |

## 设计决策

1. **不建 PENDING_BINDING scope 行**，改用 `groupIntakeBinding` 工具标记（见 spec §3.3）。不动 `authorizeGroup` 安全逻辑；`brainx_bind_group_project` 是未登记群里唯一可调的工具，靠 `bot_chat_intake` 卡口（机器人主动接管过的群）+ 已登记顾问身份放行。绑定后 `activateGroup` 创建 ACTIVE scope，其余工具才能用。
2. **chat_id 取自 principal**，不可由参数传——防越权绑别人的群。
3. **job_id 可选**：不传返回顾问可绑职位清单（让 LLM 列给顾问选），传了+confirm 才绑定——顾问不需要知道 job_id。
4. **首轮只做基线**：bot_chat_intake 为空时把当前所有群记 SEEN/SKIPPED 不发卡，避免上线轰炸历史群（含死群 oc_5494e54）。
5. **发卡 best-effort**：openclaw 准入、找人卡、指引卡失败都不阻断主流程；指引卡发到顾问私聊（不污染客户群）。

## 部署同步（生产 47.110.93.137）

1. 代码 SSH 直推 deploy-tmp → ff-only 合并。
2. migration 0050 自动应用（三服务同启竞态由 systemd 自愈）。
3. **插件副本同步**：`cp plugins/brainx-openclaw/{runtime.js,openclaw.plugin.json,prompt.js} /var/lib/brainx/.openclaw/extensions/brainx-openclaw/` + `chown brainx:brainx`，否则 openclaw 用旧 schema 调工具 → 网关拒绝 → INVALID_ARGUMENT（09-09 事故教训）。
4. 重启 brainx-agent-gateway（注册表）+ brainx-worker（轮询）+ openclaw-brainx（插件）。
5. 生产 openclaw.json tools.allow 手工加 brainx_bind_group_project（模板已改）。
6. 冒烟：把机器人拉进一个新群 → 10 分钟内出绑定卡；点「绑定我的职位」→ 列职位 → 选定后群里出找人卡、私聊出指引卡。

## 风险

- 轮询拉到无关群（公司大群等）：只发一次卡；群主可在飞书移除机器人，下一轮标 SKIPPED（已禁用 chat_context）。后续可加「顾问回复退下即 SKIPPED」。
- `allowIntakeBinding` 是新的授权特例：严格限定 purpose=group_binding + bot_chat_intake 卡口，绑定后立即收紧为正常 scope；已有回归测试覆盖「未接管/已绑定/普通工具」三种拒绝。
- openclaw 副本不同步是最高频事故：必须 cp + chown + 重启 openclaw-brainx。

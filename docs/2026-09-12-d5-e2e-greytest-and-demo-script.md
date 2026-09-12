# D5 全链路灰测结论与演示脚本（2026-09-12）

> 上级：[文档书总目录](README.md) · 清单：[0.9 冲刺交付清单](2026-09-12-sprint-delivery-checklist.md)

## 一、灰测结论（全部在生产真实链路验证，测试账号 mia）

| 环节 | 结果 | 证据 |
|-|-|-|
| 接单（agent 侧） | ✅ | mia 调 `brainx_accept_job`（JNOEILO）→ ACCEPTED，membership 同步落 MY_JOB（修复后） |
| 建群 + 职位卡 | ✅ | `brainx_launch_project_chat` → 新群「智子芯元（深圳）科技有限责任公司-AI产品经理」READY，群卡秒到 |
| 找人 → 候选人投递 | ✅ | 接单自动触发 OpenMai（om_43a0bb74）→「首轮候选人已就绪」总览卡（6 人，每行重点关注）自动回群 |
| 初筛通过 → 自动推三按钮卡 | ✅ | marker 消息 → agent 调 KEEP_FOR_REVIEW → FOCUSED + 自动推「BrainTex · 候选人卡片」（查看链接/初筛通过/一键加入人才库 三按钮齐全） |
| 一键加入人才库 → RDS 真实写入 | ✅ | marker 消息 → agent 调 `brainx_talent_pool_add` → 黄俊凯 #396 写入 RDS；幂等标记 `[ref:...]`；另工具直调李燊 #395 |
| SuperMai 服务端链路 | ✅ | `brainx_supermai_scout` 直通 done：私域无命中 → TTC 公域 228 命中精选 10 人（与 OpenMai 共用引擎，无需本地 GUI） |
| Web 端全部 UI 改动 | ✅ | 已随三轮部署上线（T8/T1/T2/T5/T3/T4/T6/T7/T13），门禁三轮 24/24 |

## 二、灰测中发现并处理的问题

0. **【演示必读】群内自然语言「把第 N 个候选人加入人才库」目前不可靠**：step-3.5-flash 不走「群名→daily_brief→job_id」解析，固执调用 bind_group_project 并虚报「全部接口权限错误」（审计实证它从未调用 shortlist/talent 工具）。根因之一是插件 prompt 注入被 `allowPromptInjection=false` 长期阻断（playbook 从未生效，本次已改 true 并同步模板），但 /reset + 新 prompt 后仍未纠正。**演示纪律：群内操作一律用卡片按钮（评委可点），自然语言只在私聊用明确公司/职位名（已验证：「帮我接 深圳思博威视 的智能影像产品经理」→ 接单建群全通）**。
1. **agent 接单不落 membership → 建群必报 PROJECT_MEMBERSHIP_REQUIRED**：已修代码（commit 1f6ffa5，接单幂等写 MY_JOB），回归测试补齐；NL 私聊接单链路已复验。
2. **测试群 scope senders 缺 mia**：数据修复补入（`agent_group_scopes` UPDATE，未改代码）。
3. **OpenClaw 新群准入 CLI 失败**（OPENCLAW_GROUP_ALLOWLIST_FAILED）：根因链有三层，已全部修复——①串行 5 次 CLI ≈25s 超 20s 默认超时（三个服务 env 追加 `BRAINX_OPENCLAW_TIMEOUT_MS=90000`）；②`brainx-agent-gateway` 生产单元未显式 `User=brainx` 以 root 运行，openclaw CLI 的配置归属校验拒绝 root 直读 600 配置（agent.env 追加 `BRAINX_OPENCLAW_RUN_AS=brainx`，repo 单元旧版即 `User=brainx`，生产与 repo 的分歧待赛后统一）；③`ProtectSystem=strict` 使 `/var/lib/brainx/.openclaw` 对服务只读（单元 `ReadWritePaths` 追加该路径，repo `deploy/systemd/brainx-agent-gateway.service` 已同步）。另：灰测期间曾以 root 手跑 CLI 把 openclaw.json 写成 root:root 600，已 chown 回 brainx——**生产排障不得以 root 直接执行 openclaw CLI**。修复后决策群创建端到端通过：群「黄俊凯-AI产品经理-Offer决策」READY，Offer 首卡（候选人概览/项目匹配/待核实）到群。
4. **无 @ 群消息被 mention 门静默拦截**：`groups.<chat>.requireMention=false` 配置已写入但运行态对文本消息未生效（带 @ 正常）。**卡片按钮走 dispatchSyntheticCommand 不受影响**，建议赛后核查该配置语义。
5. **authorizeGroup 要求每群恰好 1 行 ACTIVE scope，但三个老群各 6 行**（每顾问一行）→ 这些群对所有人生效均失败。**系统性 bug，列赛后修复**；演示只用单测试群，不受影响。
6. **launch 新建群在 openclaw 重启后收到「还没绑定职位」绑定卡**（specs/015 intake 误判，scope 实际存在）：展示层干扰，赛后修。
7. **agent 接单后跳过「确认岗位」询问与紧接着的建群步骤**（playbook 未注入所致；注入已开启，待观察）：演示时私聊接单后需补一句「把群建起来」。
8. ECS 到 GitHub 网络偶发不通：git pull 首次超时，重试成功。部署如遇此情况直接重试。

## 三、演示脚本（评审日）

**主群**：智子芯元（深圳）科技有限责任公司-AI产品经理（JNOEILO，mia 建，scope 已含 mia）。
备用群：韬润半导体-业务助理（JPTLM25，scope 已含 york + mia）。

1. **一键接单**：工作台打开职位详情 → 点「一键接单」→ 10 秒内飞书群拉起 + 职位卡（或群里 @机器人「我要接这个职位」→ 自动接单建群）。
2. **找人**：群内点「OpenMai 找人」（或接单自动触发）→ 3-5 分钟候选人总览卡回群。
3. **三按钮**：总览卡点「重点关注」→ 群内出现三按钮候选人卡 → 点「初筛通过」（自动推标准人才卡）→ 点「一键加入人才库」（真实写入 RDS，回执带人才库编号，灰测已产出 #395-#397）。**群内操作一律用按钮**——自然语言「把第 N 个候选人…」当前会被模型误判为未绑定（见第二节第 0 条）；自然语言只在私聊用明确公司/职位名（接单建群已验证）。
4. **SuperMai 通道**：群内点「SuperMai 找人」→ 服务端公域搜索回群（已实测）。**不演示本地 GUI 猎聘抓取**（cookie 30 分钟、风控需本人现场，赛后处理）。
5. **工作台联动**：详情页核心匹配要点 + 快捷跳转、OpenMai 顿号切分补充职位信息、画像编辑。

**纪律**：全程只用主群/备用群；按钮由 mia 或 york 操作（评委点击会因未绑定身份失败——如需评委互动，先将其 open_id 加入 scope）；固定输入框提交条件，不自然语言闲聊触发工具；每轮搜索为付费任务，演示前预置好候选人结果，现场尽量不新起搜索。

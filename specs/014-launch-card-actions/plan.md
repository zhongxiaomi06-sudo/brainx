# 014 — 实施计划

## 阶段一改动清单

| 文件 | 改动 |
|---|---|
| src/agent-gateway/tool-registry.js | `brainx_accept_job`：`p2pOnly: true` → `groupRequiresProject: true`（仅此一个工具放开） |
| src/project-launch.js | `GROUP_PURPOSES` 增 `job_action`；`buildProjectLaunchCard(job, { state })` 按承接状态分岔：未接单→「接单」单按钮；已接单→OpenMai/Reloop/SuperMai 三按钮 + `criteria` 输入框 + 「按条件找人」；发卡处按 `currentState` 传状态 |
| migrations/0049_group_scope_job_action.sql | 存量 ACTIVE 群 scope 幂等追加 `job_action`（`json_insert` + `NOT EXISTS`，脏 JSON/非 ACTIVE 行跳过） |
| tests/project-launch-card.test.mjs | 新增：卡片分岔、指令兜底、群内接单放行、存量群拒绝、migration 幂等 |
| tests/project-launch.test.mjs | 断言更新为「未接单只给接单按钮」 |
| src/agent-gateway/tools-actions.js | 接单成功后按 `project_launches.chat_id` 补发 ACCEPTED 版卡片（best-effort，不回滚接单） |
| src/agent-gateway/tool-registry.js | `createProductionToolRegistry` 默认注入 `sendCardFn: sendInteractiveCard` |
| bin/brainx-agent-admin.mjs | `launch-redeliver --force true`：群已 READY 时强制重发（卡片结构/承接状态变了） |
| src/project-launch.js | READY 早返回加 force 判断；force 时发卡 uuid 带时间戳 |
| tests/framework.test.mjs | 迁移清单 50→51、列表补 0049 |

## 关键设计决策

1. **只放开接单，不放开其他写操作。** `brainx_start_candidate_search`、`brainx_record_job_progress`、`brainx_me_context` 等仍 `p2pOnly`。群内可写面收窄到「接单」这一个动作，其余仍需私聊/工作台。
2. **卡片表单通过受管兼容桥回传。** `input` 与 `form_submit` 组成飞书原生表单；安装器只给固定 `@openclaw/feishu@2026.7.1` 应用幂等窄补丁，把 `form_value.criteria` 追加为结构化 `[BRAINTEX_CARD_FORM]`。版本或源码形状变化即失败关闭，不启动第二条同应用 WebSocket。
3. **卡片不承诺结果。** 按钮指令只要求「现在直接调用 X 工具」，不写「自动推送/自动通知」。
4. **存量群靠 migration 0049 补齐**，不改 `grantGroupScope` 的默认 purposes，避免新建群的默认授权面变化。

## 部署同步（生产 47.110.93.137）

1. 代码经 SSH 直推 `deploy-tmp` → `merge --ff-only`。
2. 重启 brainx-agent-gateway（注册表）+ brainx + brainx-worker；openclaw-brainx 无需重启（本阶段未改插件）。
3. 冒烟：
   - `SELECT allowed_purposes_json FROM agent_group_scopes WHERE chat_id='oc_baf49b…'` 应含 `job_action`。
   - 在 york 项目群内发「帮我接单」→ 应返回接单成功而不是 `NOT_FOUND_OR_FORBIDDEN`。
   - 补发卡片（未接单）应只出现「接单」按钮；接单后再补发应出现三个找人按钮 + 输入框。

## 风险

- 群内接单放开后，任何在 `allowed_senders` 里的项目成员都可在群内接单。缓解：仍需 `confirm: true`，且 job 必须属于该群 `project_refs`，跨群/跨职位调用被 `NOT_FOUND_OR_FORBIDDEN` 拒绝（已加回归测试）。
- migration 0049 对脏 JSON（`json_valid` 为假）的行静默跳过，这类群需人工用 `grantGroupScope` 重建 scope。
- 三服务同时启动跑迁移可能撞锁（已知坑），systemd 自愈。

## 阶段二（待飞书后台开启「对外共享」）

1. 默认建外部群：把职位登记的外部成员 open_id 加入 `user_id_list`；`232033` 自动回退内部群并记 `error_code`。
2. 外部联系人登记：外部用户与机器人单聊 → 记录 open_id + 姓名。
3. 机器人被拉进旧群：订阅 `im.chat.members:bot_access` → 入群即发「绑定职位」卡（可选已有职位或贴 JD），绑定后再发找人卡。

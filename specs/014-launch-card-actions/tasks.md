# 014 — 任务清单

## 阶段一

- [x] T1 `brainx_accept_job` 改 `groupRequiresProject: true`（解除 p2pOnly）
- [x] T2 `GROUP_PURPOSES` 增 `job_action`
- [x] T3 migration 0049：存量群 scope 幂等补齐 `job_action`
- [x] T4 `buildProjectLaunchCard` 按承接状态分岔（接单按钮 / 三找人按钮 + 群消息条件入口）
- [x] T5 发卡处按 `currentState` 传状态
- [x] T6 接单成功后自动补发找人卡（tools-actions + registry 默认注入发卡通道）
- [x] T7 `launch-redeliver --force`：群已 READY 也能按当前状态重发卡片
- [x] T8 测试：tests/project-launch-card.test.mjs 7 组；project-launch（force，12+1）/ framework 断言同步
- [x] T9 文档：spec/plan/tasks + docs/README.md + docs/AGENT_COMMIT_LOG.md
- [x] T10 npm run verify（full，24/24）+ commit + 生产部署 + 冒烟（群内接单 + 补发卡片）
- [x] T11 移除 OpenClaw 无法回传值的卡片输入框，保留已验证的 `找人条件：……` + 按钮直调链路

## 阶段二（待飞书后台开启对外共享）

- [ ] T9 默认建外部群 + `232033` 回退内部群
- [ ] T10 外部联系人 open_id 登记（单聊事件）
- [ ] T11 订阅 `im.chat.members:bot_access`：机器人进旧群自动发「绑定职位」卡
- [ ] T12 可选：在不新增第二条事件连接的前提下，让现有 OpenClaw 通道透传 `form_value`，再单独审核内联输入

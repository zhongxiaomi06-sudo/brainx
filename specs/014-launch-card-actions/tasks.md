# 014 — 任务清单

## 阶段一

- [x] T1 `brainx_accept_job` 改 `groupRequiresProject: true`（解除 p2pOnly）
- [x] T2 `GROUP_PURPOSES` 增 `job_action`
- [x] T3 migration 0049：存量群 scope 幂等补齐 `job_action`
- [x] T4 `buildProjectLaunchCard` 按承接状态分岔（接单按钮 / 三找人按钮 + 输入框）
- [x] T5 发卡处按 `currentState` 传状态
- [x] T6 测试：tests/project-launch-card.test.mjs 新增 5 组；project-launch / framework 断言同步
- [x] T7 文档：spec/plan/tasks + docs/README.md + docs/AGENT_COMMIT_LOG.md
- [ ] T8 npm run verify（full）+ commit + 生产部署 + 冒烟（群内接单 + 补发卡片）

## 阶段二（待飞书后台开启对外共享）

- [ ] T9 默认建外部群 + `232033` 回退内部群
- [ ] T10 外部联系人 open_id 登记（单聊事件）
- [ ] T11 订阅 `im.chat.members:bot_access`：机器人进旧群自动发「绑定职位」卡
- [ ] T12 自建长连接消费 `card.action.trigger` 的 `form_value`，让输入框真正生效

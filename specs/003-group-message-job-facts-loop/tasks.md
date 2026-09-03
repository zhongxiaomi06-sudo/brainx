# Tasks: 群消息到职位事实运行闭环

**Input**: `spec.md`、`plan.md`、`research.md`、`data-model.md`、`contracts/`

## Phase 1: Setup

- [x] T001 核对当前生产 commit、四服务、草稿/账本计数和网络监听并记录基线到 `specs/003-group-message-job-facts-loop/quickstart.md`
- [x] T002 将六名在职顾问、Otto 离职撤权和三层身份边界写入 `specs/003-group-message-job-facts-loop/spec.md`

## Phase 2: Foundational

- [x] T003 [P] 为本人草稿列表、跨人拒绝、inactive 顾问拒绝和显式确认编写失败测试 `tests/agent-job-facts-tools.test.mjs`
- [x] T004 [P] 更新 OpenClaw 工具契约测试 `tests/openclaw-production-config.test.mjs` 与 `tests/openclaw-plugin.test.mjs`

## Phase 3: User Story 2 - 顾问查看并裁决草稿（P1）

**Independent Test**: 两名顾问只能列出和裁决各自在已登记群中的草稿；确认写一份事实，拒绝不写事实。

- [x] T005 [US2] 实现草稿可见性、列表和确认 handler `src/agent-gateway/tools-job-facts.js`
- [x] T006 [US2] 注册 `brainx_pending_job_facts` 与 `brainx_review_job_fact` `src/agent-gateway/tool-registry.js`
- [x] T007 [US2] 向 OpenClaw 暴露两个窄工具 `plugins/brainx-openclaw/runtime.js` 与 `deploy/openclaw/openclaw.production.json`
- [x] T008 [US2] 运行草稿工具、Gateway、OpenClaw 契约回归测试并修复失败 `tests/agent-job-facts-tools.test.mjs`

## Phase 4: User Story 4 - York 主体的六人灰度协作（P1）

**Independent Test**: 六名在职顾问均以真实 consultant 审计；Otto/未绑定身份拒绝；仅登记群可形成和审核草稿。

- [x] T009 [US4] 更新六人灰度与 York 三层身份运行说明 `docs/2026-09-03-openclaw-production-runbook.md`
- [ ] T010 [US4] 创建生产备份并记录当前 commit、SQLite、环境、systemd、nginx 回滚点 `/opt/brainx/backups/`
- [ ] T011 [US4] 将 Otto 设为 inactive 并撤销其残留绑定，保留历史审计 `/opt/brainx/data/brainx.db`
- [ ] T012 [US4] 将已核验首轮群登记到 `chat_contexts` 并验证未登记群默认拒绝 `/opt/brainx/data/brainx.db`
- [ ] T013 [US4] 部署已验证 release，重启 `brainx`、`brainx-worker`、`brainx-agent-gateway`、`openclaw-brainx` 并完成健康检查

## Phase 5: User Story 1/3 - 消息提炼与失败恢复（P1/P2）

**Independent Test**: 登记群消息 10 秒内形成一份草稿；重复消息不重复；失败可查。

- [ ] T014 [US1] 验证登记群消息、账本、原文和草稿四层计数连续增长且消息幂等 `/opt/brainx/data/brainx.db`
- [ ] T015 [US3] 验证 Worker/Gateway/OpenClaw 错误日志、处理游标和失败状态可发现 `/var/log/journal/`

## Phase 6: Production Hardening

- [ ] T016 将 BrainX/前端内部端口限制到回环或安全组，公网只保留必要端口 `deploy/openclaw/` 与 ECS 安全组
- [ ] T017 释放磁盘并确认根盘可用空间不少于 15%，不删除 SQLite、密钥或生产备份 `/opt/brainx/`
- [ ] T018 更新 `docs/AGENT_COMMIT_LOG.md`，运行 `npm run verify:quick`，提交后运行 `npm run verify`
- [ ] T019 执行六人真实飞书灰度验收并观察至少 24 小时 `specs/003-group-message-job-facts-loop/quickstart.md`

## Dependencies & Execution Order

- T003/T004 先失败，再执行 T005–T007；T008 全绿后才能部署。
- T010 必须早于 T011–T013；T013 成功后才能执行 T014/T015。
- T016/T017 必须在对外宣布灰度可用前完成。
- T019 由真实六名操作者参与，完成前状态只能是“灰度已启动”，不能称“灰度通过”。

## Implementation Strategy

最小可用范围为：两个草稿工具 + 六人在职身份 + 明确登记群 + 四服务健康。York 展示主题和 `braintex-prod` 技术账号改名在数据链路稳定后单独实施，不与本次紧急接通混为一个发布。

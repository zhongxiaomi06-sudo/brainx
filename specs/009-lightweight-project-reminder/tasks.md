# 009 — Tasks

- [x] T1 调研：群绑定（project_launches.chat_id）、目标/时间节点（commitment_actions + ACCEPTED event.goal）、活跃度（lark_messages/decision_events/job_outcomes/openmai_results/commitment_actions/project_launches）、发送（pushCard + sendInteractiveCard）、worker 挂载点
- [x] T2 spec.md（触发规则/卡片内容/幂等/边界）
- [x] T3 project-reminder.js：buildProjectReminderCard / collectProjectReminders / remindProjectsOnce / startProjectReminderWorker
- [x] T4 worker.js 挂载 + 开关
- [x] T5 tests/project-reminder.test.mjs（筛选 6 断言 + 卡片 4 断言 + 幂等/重试 2 断言）
- [x] T6 full 门禁（CODEBUDDY_SAFE_DELETE_ENABLED=0）+ push + 部署 + 冒烟

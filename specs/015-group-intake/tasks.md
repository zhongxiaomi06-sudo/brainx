# 015 — 任务清单

- [x] T1 migration 0050 bot_chat_intake + framework 迁移清单
- [x] T2 feishu-bot listBotChats（翻页）
- [x] T3 src/group-intake.js（轮询+首轮基线+绑定卡+指引卡+bindGroupToProject+listBindableJobs）
- [x] T4 worker.js 挂载（BRAINX_GROUP_INTAKE_OFF 关闭）
- [x] T5 authorization allowIntakeBinding 分支 + authorizeIntakeBinding
- [x] T6 tool-registry brainx_bind_group_project + requiresIntakeBinding + server 透传
- [x] T7 tools-actions bindGroupProject handler（list/bind 两态）
- [x] T8 openclaw 插件 runtime.js/plugin.json/package.json/prompt.js 同步（1.4.0）
- [x] T9 deploy/openclaw/openclaw.production.json tools.allow + 契约 fixture
- [x] T10 测试 tests/group-intake.test.mjs 9 组 + 受影响断言同步（663/663）
- [x] T11 文档 spec/plan/tasks + docs/README + AGENT_COMMIT_LOG
- [ ] T12 npm run verify（full）+ commit + 生产部署（含插件副本同步）+ 冒烟

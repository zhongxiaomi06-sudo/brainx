# 009 — Plan

## 改动文件

1. `specs/009-lightweight-project-reminder/spec.md` — 决议与边界
2. `specs/009-lightweight-project-reminder/plan.md` — 本文件
3. `specs/009-lightweight-project-reminder/tasks.md` — 任务清单
4. `src/project-reminder.js`（新建）— 纯函数卡片 + 候选筛选 + 扫描 worker
5. `src/worker.js` — 挂载 startProjectReminderWorker（BRAINX_PROJECT_REMINDER_OFF=1 可关）
6. `tests/project-reminder.test.mjs`（新建）— 行为单测

## 复用（不改）

- `push.js#pushCard`（幂等落 push_log；kind='PROJECT_REMINDER'）
- `feishu-bot.js#sendInteractiveCard`（chat_id 目标 + uuid 幂等）
- `commitment.js` 的 goal/active_action 查询逻辑（本模块内联同源 SQL，避免循环依赖）

## 验证

- `node --test tests/project-reminder.test.mjs`
- `npm run verify`（宿主机带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`）
- 部署后生产冒烟：send=false 预览候选集 + 人工核对一张卡

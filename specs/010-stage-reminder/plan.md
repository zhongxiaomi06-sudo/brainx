# 010 — 实施计划

## 模块

- `src/stage-reminder.js`（新，<200 行）：全部纯函数 + worker 启动器，模式照抄 `src/project-reminder.js`。
  - `stageDayKey(at)`：CST 日键（run_id 组成部分）。
  - `isWorkdayCst(at)` / `cstMinutesCst(at)`：工作日与分钟数判定。
  - `inStageSendWindow(at, remindAt)`：CST 工作日 且 `remindAt ≤ now < 21:00`。
  - `collectStageReminders(db, at, { silenceHours })`：三阶段扫描，返回卡片上下文（含 phase、open_id、project_id、company/role、run_id）。
  - `buildStageReminderCard(ctx, { publicBaseUrl })`：三套固定文案（legacy v1 卡片，按钮 = URL 深链）。
  - `remindStagesOnce(db, { at, send, sendImpl, publicBaseUrl })`：一轮扫描（窗口外返回 closed）。
  - `startStageReminderWorker(db, deps)`：15 分钟一轮；`BRAINX_STAGE_REMINDER_OFF=1` 关。
- `src/worker.js`：挂载 `startStageReminderWorker`（与 009 并列）。

## 数据源（全部既有，无 migration）

- `current_engagement` 视图（0001_init.sql）：state/state_since。
- `openmai_results.project_id`（supermai 合成键也落这里）= 找人已启动。
- `job_outcomes.project_id` + `candidate_decision_groups.position_id`（0047）= 推进信号。
- `consultants.open_id / active / profile_json`：DM 目标与偏好开关（复用 `getPushPreferences`）。
- `push_log`：日键幂等。
- `lastProjectActivityAt`：从 project-reminder.js 导入复用（不复制）。

## 测试

`tests/stage-reminder.test.mjs`，夹具复用 009 测试模式（runSync 种子 felix + acceptCommitment + 回拨时间）：

1. 阶段 A：无 ACCEPTED → 候选；有 ACCEPTED → 不候选；偏好 enabled=false → 跳过。
2. 阶段 B：ACCEPTED + 无找人结果 + 接单超 24h → 候选；刚接单（<24h）→ 不候选。
3. 阶段 C：有找人结果 + 无 outcomes/建群 + 静默 24h → 候选；记录 outcome 后 → 不候选。
4. 时间门：周日不发；CST 12:30 前不发；21:00 后不发；CST 13:00 补发。
5. 幂等：同日重扫 SKIPPED_DUPLICATE 不重发；FAILED 下一轮重试成功。
6. 卡片：三阶段文案与深链按钮齐备。

## 部署

无插件改动 → 只需代码上生产 + 重启 brainx-worker（及 brainx 主服务保持同版本）。冒烟：生产 send=false 跑一轮看候选集。

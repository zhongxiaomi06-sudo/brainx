# 010 — 每日分阶段推进提醒（私聊提醒链）

状态：Implemented（2026-09-10）
上游：用户指令「加入一个提醒功能，每天定时提醒：没有接单的提醒今天想看什么岗位；接单没有找人推进的提醒现在想找人；找人之后没有推进的说要找新的人」。
已确认参数：默认 12:30 发（CST）；仅工作日；按项目逐条发（多个项目卡住各发一张）。

## 1. 定位与边界

- 与 specs/009（项目群静默 72h 群内唤醒）互补：009 管单项目的群内沉默，本规格管**顾问个人的每日推进节奏**，走**私聊 DM**。
- 纯信息卡：内容全部读 SQLite（零 LLM 成本）；操作路径 = 深链打开工作台 + 顾问私聊机器人对话（复用现有对话/record_job_progress/接单能力）。
- 只提醒不决策（BrainX 边界：AI 只提议人做决定）。

## 2. 三个阶段（判定全部读库）

| 阶段 | 判定（对每个活跃顾问） | 卡片 |
|---|---|---|
| A 没接单 | `current_engagement` 中该顾问**没有任何 ACCEPTED** 项目 | 「今天想看什么岗位吗？」→ 打开工作台按钮。每人每天最多 1 张 |
| B 接单未找人 | 项目 ACCEPTED 且 `openmai_results` 无该项目任何行（接单自动启动找人失败/未触发的兜底提醒） | 「现在想找人吗？」→ 打开职位按钮。按项目逐条 |
| C 找人未推进 | 项目 ACCEPTED 且 `openmai_results` 有行，但 `job_outcomes` 与 `candidate_decision_groups`（position_id=项目）均无行 | 「要找新的人吗？」→ 打开职位按钮。按项目逐条 |

防打扰阈值（两类都要求）：

- **静默**：项目最后操作时间（`lastProjectActivityAt`，复用 009 同源函数；A 阶段用 `current_engagement.state_since`）距今 > 24h（`BRAINX_STAGE_REMINDER_SILENCE_HOURS`）——刚接单/刚找人的项目当天不打扰。
- **偏好开关**：`consultants.profile_json.push_preferences.enabled === false` 的顾问全阶段跳过（复用推送偏好既有语义）。

## 3. 发送纪律

- **时间**：CST 工作日（周一至周五），到达 `BRAINX_STAGE_REMINDER_AT`（默认 12:30）后首个扫描周期发送（worker 每 15 分钟一轮，重启/停机恢复后在 12:30–21:00 窗口内补发，21:00 后不发）；幂等键保证每天每项目（或每人 A 阶段）最多一张。
- **幂等**：`push_log(kind='STAGE_REMINDER', run_id='stage:<A|B|C>:<project_id|->:<CST日键>')`，复用 pushCard 唯一键语义（SENT 跳过 / FAILED 下一轮重试）。
- **目标**：私聊 DM（`target=consultants.open_id`）；open_id 为空或顾问 inactive 跳过。
- **开关**：`BRAINX_STAGE_REMINDER_OFF=1` 总开关。
- 不新建表、无 migration、不改 openclaw 插件（worker 进程行为，不经过 agent 工具面）。

## 4. 不改

- specs/009 的群内提醒（独立扫描、独立冷却、互不感知——同一项目可能「群里 72h 卡 + 私聊每日卡」都收到，属预期：一个问方向、一个催节奏）。
- 现有 scheduler（07/19 推送）与 openmai-delivery。

## 5. 验收

- 单测：三阶段筛选（含静默阈值/无接单判定/找人存在判定/推进信号判定）、工作日与时间门（周末不发、12:30 前不发、21:00 后不发）、日键幂等（同日重扫不重发）、发送失败重试、偏好关闭跳过、卡片含深链按钮。
- `npm run verify` full 门禁；生产冒烟 send=false 预览候选集。

# 009 — 项目轻量提醒（群内静默唤醒）

状态：Implemented（2026-09-10）
上游：用户指令「c方案完成——项目轻量提醒功能：群内连续无操作时自动弹出卡片，询问项目是否继续、后续推人目标与对应时间节点，实现轻量目标管理。……读取上下文的信息，确定读取目标之后可以读取上下文，不准的时候顾问自己查找修正」。

## 1. 定位与边界

- 是 C 方案（任务完成主动通知缺失）的产品化落地：与其在每条找人任务结束时接通知，不如按项目粒度做「静默唤醒」——项目群连续无操作 N 小时后，机器人主动在群里发一张轻量提醒卡。
- 卡片是**纯信息卡**（本地收不到飞书回调，硬约束沿用 push.js 注释）：内容从 SQLite 上下文读取（目标、时间节点、最近进展），修正路径 = 顾问直接在群里回复（openclaw 机器人已有对话与 brainx_record_job_progress 能力），不做卡片按钮回写、不做编辑器。
- 只提醒，不自动做任何决策（BrainX 边界：AI 只提议人做决定）。

## 2. 触发规则

扫描进程：brainx-worker（`startProjectReminderWorker`，默认 30 分钟一轮；`BRAINX_PROJECT_REMINDER_INTERVAL_MS` 可调，`BRAINX_PROJECT_REMINDER_OFF=1` 关闭）。

一个 (project_id, consultant_id) 被选中必须同时满足：

| 条件 | 判定 | 默认值 |
|---|---|---|
| 有就绪项目群 | `project_launches.status='READY' AND chat_id IS NOT NULL` | — |
| 承接进行中 | `current_engagement` 状态为 ACCEPTED（COMPLETED/RELEASED 不打扰） | — |
| 群内静默 | 最后操作时间距今 > 阈值；最后操作 = MAX(lark_messages.received_at[chat_id], decision_events.occurred_at, job_outcomes.observed_at, openmai_results.started_at/finished_at, commitment_actions.created_at/updated_at, project_launches.updated_at) | 72h（`BRAINX_PROJECT_REMINDER_SILENCE_HOURS`） |
| 发送冷却 | push_log 无同项目 7 天内的 PROJECT_REMINDER 成功记录（run_id=`proj:<project_id>:<CST周键>` 幂等键） | 7d |
| 发送窗口 | 09:00–21:00 CST 之外只跳过不补发（避免深夜打扰；窗口外重启不补发，同 scheduler 纪律） | — |

## 3. 卡片内容（全部读上下文，零 LLM 成本）

- 职位：job_facts 的 company / role；项目群名 chat_name
- 静默时长：x 天（自最后操作时间起算）
- 本轮目标：`latestAcceptedGoal` 同源（ACCEPTED event payload.goal，缺省回退 commitment_actions.goal）
- 时间节点：当前行动 `commitment_actions`（OPEN/BLOCKED 最新一条）的 title + due_at；无当前行动时提示「没有进行中的行动，回复可建立下一步」
- 修正引导：固定文案「目标或时间节点不准？直接在群里回复修正（例：目标改为…；时间改为…），我会更新记录；暂不推进请回复暂停」

## 4. 发送与幂等

- 复用 `sendInteractiveCard({ target: chat_id, card, idempotencyKey })`（feishu-bot.js，uuid 幂等）。
- 审计与冷却落 `push_log`（consultant_id=launch.consultant_id, kind='PROJECT_REMINDER', run_id 周键, target=chat_id）——复用 pushCard 幂等语义；发送失败标记 FAILED 可重试，下一轮扫描重发。
- 不新建表、无 migration。

## 5. 不改

- openclaw 插件/工具注册表（提醒是 worker 进程行为，不经过 agent 工具面）。
- 现有 scheduler（07/19 点私聊推送）与 openmai-delivery（找人结果投递）互不干扰。

## 6. 验收

- 单测：候选筛选（静默阈值/状态过滤/冷却/窗口）、卡片含目标+时间节点+修正引导、push_log 幂等（重复扫描不重发）、发送失败下一轮可重试。
- `npm run verify` full 门禁；生产冒烟用 send=false 预览候选集。

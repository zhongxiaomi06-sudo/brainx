# Brain X 每日健康简报 · 2026-09-01

> 只读巡检 · 不修改数据 · 不重启服务<br>
> 检查窗口：2026-09-01 09:02 CST (01:02 UTC)<br>
> 数据库：`/Users/ashley/Downloads/brainx/data/brainx.db` (1.41 GB, mtime Aug 30 23:00 本地, user_version=23)

## 一、严重项（醒目）⚠️

| # | 严重项 | 状态 | 持续时间 |
|---|---|---|---|
| 1 | **同步连续中断** — 7 位 active 顾问最近一次 sync_runs 全部冻结在 `2026-08-21T08:36Z`，近 24h 0 条新增 sync/decision | 未修复 | **11 天** |
| 2 | **远端后端下线** — `http://47.110.93.137:3100/api/v1/oauth/status` 返回 HTTP 000 (connection refused, 41ms 即拒连) | 未修复 | 自 08-24 起持续 |
| 3 | **推送调度停摆** — push_log 最新一条 `2026-08-25T11:30Z`，状态 FAILED；近 14 天共 66 条推送全部 FAILED，**0 条 OK**；今日 07:00 CST 窗口未触发任何推送 | 未修复 | 7 天无任何推送尝试 |
| 4 | **桥接器/worker 静默** — `launchd.out.log` mtime Aug 31 03:50，今日（09-01）0 行写入；尽管本地 API 进程仍在响应，但 worker 推送链路自 08-25 起再无成功记录 | 未修复 | 自 08-25 起 |

> 错误根因（来自 err.log 最近 200 行去重）：6 次 `accounts.feishu.cn no such host`（DNS 解析失败）+ 1 次 `EADDRINUSE 0.0.0.0:4321`（前端端口冲突，已自愈）。

## 二、数据进度（vs 08-31 简报）

| 表 | 行数 | 08-31 | 增量 | 备注 |
|---|---:|---:|---:|---|
| consultants | 7 | 7 | 0 | active=1 全部 7 位 |
| job_facts | 984 | 984 | 0 | |
| sync_runs | 922 | 922 | 0 | **无新增** |
| decision_runs | 680 | 680 | 0 | **无新增** |
| recommendations | 612,595 | 612,595 | 0 | |
| decision_events | 48 | 48 | 0 | |
| job_outcomes | 2 | 2 | 0 | **仅 2 行**（异常稀少） |
| current_engagement | 17 | 17 | 0 | |

**数据进度结论**：本仓库业务数据完全冻结，与 08-31 简报逐项一致，0 行新增。DB 文件 mtime 停在 Aug 30 23:00 本地（与 0022 迁移应用时间存在时间倒挂，详见 §五）。

### 各 active 顾问最近一次 sync + decision（全部 7 位冻结在同一点）

| 顾问 | last sync (source/complete) | last sync 时间 | last decision created_at | candidate_count | status |
|---|---|---|---|---:|---|
| Felix 黄鑫 | ttc / 1 | 2026-08-21T08:36:33.477Z | 2026-08-21T14:05:53.120Z | 984 | COMPLETED |
| Linda 崔馨月 | ttc / 1 | 2026-08-21T08:36:33.519Z | 2026-08-21T14:05:53.455Z | 984 | COMPLETED |
| Mia 钟笑咪 | ttc / 1 | 2026-08-21T08:36:33.556Z | 2026-08-21T14:05:53.748Z | 984 | COMPLETED |
| Otto 石珅 | ttc / 1 | 2026-08-21T08:36:33.590Z | 2026-08-21T14:05:54.009Z | 984 | COMPLETED |
| Shanon 申莎娜 | ttc / 1 | 2026-08-21T08:36:33.632Z | 2026-08-21T14:05:54.233Z | 984 | COMPLETED |
| Wendy 郭雯 | ttc / 1 | 2026-08-21T08:36:33.663Z | 2026-08-21T14:05:54.480Z | 984 | COMPLETED |
| York 姚堃 | ttc / 1 | 2026-08-21T08:36:33.700Z | 2026-08-21T14:05:54.720Z | 984 | COMPLETED |

7 位顾问同步均冻结在 `08-21T08:36Z`，且全部 `complete=1 / errors=[]`（即最后一次成功，之后再无新跑）。近 24h 0 条新增 sync_runs、0 条 complete=0 / errors 非空记录。

## 三、同步状态 / 错误项

- **近 24h sync_runs**：0 条新增；其中 complete=0 或 errors 非空：**0 条**（因根本无新增）。
- **push_log 近 14 天**：66 条，全部 FAILED；error 字段统一为 `Command failed: lark-cli api POST /open-apis/im/v1/messages ...`，根因上游 `accounts.feishu.cn no such host`（DNS）。
- **err.log**：18,558 行，最后写入 `Aug 25 21:32`（6 天静默，无新报错）；最近 200 行去重后唯一活跃错误为 feishu DNS 失败 6 次 + 4321 EADDRINUSE 1 次。
- **out.log**：50,658 bytes，mtime `Aug 31 03:50`，今日 0 行写入，0 次"桥接器已启动"（即无异常重启，但亦无任何活动）。
- **schema_migrations**：8 条最近迁移，最新 `0022_opportunity_ignores.sql` applied_at `2026-08-31T07:26:12Z`（见 §五，已登记但 DB mtime 未随之推进，存在时间倒挂）。

## 四、待办积压（need_action = 14 项）

current_engagement 状态分布：**VIEWED 10 / ACCEPTED 5 / RELEASED 2**（共 17 行）。注：表无 WATCHED 状态，实际为 VIEWED/ACCEPTED/RELEASED。

### 4.1 VIEWED 超 7 天未推进（9 项）

| project_id | 顾问 | state_since | 滞留天数 |
|---|---|---|---:|
| P-FIX-3E7D2EC4 | felix | 2026-08-07T06:49Z | ~25 |
| P-FIX-1B64BD88 | felix | 2026-08-07T06:50Z | ~25 |
| P-FIX-435CC779 | felix | 2026-08-07T06:57Z | ~25 |
| P-FIX-3D500104 | mia | 2026-08-07T09:22Z | ~25 |
| P-FIX-E5FC611B | mia | 2026-08-07T10:36Z | ~25 |
| P-FIX-F859E105 | mia | 2026-08-10T06:05Z | ~22 |
| P-FIX-1B64BD88 | york | 2026-08-10T07:47Z | ~22 |
| P-FIX-EE9FF97D | mia | 2026-08-19T08:34Z | ~13 |
| JOWCGUD | mia | 2026-08-19T08:55Z | ~13 |

### 4.2 ACCEPTED 无 outcome（5 项，job_outcomes 全表仅 2 行）

| project_id | 顾问 | state_since | 滞留天数 |
|---|---|---|---:|
| P-FIX-E5FC611B | felix | 2026-08-07T07:32Z | ~25 |
| P-FIX-1B64BD88 | mia | 2026-08-19T08:46Z | ~13 |
| P-FIX-409FD700 | mia | 2026-08-19T08:54Z | ~13 |
| P-FIX-79F595CD | mia | 2026-08-19T08:54Z | ~13 |
| JFRX2JS | mia | 2026-08-19T08:54Z | ~13 |

**注**：08-28 新进入 VIEWED 的 `JPEYHMS` (felix) 与 `JOWCGUD` (mia) 中，仅 `JOWCGUD` 满 7 天（13 天），`JPEYHMS` 仅 4 天，未计入 need_action。

## 五、服务存活

| 检查项 | 结果 | 备注 |
|---|---|---|
| 本地 `127.0.0.1:3100/api/v1/oauth/status` | **HTTP 200**, 1.07s | LISTEN by PID 70207 (node)，与 08-31 同一 PID（持续运行） |
| 远端 `47.110.93.137:3100/api/v1/oauth/status` | **HTTP 000**, 41ms | `Couldn't connect to server`，端口拒绝连接；与 08-24/08-26/08-31 一致仍下线 |
| 端口 4321 (前端) | LISTEN by PID 70221 (node) | 同一 PID 自 08-31 持续运行 |
| 端口 4322 | 无监听 | 与历次一致 |
| err.log | 末次 Aug 25 21:32 | 6 天静默；feishu DNS 错误无新增（亦无活动） |
| out.log | 末次 Aug 31 03:50 | 今日 0 行；0 次"桥接器已启动"重启；worker 写入也停止 |

### 5.1 本日唯一正向变化

- **`0022_opportunity_ignores.sql` 已登记 `schema_migrations`**：applied_at `2026-08-31T07:26:12Z`。<br>
  08-31 简报当时判定其"文件存在但未登记 → 未执行"；今日复核显示已登记。<br>
  ⚠️ **异常**：迁移登记时间戳为 08-31T07:26Z，但 DB 文件 mtime 停在 Aug 30 23:00 本地（约 08-30T15:00Z），即"迁移登记时间 > 文件 mtime"，时间倒挂。可能原因：①外部备份/同步操作回写了 mtime；②迁移脚本登记的 `applied_at` 时间戳异常（系统时钟或时区问题）。**非阻断**，但建议下次执行迁移前先 `stat` 一次 DB mtime 与 schema_migrations 末行 applied_at 是否单调递增。

## 六、结论与下一步建议（不执行，仅建议）

| 优先级 | 建议 | 期望效果 |
|---|---|---|
| P0 | 优先恢复远端 ECS `47.110.93.137:3100`（自 08-24 起持续下线） | 解锁远端 OAuth + 真实触达链路 |
| P0 | 修复本机对 `accounts.feishu.cn` 的 DNS 解析（建议 `dig accounts.feishu.cn` + 检查 `/etc/resolv.conf` 或 VPN/分流规则） | 解锁飞书令牌刷新 → push 不再全 FAILED |
| P0 | 重启/排查 launchd worker（PID 与 08-31 同，但今日 0 行 out.log），确认 cron 是否仍登记 07:00/19:00 窗口并实际触发 | 恢复每日定时推送 |
| P1 | 恢复 sync 链路：当前 7 顾问均停在 08-21T08:36Z，需手动触发一次 sync 验证连通 | 恢复数据更新 |
| P1 | 处理 14 项 need_action（9 VIEWED 陈旧 + 5 ACCEPTED 无 outcome），其中 5 项 ACCEPTED 已积压 13–25 天 | 清理待办积压 |
| P2 | 复核 0022 迁移 mtime 倒挂 | 排除潜在迁移一致性隐患 |

## 七、巡检边界确认

- 全程使用 `mode=ro` URI 只读打开 SQLite；未触发任何写入。
- 未执行任何 `kill`、`launchctl`、`rm`、`mv` 等修改性命令。
- 未重启任何服务。

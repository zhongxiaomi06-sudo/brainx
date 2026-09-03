# Brain X 每日数据进度与健康简报 · 2026-08-31 09:02 CST

> 自动化任务 `automation-1786957156647` 第 4 次运行。**只读检查，未修改任何数据，未重启任何服务。**
> 对照基线：2026-08-24 / 2026-08-26 两次简报。

---

## 一、严重项（需立即关注）

| 级别 | 项 | 现状 | 持续天数 |
|---|---|---|---|
| 🔴 P0 | **同步连续中断** | sync_runs / decision_runs 全部冻结在 2026-08-21T08:36Z；近 24h 0 新增；7 位 active 顾问最近一次 sync 均为 08-21 | **10 天** |
| 🔴 P0 | **远端后端不可达** | `http://47.110.93.137:3100/api/v1/oauth/status` → HTTP 000（40ms 即连接被拒，端口未开放） | ≥7 天（08-24 起持续） |
| 🔴 P0 | **定时推送停摆** | push_log 最新 created_at = 2026-08-25T11:30Z；08-26 至 08-31 共 6 天 12 个推送窗口（07:00/19:00 CST）**0 条推送记录**，scheduler 不再触发 | **6 天** |
| 🟡 P1 | **need_action 积压** | 14 项待办（9 VIEWED 超 7 天 + 5 ACCEPTED 无 outcome），job_outcomes 仅 2 行 | 11–23 天 |

> 注：08-24 / 08-26 已分别报告前 3 项，**今日仍未修复，问题持续累积**。

---

## 二、数据进度（vs 08-26）

| 表 | 08-26 | 08-31 | Δ | 说明 |
|---|---|---|---|---|
| consultants | 7 | 7 | 0 | 全部 active=1（felix/linda/mia/otto/shanon/wendy/york） |
| job_facts | 984 | 984 | 0 | 业务数据 0 增长 |
| sync_runs | 922 | 922 | 0 | 自 08-21 起无新增 |
| decision_runs | 680 | 680 | 0 | 自 08-21 起无新增 |
| recommendations | 612,595 | 612,595 | 0 | 持平 |
| decision_events | 13,416 | **48** | **-13,368** | ⚠️ 见下「迁移说明」——非丢失，是 0020 迁移清理 `event_type='RECOMMENDED'` 机器事件，保留真实用户操作 |
| job_outcomes | 1 | 2 | **+1** | 08-28 新增 JPEYHMS/felix「推荐」stage（e2e 测试数据） |
| current_engagement | 0 | 17 | +17 | 08-26 后由迁移重建并稳定，state_since 时间戳为原始业务时间 |

**DB 文件**：`data/brainx.db` 1346.2 MB（mtime 08-30 23:00），WAL 45.5 MB（mtime 08-31 03:50，零星写入非业务数据）。

### 迁移说明（08-30 执行了一批）
- `0019_ttc_field_reports.sql` — 新建 TTC 字段覆盖率快照表（**0 行**，等待下次 sync）
- `0020_remove_recommendation_events.sql` — `DELETE FROM decision_events WHERE event_type='RECOMMENDED'`，清除机器推荐事件，保留 VIEWED/WATCHED/ACCEPTED/DISMISSED 等真实用户操作 → 这就是 decision_events 从 13416 降到 48 的原因，**属设计内清理，非数据丢失**
- `0021_impressions.sql` — 新建 `recommendation_impressions` 曝光埋点表（**0 行**）+ 给 recommendations 加 `(consultant_id, project_id)` 热路径索引
- `0022_opportunity_ignores.sql` — 文件已存在但 **schema_migrations 中未登记 → 尚未执行**；下次部署需补跑

---

## 三、各顾问最近一次 sync / decision（全部冻结在 08-21）

7 位 active 顾问的最近 sync_runs 与 decision_runs **完全相同**，均为 08-21T08:36Z 的同一批 133 次 sync + 08-21T14:05Z 的同一批 decision：

| 顾问 | last sync (source/complete/completed_at) | last decision (created_at/candidates) |
|---|---|---|
| felix | ttc / 1 / 2026-08-21T08:36:33.494Z | 2026-08-21T14:05:53Z / 984 |
| linda | ttc / 1 / 2026-08-21T08:36 | 2026-08-21T14:05 / 984 |
| mia | ttc / 1 / 2026-08-21T08:36 | 2026-08-21T14:05 / 984 |
| otto | ttc / 1 / 2026-08-21T08:36 | 2026-08-21T14:05 / 984 |
| shanon | ttc / 1 / 2026-08-21T08:36 | 2026-08-21T14:05 / 984 |
| wendy | ttc / 1 / 2026-08-21T08:36 | 2026-08-21T14:05 / 984 |
| york | ttc / 1 / 2026-08-21T08:36 | 2026-08-21T14:05 / 984 |

近 24h sync_runs：**total=0，complete=0 的 0 条，errors 非空的 0 条**（因为根本没跑）。

---

## 四、current_engagement 状态分布与 need_action（17 条 → 14 项待办）

| 状态 | 数量 |
|---|---|
| VIEWED | 10 |
| ACCEPTED | 5 |
| RELEASED | 2 |

### need_action 明细（14 项）

**A. VIEWED 超 7 天未推进（9 项）**

| project_id | 顾问 | state_since | 积压天数 |
|---|---|---|---|
| P-FIX-3E7D2EC4 | felix | 2026-08-07T06:49 | 23d |
| P-FIX-1B64BD88 | felix | 2026-08-07T06:50 | 23d |
| P-FIX-435CC779 | felix | 2026-08-07T06:57 | 23d |
| P-FIX-3D500104 | mia | 2026-08-07T09:22 | 23d |
| P-FIX-E5FC611B | mia | 2026-08-07T10:36 | 23d |
| P-FIX-F859E105 | mia | 2026-08-10T06:05 | 20d |
| P-FIX-1B64BD88 | york | 2026-08-10T07:47 | 20d |
| P-FIX-EE9FF97D | mia | 2026-08-19T08:34 | 11d |
| JOWCGUD | mia | 2026-08-19T08:55 | 11d |

**B. ACCEPTED 无 outcome（5 项）**

| project_id | 顾问 | state_since | 积压天数 |
|---|---|---|---|
| P-FIX-E5FC611B | felix | 2026-08-07T07:32 | 23d |
| P-FIX-1B64BD88 | mia | 2026-08-19T08:46 | 11d |
| P-FIX-409FD700 | mia | 2026-08-19T08:54 | 11d |
| P-FIX-79F595CD | mia | 2026-08-19T08:54 | 11d |
| JFRX2JS | mia | 2026-08-19T08:54 | 11d |

> job_outcomes 仅 2 行（JDWIAC3/felix 面试 08-21；JPEYHMS/felix 推荐 08-28）。**5 个 ACCEPTED 状态无一进入面试/录用阶段**，链路断裂。

---

## 五、服务存活

| 端点 | 结果 |
|---|---|
| `http://127.0.0.1:3100/api/v1/oauth/status` | ✅ HTTP 200，1.40s |
| `http://47.110.93.137:3100/api/v1/oauth/status` | 🔴 HTTP 000，连接被拒（40ms） |

本地进程：`com.brainx.web` launchctl PID 70207 状态 0（运行中），监听 127.0.0.1:3100；vinext PID 70221 监听 *:4321；**4322 端口无监听**（与 08-26 一致）。

---

## 六、错误项与重启

### launchd.err.log（mtime 2026-08-25 21:32）
- **自 08-25 21:32 起无新报错（4 天静默）**。尾部残留的历史报错：
  - `EADDRINUSE: address already in use 0.0.0.0:4321`（前端端口冲突，已自愈）
  - `accounts.feishu.cn no such host`（飞书 DNS 解析失败，导致 lark-cli 推送全部 FAILED）
- 08-26/08-27/08-28/08-29/08-30/08-31：err.log 未再增长。

### launchd.out.log（mtime 2026-08-31 03:50）
- 「桥接器已启动」历史累计 **27 次**；最近一次带日期的输出停在 `2026-08-24#0700`（6 位顾问全部 FAILED）。
- **今日（08-31）0 次异常重启**；out.log 末尾为 vinext 正常启动序列 + `[worker] 定时推送已启动（07:00 / 19:00 CST）` 横幅。文件今日有写入（mtime 03:50）但内容为正常运行输出，非崩溃重启。
- 注：out.log 行内无日期前缀，无法逐行精确计时；以 mtime + 内容推断今日桥接器持续运行。

### push_log（共 68 条）
- 状态分布：**FAILED 66 / SENT 1 / PREVIEW 1**
- 最新一批：`2026-08-25#1900` 6 条全 FAILED，错误均为 `lark-cli api POST /open-apis/im/v1/messages` 调用失败（与 feishu DNS 报错同源）。
- **08-26 至 08-31 共 6 天 12 个推送窗口，push_log 0 条新增** → scheduler 已不再触发推送（不只是推送失败，是根本没跑）。

---

## 七、结论与下一步建议

### 当前状态
- 本地后端 + 前端存活，DB 文件健康，schema 已升级到 0021；远端 ECS 后端仍下线。
- **业务数据流水线完全冻结 10 天**：sync → decision → recommendation → push 全链路自 08-21 起未再产出新数据。
- 待办积压从 08-24 的 13 项增至 **14 项**，最久积压 23 天。
- 迁移侧有进展（08-30 跑了 0019/0020/0021），但 0022 未执行；新表 `recommendation_impressions` / `ttc_field_reports` 已建但 0 行，等待 sync 恢复后填充。

### 建议优先级
1. **P0 恢复 sync 链路**：排查 08-21 之后 sync_runs 不再触发的根因——是 launchd 调度停了、bridge 健康检查失败了，还是 TTC 数据源 token 失效。建议先查 `bin/` 下调度脚本与 `bridge_cursor` 表状态。
2. **P0 恢复远端 ECS**：47.110.93.137:3100 端口未开放，需登服务器查 `brainx` Docker 容器 / systemd brainx.service 状态。
3. **P0 恢复定时推送**：push_log 自 08-25 起无新增，说明 scheduler 不仅推送失败而是不再触发；先确认 `[worker] 定时推送已启动` 横幅后是否真的进入了 07:00/19:00 窗口。
4. **P1 补跑 0022 迁移**：`opportunity_ignores` 表尚未创建，影响「忽略」功能。
5. **P1 清理 need_action**：14 项积压中 9 项 VIEWED 超 7 天，建议人工介入推进或释放。

---

*生成时间：2026-08-31 09:02 CST · 自动化 ID：automation-1786957156647 · 只读检查，无副作用*

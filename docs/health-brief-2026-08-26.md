# Brain X 每日健康简报 · 2026-08-26 09:01

> 只读检查 · 未修改任何数据 / 未重启服务

## 一、严重项（需立即关注）

| 级别 | 项目 | 现状 |
|---|---|---|
| 🔴 严重 | **同步连续中断 5 天** | sync_runs 自 08-21T08:36Z 起完全停滞，近 24h 新增 **0** 条；decision_runs / decision_events 同步冻结在 08-21T14:05Z |
| 🔴 严重 | **远端后端下线** | `47.110.93.137:3100/api/v1/oauth/status` → HTTP **000**（连接被拒，39ms 即失败），与 08-24 一致，ECS 未恢复 |
| 🟠 警告 | **令牌/网络失效迹象** | scheduler 定时推送全日志 **714 条全部 FAILED**（07:00/19:00 持续失败）；`accounts.feishu.cn` DNS 报错全文 21 次，**近 100 行 err.log 中仍有 3 次**，零星未止 |
| 🟠 警告 | **本地后端响应过慢** | `127.0.0.1:3100` 返回 200 但耗时 **6.55s**（oauth/status 应为毫秒级，疑似阻塞或资源紧张） |

## 二、数据进度（较昨日增量）

| 表 | 当前行数 | 较 08-24 增量 | 备注 |
|---|---|---|---|
| consultants | 7 | 0 | active=7 |
| job_facts | 984 | 0 | 候选职位池 |
| sync_runs | 922 | 0 | 最近一条 08-21T08:36Z |
| decision_runs | 680 | 0 | 最近一条 08-21T14:05Z |
| recommendations | 612,595 | 0 | 推荐结果池 |
| decision_events | 13,416 | 0 | 最近 occurred 08-21T14:05Z |
| job_outcomes | 1 | 0 | 几乎全空 |
| current_engagement | 16 | 0→16 | 08-24 时该表不存在，本次为迁移重建（非新业务数据） |

**结论：业务数据零增长。** DB 最后写入时间 08-25 16:27（昨日迁移），今日无写入。current_engagement 由 0→16 属 schema 迁移产物，不代表新增量。

### 各 active 顾问最近一次同步/决策（7 位一致）

全部 7 位（Felix/Linda/Mia/Otto/Shanon/Wendy/York）：
- 最近 sync：`08-21T08:36Z`，source=ttc，complete=1，errors=`[]`
- 最近 decision：`08-21T14:05Z`，candidate_count=984，status=COMPLETED

## 三、同步状态

- 近 24h **无** `complete=0` 或 `errors` 非空的 sync_runs —— 原因是根本没有新 sync_runs 产生（同步 daemon 未运行或未触发）。
- 全部最近 sync 的 errors 均为 `[]`（上次成功同步本身无错），问题在"不再同步"而非"同步出错"。
- feishu DNS 报错（`accounts.feishu.cn no such host`）较 08-24（43 次）降至 21 次，但近 100 行 err.log 仍有 3 次，未根除。

## 四、待办积压（need_action · 共 12 项）

> 注：current_engagement 实际状态为 VIEWED / ACCEPTED / RELEASED，**无 WATCHED 状态**；"未推进"以 VIEWED 计。

状态分布：VIEWED 9 / ACCEPTED 5 / RELEASED 2（共 16）。

### A. VIEWED 超 7 天未推进（7 项，积压 15–18 天）

| 顾问 | project_id | 停滞天数 |
|---|---|---|
| Felix 黄鑫 | P-FIX-3E7D2EC4 | 18 |
| Felix 黄鑫 | P-FIX-1B64BD88 | 18 |
| Felix 黄鑫 | P-FIX-435CC779 | 18 |
| Mia 钟笑咪 | P-FIX-3D500104 | 18 |
| Mia 钟笑咪 | P-FIX-E5FC611B | 18 |
| Mia 钟笑咪 | P-FIX-F859E105 | 15 |
| York 姚堃 | P-FIX-1B64BD88 | 15 |

### B. ACCEPTED 但无 outcome（5 项）

| 顾问 | project_id | 接受时间 |
|---|---|---|
| Felix 黄鑫 | P-FIX-E5FC611B | 08-07 |
| Mia 钟笑咪 | P-FIX-1B64BD88 | 08-19 |
| Mia 钟笑咪 | P-FIX-409FD700 | 08-19 |
| Mia 钟笑咪 | P-FIX-79F595CD | 08-19 |
| Mia 钟笑咪 | JFRX2JS | 08-19 |

job_outcomes 表仅 1 行，5 个 ACCEPTED 均无对应结局记录。

## 五、错误项

- **err.log 末尾**：`EADDRINUSE 0.0.0.0:4321` → `[frontend] 已退出 code=7`（08-25 ~21:32）。
  - **已自愈**：前端于今日 ~00:11 重启，vinext（PID 36581）监听 4321，已稳定运行 8h50m。
- feishu DNS 报错零星持续（见第三节）。
- scheduler 推送 714 条全 FAILED。

## 六、服务存活

| 目标 | 结果 |
|---|---|
| 本地 `127.0.0.1:3100/api/v1/oauth/status` | ✅ HTTP 200，`{"configured":true,"dev_auth":false}`（但 6.55s 偏慢） |
| 远端 `47.110.93.137:3100/api/v1/oauth/status` | 🔴 HTTP 000，连接被拒 |
| 端口 3100 监听 | ✅ PID 36525（src/server.js，运行 8h50m） |
| 端口 4321 监听 | ✅ PID 36581（vinext 前端，运行 8h50m） |
| 端口 4322 监听 | ⚠️ 无监听 |
| 今日异常重启 | out.log 今日 "桥接器已启动" 0 次（注：out.log 无日期戳行，grep-by-date 不可靠；以进程 uptime 推断后端/前端均于 00:11 启动并稳定至今，未见 crash-loop） |

## 七、建议下一步（仅诊断方向，未执行）

1. **恢复同步链路（最高优先）**：sync daemon 自 08-21 起未产生新 sync_runs，需确认 daemon 进程是否在运行、是否被令牌失效阻塞。先查 feishu 令牌有效性 + 本机 DNS 能否解析 `accounts.feishu.cn`。
2. **恢复远端 ECS**：47.110.93.137:3100 持续不可达，需登服务器查 brainx.service / Docker 容器状态。
3. **排查本地后端慢响应**：oauth/status 6.55s 异常，查 src/server.js 是否有阻塞调用或事件循环堆积。
4. **清理待办积压**：12 项 need_action 中 7 项已积压 15–18 天，需人工推进或建立超期回退机制。

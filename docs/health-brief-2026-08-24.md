# Brain X 每日数据进度与健康简报

**日期**：2026-08-24（周一）09:18 CST  
**检查方式**：只读（未修改任何数据、未重启服务）  
**DB**：`/Users/ashley/Downloads/brainx/data/brainx.db`（只读 mode=ro）

---

## ⚠️ 醒目告警（需立即处置）

| 级别 | 问题 | 说明 |
|---|---|---|
| 🔴 严重 | **数据同步自 08-21 起完全中断** | 全部 7 位顾问最近一次 sync_runs 停在 `2026-08-21T08:36:33Z`（CST 16:36），近 3 天无任何新 sync_runs / decision_runs / decision_events / recommendations。 |
| 🔴 严重 | **远端后端不可达** | `http://47.110.93.137:3100/api/v1/oauth/status` → HTTP 000（连接失败）。本地后端存活。 |
| 🔴 严重 | **令牌/DNS 故障持续** | err.log 中 `lookup accounts.feishu.cn: no such host` 共 **43 次**，从行 4746 贯穿至行 18521（近日志末尾，仍在发生）。08-23 07:00/19:00 与 08-24 07:00 定时推送全部 FAILED（6 顾问 ×3 窗口 = 18 次失败）。 |
| 🟠 警告 | **待办积压** | need_action 共 **13 项**：6 个 WATCHED 超 7 天未推进 + 7 个 ACCEPTED 无 outcome。 |
| 🟡 提示 | **push_log 唯一约束冲突** | 08-23#1900 出现 `UNIQUE constraint failed: push_log.consultant_id, push_log.kind, push_log.run_id`。 |

> 结论：本地后端进程存活（200），但**桥接同步链路已死、远端下线、飞书令牌刷新 DNS 全败**，数据自 08-21 起停滞。需排查 DNS/网络与飞书 token 刷新链路，并恢复远端服务。

---

## 1. 数据进度（各表行数）

| 表 | 行数 | 备注 |
|---|---:|---|
| consultants | 7 | 全部 active |
| job_facts | 984 | |
| sync_runs | 922 | |
| decision_runs | 680 | |
| recommendations | 612,595 | |
| decision_events | 13,416 | |
| job_outcomes | 1 | |
| current_engagement | **缺失** | 该表不存在；engagement 状态实际存于 `decision_events.next_state` 与 `cockpit_facts`（cockpit_facts 当前 0 行）。 |

### 日新增量（按 UTC 日期，最近 3 天）

| 日期(UTC) | sync_runs | decision_runs | decision_events | recommendations |
|---|---:|---:|---:|---:|
| 2026-08-24 | 0 | 0 | 0 | 0 |
| 2026-08-23 | 0 | 0 | 0 | 0 |
| 2026-08-22 | 0 | 0 | 0 | 0 |
| 2026-08-21 | 133 | 154 | 3,084 | 151,081 |
| 2026-08-20 | 308 | 245 | 4,900 | 234,101 |
| 2026-08-19 | 414 | 261 | 5,239 | 227,413 |

**较昨日新增量 = 0（实际近 3 天均为 0）**。数据自 08-21 傍晚起冻结；08-20→08-21 已呈明显下滑（sync 308→133、events 4900→3084），说明 08-21 当日同步链路已开始故障。

---

## 2. 同步状态

### 各 active 顾问最近一次 sync_runs（全部停在 08-21）

| 顾问 | source | complete | errors | completed_at(UTC) | rows_read/expected |
|---|---|---:|---|---|---|
| Felix 黄鑫 | ttc | 1 | [] | 2026-08-21T08:36:33.494Z | 898/902 |
| Linda 崔馨月 | ttc | 1 | [] | 2026-08-21T08:36:33.527Z | 898/902 |
| Mia 钟笑咪 | ttc | 1 | [] | 2026-08-21T08:36:33.564Z | 898/902 |
| Otto 石珅 | ttc | 1 | [] | 2026-08-21T08:36:33.598Z | 898/902 |
| Shanon 申莎娜 | ttc | 1 | [] | 2026-08-21T08:36:33.640Z | 898/902 |
| Wendy 郭雯 | ttc | 1 | [] | 2026-08-21T08:36:33.670Z | 898/902 |
| York 姚堃 | ttc | 1 | [] | 2026-08-21T08:36:33.708Z | 898/902 |

- 最近一次成功同步距今约 **2.9 天**。
- 各顾问最近一次 decision_runs（created_at 均为 `2026-08-21T14:05:5xZ`≈CST 22:05，candidate_count=984）。

### 最近 24h sync_runs 异常检查
- 过去 24h 内 **无任何 sync_runs 记录**（complete=0 或 errors 非空：0 条；总条数：0）。  
  原因：180s 桥接同步每 tick 均因 DNS 故障失败，未写入 sync_runs。

---

## 3. 待办 need_action（基于 decision_events.next_state）

状态分布：

| next_state | 计数 |
|---|---:|
| RECOMMENDED | 13,370 |
| VIEWED | 30 |
| WATCHED | 7 |
| ACCEPTED | 7 |
| RELEASED | 2 |

**need_action = 13 项**：
- 🔴 WATCHED 超 7 天未推进：**6 / 7**
- 🔴 ACCEPTED 无 outcome（job_outcomes 无对应记录）：**7 / 7**
- （job_outcomes 全表仅 1 行，且未关联到任何 ACCEPTED decision_id）

---

## 4. 服务存活

| 端点 | 状态 | 响应 |
|---|---|---|
| `http://127.0.0.1:3100/api/v1/oauth/status` | ✅ 存活 | 200，`{"configured":true,"dev_auth":false}`，18ms |
| `http://47.110.93.137:3100/api/v1/oauth/status` | 🔴 不可达 | HTTP 000（连接失败/超时） |

---

## 5. 日志检查

### launchd.err.log（18,537 行）
- 末尾 20 行为飞书 OAuth token 刷新失败 JSON：`accounts.feishu.cn: no such host`（网络/DNS）。  
- 全文 `no such host / lookup / dns` 命中 **43 次**，从行 4746 → 18521（近末尾），属持续故障。  
- 早期还出现过：`[frontend] 启动失败：spawn npm ENOENT`、`open_id cross app`（code 99992361）、`[feishu] refresh 异常 cid=mia：fetch failed`。

### launchd.out.log（1,081 行）
- `桥接器已启动（间隔 180s）` 全文共 **27 次**，均为启动横幅（非周期心跳）。今日（08-24，行 1075–1081）**0 次** → 今日无异常重启。  
- 最近一次启动横幅在行 684（对应 08-21#1900 推送窗口前后）。
- 末尾定时推送结果（近 3 天全部失败）：

```
[scheduler] 2026-08-23#0700 felix/mia/york/wendy/linda/shanon: FAILED
[scheduler] 2026-08-23#1900 felix/mia/york/wendy/linda/shanon: FAILED  (+ tick 异常: UNIQUE constraint failed push_log)
[scheduler] 2026-08-24#0700 felix/mia/york/wendy/linda/shanon: FAILED
```

> 注：otto 在 consultants 表为 active，但定时推送窗口对象为 6 人（不含 otto），推送对象为 felix/mia/york/wendy/linda/shanon。

---

## 6. 结论与建议（只读检查，未执行任何变更）

1. **首要**：排查本机 DNS / 网络出口——`accounts.feishu.cn` 无法解析导致飞书 token 刷新全败，进而桥接同步与定时推送全部失败。建议先 `nslookup accounts.feishu.cn` / 检查 DNS 配置与 VPN/代理。
2. 恢复后确认 sync_runs 重新增长、err.log 不再新增 `no such host`。
3. **远端后端** 47.110.93.137:3100 不可达，需确认 ECS 实例/安全组/进程状态。
4. 处理积压：13 项 need_action（6 WATCHED 超期 + 7 ACCEPTED 无 outcome）需人工推进或补录 job_outcomes。
5. 排查 08-23#1900 的 `push_log` 唯一约束冲突，避免重复推送幂等键。

_本简报由每日 09:00 自动化任务只读生成。_

# Brain X 每日数据进度与健康简报

> 生成时间：2026-08-23 08:50 (GMT+8)
> 检查方式：只读（未修改任何数据 / 未重启任何服务）
> 数据库：/Users/ashley/Downloads/brainx/data/brainx.db

---

## 🚨 关键告警（需立即处理）

| 级别 | 问题 | 影响 |
|------|------|------|
| 🔴 P0 | **远端后端下线** — `http://47.110.93.137:3100` 端口连接被拒 (curl 42ms 即失败) | 远端不可访问，线上服务疑似停机 |
| 🔴 P0 | **飞书推送 100% 失败** — 错误码 `99992361 "open_id cross app"`，今日 07:00 起持续报错至 07:29+ | 6 位顾问早间推送全部失败 (180 次重试全失败) |
| 🟠 P1 | **同步链路停滞 2 天** — 8/22、8/23 无任何 sync_runs 新增 | 数据供给中断，最近成功同步在 8/20 04:05 (york) |
| 🟠 P1 | **5 个 ACCEPTED 项目无 outcome**（含 1 个停滞 16 天） | 待办堆积，闭环缺失 |
| 🟡 P2 | **8 个 VIEWED 项目超 7 天未推进**（最长 16 天） | 推进漏斗堵塞 |

---

## 1. 数据进度（表行数总览）

| 表 | 行数 | 较昨日增量 |
|----|------|-----------|
| consultants | 7 | 0 |
| job_facts | 984 | 0 |
| sync_runs | 922 | 0 |
| decision_runs | 680 | 0 |
| recommendations | 612,595 | 0 |
| decision_events | 13,416 | 0 |
| job_outcomes | 1 | 0 |
| current_engagement | 16 | 0 |

**结论：今日（8/23）截至 08:50 数据零增长，与 8/22 一致，连续两日停滞。**

### 最近 7 天每日增量（确认停滞点）

| 日期 | sync_runs | decision_runs | recommendations |
|------|-----------|---------------|-----------------|
| 2026-08-17 | 1 | 1 | — |
| 2026-08-19 | 414 | 261 | 227,413 |
| 2026-08-20 | 308 | 245 | 234,101 |
| 2026-08-21 | 133 | 154 | 151,081 |
| 2026-08-22 | **0** | **0** | **0** |
| 2026-08-23 (今日) | **0** | **0** | **0** |

---

## 2. 同步状态（每位 active 顾问最近一次 sync_runs）

| 顾问 | source | complete | completed_at | rows(read/exp) | errors | 备注 |
|------|--------|----------|--------------|----------------|--------|------|
| Felix 黄鑫 | bridge | 1 | 2026-08-07 09:49 | 29/29 | [] | ⚠️ 16 天未同步 |
| Wendy 郭雯 | ttc | 1 | 2026-08-19 10:21 | 902/906 | [] | 4 天前 |
| Shanon 申莎娜 | ttc | 1 | 2026-08-19 15:15 | 902/906 | [] | 4 天前 |
| Mia 钟笑咪 | ttc | 1 | 2026-08-19 15:41 | 902/906 | [] | 4 天前 |
| Linda 崔馨月 | ttc | 1 | 2026-08-19 15:51 | 902/906 | [] | 4 天前 |
| Otto 石珅 | ttc | 1 | 2026-08-19 17:16 | 902/906 | [] | 4 天前 |
| York 姚堃 | ttc | 1 | 2026-08-20 04:05 | 901/905 | [] | 最近一次 |

- 最近 24h **无** complete=0 或 errors 非空的 sync_runs（即无失败记录，但也无任何启动）
- 所有最近 sync 的 errors 字段均为 `[]`，单次执行层面无错误

### 最近一次 decision_runs（活跃顾问）

| 顾问 | created_at | candidate_count | status | policy_version |
|------|-----------|-----------------|--------|----------------|
| Felix | 2026-08-07 06:44 | 55 | COMPLETED | baseline-1.0 |
| Linda | 2026-08-19 04:00 | 1,865 | COMPLETED | baseline-1.0 |
| Mia | 2026-08-19 13:06 | 923 | COMPLETED | baseline-1.0 |
| Otto | 2026-08-19 15:28 | 928 | COMPLETED | baseline-1.0 |
| Shanon | 2026-08-20 07:28 | 940 | COMPLETED | baseline-1.0 |
| Wendy | 2026-08-20 08:35 | 948 | COMPLETED | baseline-1.0 |
| York | 2026-08-20 17:29 | 973 | COMPLETED | baseline-1.0 |

---

## 3. 待办（need_action）

### current_engagement 状态分布

| state | 数量 |
|-------|------|
| VIEWED | 9 |
| ACCEPTED | 5 |
| RELEASED | 2 |
| **WATCHED** | **0**（系统实际状态名为 VIEWED） |

### 🔴 ACCEPTED 但无 outcome（5 个，需补 outcome）

| project_id | 顾问 | ACCEPTED 时间 | 停滞天数 |
|-----------|------|--------------|---------|
| P-FIX-E5FC611B | felix | 2026-08-07 07:32 | **16 天** |
| P-FIX-1B64BD88 | mia | 2026-08-19 08:46 | 4 天 |
| P-FIX-409FD700 | mia | 2026-08-19 08:54 | 4 天 |
| P-FIX-79F595CD | mia | 2026-08-19 08:54 | 4 天 |
| JFRX2JS | mia | 2026-08-19 08:54 | 4 天 |

### 🟡 VIEWED 超 7 天未推进（8 个）

- felix: P-FIX-3E7D2EC4 / P-FIX-1B64BD88 / P-FIX-435CC779（均 8/07，16 天）
- mia: P-FIX-3D500104 / P-FIX-E5FC611B（8/07，16 天）；P-FIX-F859E105（8/10，13 天）
- york: P-FIX-1B64BD88（8/10，13 天）

> job_outcomes 表仅 1 条记录，闭环数据严重不足。

---

## 4. 错误项

### launchd.err.log（今日 2026-08-23）

文件 18,217 行，今日新增大量飞书 API 错误块：

```json
{
  "ok": false,
  "identity": "bot",
  "error": {
    "type": "api",
    "code": 99992361,
    "message": "open_id cross app",
    "log_id": "20260823070003E59C53D20B259EBBCA1B"
  }
}
```

- 错误码 **99992361 "open_id cross app"**：飞书 open_id 跨应用错误，通常由 **令牌/应用配置错位** 引起（用 A 应用的 token 去操作 B 应用的 open_id）
- 首次出现 07:00:03，持续到 07:29:07+（与早间推送窗口完全重合）
- log_id 前缀均为 `20260823`（今日）

### launchd.out.log（今日 2026-08-23）

- 早间推送窗口 `2026-08-23#0700`：6 位顾问（felix/mia/york/wendy/linda/shanon）**每人 FAILED 30 次**，合计 180 次失败
- Otto 未出现在 0700 推送窗口（可能未配置或被排除）
- "桥接器已启动" 今日计数 = 0（无异常重启，进程未崩）
- out.log 全文启动标记累计 27 次（历史总量，非今日）

---

## 5. 服务存活

| 端点 | 状态 | HTTP | 延迟 | 响应体 |
|------|------|------|------|--------|
| `http://127.0.0.1:3100/api/v1/oauth/status` | ✅ 存活 | 200 | 1.17s | `{"configured":true,"dev_auth":false}` |
| `http://47.110.93.137:3100/api/v1/oauth/status` | 🔴 **下线** | 000 | 42ms | (连接被拒, port not open) |

本地后端正常（dev_auth=false，已配置 OAuth），**远端 ECS 后端疑似停机**。

---

## 6. 综合判断与建议（仅诊断，不执行）

### 根因推断
早间推送 180 次失败 + err.log 全是 `99992361 open_id cross app`，强烈指向**飞书 bot 令牌/应用配置错位**——很可能是最近一次 lark-cli 配置或 app 凭据变更后，推送脚本持有的 open_id 与当前 bot 应用不匹配。这与"远端后端下线"可能是两个独立故障，也可能联动（若推送脚本走远端后端转发，远端下线也会导致推送失败，但错误码是飞书 API 层返回，更倾向令牌侧问题）。

### 建议排查顺序（不代为执行）
1. **令牌侧**：检查 lark-cli 当前 bot app_id 与推送脚本中 open_id 的归属是否一致；`lark-cli` 提示 1.0.89 可用、当前 1.0.67，建议先 `lark-cli update`
2. **远端后端**：登录 ECS 确认 3100 端口服务进程是否存活（本地 OK，问题在远端）
3. **同步停滞**：sync_runs 8/22 起 0 新增，与 sync daemon 或 launchd 调度是否被令牌故障连带阻塞有关——优先恢复令牌后观察 sync 是否自愈
4. **待办**：5 个 ACCEPTED 无 outcome（尤其 felix 停滞 16 天）需人工补录 outcome；8 个 VIEWED 超 7 天需推进或释放

### ⚠️ 成本/风险提示
- 令牌修复后 daemon 可能触发积压的 sync 全量重跑，注意 token 用量与 DeepSeek 计费（可用 `AI_ENABLED=false` kill-switch 先做 dry-run）
- 修复前不要手动重启服务，先定位令牌根因

---

_只读检查完成，未对任何数据或服务执行写操作。_

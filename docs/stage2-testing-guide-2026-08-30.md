# BrainX 第二阶段测试文档（2026-08-30 批）

生产版本：`652200c`（= #29 + #30 + #31）。本文档列出本批全部改动、云端验证结果与第二步测试操作指引。

---

## 一、本批改动总览

| # | 改动 | 位置 | 云端状态 |
|---|------|------|---------|
| 1 | 曝光埋点（展示位置+展示概率） | `migrations/0021_impressions.sql`、`src/tier.js` | ✅ 落库运行 |
| 2 | 0-5 级业务结果标签 | `src/labels.js` | ✅ 在跑 |
| 3 | 排序离线评估（Recall@50/NDCG@10/P@10） | `scripts/eval-ranking.mjs`、`npm run eval:ranking` | ✅ 生产实测 |
| 4 | 热路径索引 + feedback 唯一索引 | 0021 迁移 | ✅ 已建 |
| 5 | SYNC_ALERT 日窗口键 | `src/push.js`、`src/server.js`、`src/scheduler.js` | ✅ 已上线 |
| 6 | openmai 凭证晨检 | `bin/brainx-openmai-health.mjs` | ✅ 6/7 健康 |
| 7 | LambdaMART 影子排序管线 | `src/ltr-features.js`、`bin/brainx-ltr-export.mjs`、`scripts/train_ltr.py`、`src/shadow-rank.js` | ✅ 训练+对照通过 |
| 8 | 影子对照日报 | `bin/brainx-shadow-daily.mjs` + `brainx-shadow-daily.timer`（每日 08:00） | ✅ 已注册运行 |
| 9 | 数据隔离硬约束 | `src/data-isolation.js`、`src/recommendation-page.js` | ✅ 端点在跑 |
| 10 | 进程拆分模式启用 | `BRAINX_EMBED_WORKER=0`、`brainx-worker.service` | ✅ API/worker 双活 |

---

## 二、云端验证结果（已全部实测）

### 1. openmai 找人全链路 ✅
```
凭证晨检：6/7 健康（York 无 JWT 为设计跳过），网关 reachable(200)
真实任务：JDWIAC3 rerun → status:done → 4 位真实候选人
```
复测命令：`ssh root@47.110.93.137 'cd /opt/brainx && node bin/brainx-openmai-health.mjs'`

### 2. 进程拆分（会议痛点"周期性卡死"的根治）✅
- API 只跑 HTTP/SSE：`brainx.service`（日志行「拆分模式：批处理由独立 worker 进程承担」）
- 批处理独立：`brainx-worker.service`（bridge/推荐/定时推送）
- **worker 被 kill 后 API 200 active 无感；worker 自愈（Restart=always）**
- SSE 接力实测：worker 侧写事件 → API 泵 → 浏览器收到（端到端通过）
- GC 修复已生效（worker_events 1 小时前自动清理）

### 3. 影子对照日报 ✅
- `brainx-shadow-daily.timer` 每日 08:00 跑，报告落 `/opt/brainx/data/shadow-daily-latest.json`
- 当期指标：Recall@50 66.7%、NDCG@10 90.0%（规则）vs 90.0%（影子）、Precision@10 36.3%
- 分歧 TopN：位移最大职位列表（当前 Δ=0 居多——影子刚训出、与规则强相关，属预期）

### 4. 数据隔离硬约束 ✅
- `GET /api/v1/reports/data-isolation`（需登录）实测：
  **`cockpit_context: 0, market_only: 1218`**
  → **重要数据发现：生产库 cockpit_facts 为空**，驾驶舱上下文链路从未在生产注入过数据（详见第四节风险 R1）
- 推荐页每个 item 现在带 `source_mode` / `membership_status` 机器可读字段

### 5. SYNC_ALERT 告警 ✅
日窗口键 `syncalert:YYYY-MM-DD`：同日最多一张、次日自动可再发（此前终身一次）。

### 6. 曝光/标签/评估 ✅
- 冻结推荐自动写 `recommendation_impressions`（rank、slot_kind、propensity）
- 列表真实下发回填 `served_at`（未展示永不进负反馈）
- 探索位口径：每 Top10 约 1 位，propensity=0.1
- `npm run eval:ranking` / `bin/brainx-shadow-daily.mjs` 可随时重跑

---

## 三、第二步测试操作清单

### T1 找人链路（OpenMai）
```bash
# 1) 晨检（应 6/7 ✓，网关 reachable）
ssh root@47.110.93.137 'cd /opt/brainx && node bin/brainx-openmai-health.mjs'
# 2) 前端登录 felix → 任一已接单职位 → 「开始找人」→ 等 done → 候选人列表
# 预期：status running → done，出现真实候选人；无 401/双 base 错误
```

### T2 拆分模式韧性
```bash
ssh root@47.110.93.137 'systemctl kill brainx-worker; sleep 2; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3101/'
# 预期：200，页面不受影响；~10s 后 worker 自愈
ssh root@47.110.93.137 'systemctl is-active brainx-worker'  # 预期 active
```

### T3 影子日报
```bash
ssh root@47.110.93.137 'systemctl start brainx-shadow-daily.service; sleep 10; journalctl -u brainx-shadow-daily --no-pager | tail -12'
# 预期：四行指标 + 各顾问分歧 TopN + 「报告: data/shadow-daily-latest.json」
```

### T4 数据隔离
```bash
# 登录后请求隔离报告（curl -b cookie）
# 预期 totals.cockpit_context 与 market_only 分列；
# 推荐页 item.source_mode ∈ {COCKPIT_CONTEXT, MARKET_ONLY}，无公司名升格
```

### T5 曝光与标签
```sql
-- 新跑一轮推荐后：
SELECT slot_kind, COUNT(*) FROM recommendation_impressions GROUP BY 1;      -- 探索位≈10%
SELECT COUNT(*) FROM recommendation_impressions WHERE served_at IS NOT NULL; -- 读页后 >0
```

### T6 告警
```bash
# 模拟同步失败（BRAINX_BRIDGE_OFF 除外的方式）或等真实限流窗口：
# 预期同日 SYNC_ALERT 只一张；改日期/次日可再发
```

---

## 四、风险与遗留（测试时请关注）

- **R1（重要）**：生产 `cockpit_facts = 0 行`——驾驶舱上下文链路（adapter/CSV 导入）从未在生产跑过。
  会议「两个数据源无法区分」的根因是**驾驶舱源缺数据**，不是隔离规则失效。
  建议：跑 `npm run adapter`（真实驾驶舱 CSV）后再验证 T4；当前全部职位为 MARKET_ONLY 属真实状态。
- **R2**：影子与规则 NDCG 同分（90.0%）——样本 202 行且与规则强相关，待 impressions 积累
  1-2 周后重训（`bin/brainx-ltr-export.mjs` → `uv run --with lightgbm --with scikit-learn scripts/train_ltr.py`），
  分歧 TopN 才会出现真实信号。
- **R3**：磁盘 89%（2.2G 余量）——retention 周度定时建议下周加上（脚本已存在 `bin/brainx-retention.mjs`）。
- **R4**：`brainx-openmai-health.mjs` 现可挂 cron 晨检（退出码 0/1 可直接接告警）。

# Brian X MVP + TTC Workspace v0.1 实施计划（v2 · 三轮审计合并版）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**版本说明**：v2 合并了三轮审计结论——①Claude 资产核验（2 个伪码 bug）；②深度只读审计（4 个阻断问题）；③工作台产品形态审计（Workspace 容器化）。与 v1 冲突处以本版为准。

**Goal:** 今天（2026-08-03，黑客松启动日）交付 Brian X 最小闭环：岗位信号 → 规则打分（带决策指示）→ 试单 3 人 → 飞书卡片推送 → 确认页采纳/忽略回写 → 采纳率统计 + 权重面板。同时以 **AppManifest** 定义把 Brian X 注册为 TTC Workspace 的第一个 App，为本周内交付 Workspace Shell v0.1 铺路。

**北极星指标（诚实命名）：推荐采纳率 = adopted / (adopted + ignored)**，按 `recommendations.status` 的**不同推荐**计算（不从事件表算，避免重复计数）。同时报告**响应率 = 已响应 / 已推送**。这是"推荐是否被接受"，不是业务成单结果；试单结果追踪（started/successful/failed）列为第二轮。

**Architecture:** 后端新建在 `ttc_daemon/decision/`（APIRouter 独立文件，app.py 只加一行 `include_router`）；前端页面从第一天起就放在 `static/apps/brianx/` 目录，按 App 结构组织，Workspace Shell 明天直接按 URL 包进来，不重写。数据存云端 RDS（3 张新表 + 推送幂等字段）。飞书推送复用 `ttc_daemon/notifications/feishu_bot.py` webhook 通路；按钮用 URL 跳确认页（webhook 收不到回调，应用机器人真回调列后续项）。

**Tech Stack:** Python 3.12 / pymysql / FastAPI（复用 8765）/ pytest / 飞书 webhook / 前端单页 HTML + 原生 JS（不引入前端工程，但接口结构按 AppManifest/SDK 设计）

---

## 已确认的输入（不再讨论）

- MVP = 完整闭环最小版；判断引擎 = 规则系数 + 人类微调（slider + 版本留痕；**自然语言调权、新增参数移出本次 MVP**）
- 交付 = 飞书卡片推送 + 确认页回写；执行 = 本仓库云端 804 人直接出试单人选
- 产品形态 = Brian X 是 **TTC Workspace 的第一个 App**；工作台做"统一打开 App 的容器"，**不做完整 Chrome**；本周只做 Workspace v0.1（应用栏/标签页/iframe+external 降级/上下文 URL 传递）
- 六环：观察上下文 → 形成判断 → 设计试品 → 受控执行 → 评价结果 → 更新策略

## 既有资产（已实测核验 2026-08-03）

| 资产 | 位置 | 实测结果 |
|---|---|---|
| 云端连接 | `candidate-collector/cloud_sync/client.py` `get_conn()` | ✅ @contextmanager，`with get_conn() as conn` 用法正确；需 `source .env` |
| 候选人 | 云端 `cloud_candidates` | ✅ **804 条**，其中 `char_length(raw_text)>100` 可用 **729 条**（CLAUDE.md 写"已清空为 0"已过时，需顺手更新） |
| 岗位信号 | 云端 `job_signals` | ⚠️ **仅 1 条**；列齐全；`signal_type` 枚举 `new|heating|cooling|fake_active|closed|active`（schema.sql:72），**必须过滤** |
| JD 打分引擎 | `candidate-collector/resume_scorer.py` | ✅ `build_dimensions()` 返回 **tuple[list[Dimension], str]**（不是 list！）；`DimScore.weighted` 才是正确加权值（score 0-10 × weight 0-100）；`score_resume()` 返回 0-10 分制且短简历 raise，试单选人不直接用它 |
| 飞书推送 | `ttc_daemon/notifications/feishu_bot.py` | ✅ `_webhook_url()` / `_send_card(card)` 都在；env `TTC_FEISHU_BOT_WEBHOOK` |
| FastAPI | `candidate-collector/app.py` | ✅ 1720 行，`/static` 已挂载；**run.sh 只监听 127.0.0.1**（按钮可达性需处理） |
| 时区 | RDS | `+08:00`，与本地 naive datetime 一致 |
| 测试环境 | `candidate-collector/.venv/bin/python -m pytest` | ✅ pytest 9.1.1 |

## 三轮审计修复清单（本计划已内置）

| # | 问题 | 修复 |
|---|---|---|
| B1 | `build_dimensions` 当 list 用（实际 tuple） | `dims, _source = build_dimensions(jd_text)` |
| B2 | `ds.score * dim.weight` 量纲放大 10 倍 | 用 `ds.weighted` 求和（0-100） |
| B3 | run.sh 只监听 127.0.0.1，按钮不可达 | 闸门阶段定方案：办公室演示 → `--host 0.0.0.0`+签名 token；手机演示 → `cloudflared tunnel --url http://127.0.0.1:8765` 拿临时 HTTPS |
| B4 | GET 点击即写库（预览/误触/伪造） | GET 只展示确认页不写库；POST 二次确认才写；URL 用 HMAC 签名 token（rec_id+action+日期），actor 不信 URL 明文 |
| B5 | 采纳率从事件表算会重复计数 | 从 `recommendations.status` 按不同推荐算；事件表只作审计 + `request_id UNIQUE` 幂等 |
| B6 | 未过滤 signal_type | `WHERE signal_type IN ('new','heating','active')`，关闭/fake_active 岗位永不推荐，signal_type 纳入决策理由 |
| B7 | salary_fit 名不副实 | 改名「薪资信息完整度」，避免误导 |
| B8 | PASS_SCORE=30 拍脑袋 | 闸门阶段用 729 人真实分布校准（预期 50-60 起测） |
| B9 | 同一 JD 对 729 人打两遍分 | 单次遍历同时出 supply_hits 和 Top3 |
| B10 | 端点堆进 1720 行 app.py | `ttc_daemon/decision/api.py` 用 APIRouter，app.py 只 `include_router` |
| B11 | pytest 连生产 RDS 隐式建表 | schema 显式 migration 手动执行；RDS 测试打 `@pytest.mark.integration` |
| B12 | 权重结构两套（带 desc / 纯数值） | DB 只存数值权重；desc 在代码维度注册表；**拒绝未知维度**（不允许"保存成功但不生效"） |
| B13 | 推送不幂等（cron 重跑重复发卡） | `recommendations` 加 `sent_at/send_attempts/last_send_error`，只推 `sent_at IS NULL`，`--force` 才重发 |
| B14 | 稀疏信号当完整 JD 用 | 标准化拼接 jd_text（岗位/公司/关键词/聊天证据）；有效关键词 <2 标记 `needs_clarification` 不强推 |

---

## Phase 0：闸门验证（今天上午第一件事，~45 分钟）

**三项全过才进入 Phase 1；任一失败先修输入和链路。**

1. **信号闸门**：手动从飞书群聊记录抽 5-10 条真实岗位信号灌入 `job_signals`（signal_type 填 'new'/'heating'）；同时确认 R5 cron 昨天是否正常跑、为什么只有 1 条。
2. **链路闸门**：改 `--host 0.0.0.0` 起服务（或 cloudflared），用**目标顾问真实使用的飞书端**（手机）点开一个测试 URL 确认可达；定下正式方案用的地址写进卡片模板。
3. **打分闸门**：用 1 条真实信号构造标准化 jd_text，对 729 人跑 `build_dimensions` + `_score_dimension`，看分数分布：Top3 是否真的是合理人选（人工判断），定 PASS_SCORE；确认维度没有全部落入通用兜底模板。

---

## Phase 1：Brian X 闭环（今天）

### Task 1: 决策三张表（显式 migration）

**Files:** `ttc_daemon/decision/__init__.py`、`schema.sql`、`db.py`、`scripts/migrate_decision_schema.py`；Test: `candidate-collector/test_decision_db.py`（打 integration 标记）

schema 在 v1 基础上修订：

```sql
CREATE TABLE IF NOT EXISTS recommendations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  rec_date DATE NOT NULL,
  consultant VARCHAR(64) NOT NULL DEFAULT '',
  job_signal_fingerprint VARCHAR(64) NOT NULL,
  job_title VARCHAR(255) DEFAULT '',
  company VARCHAR(255) DEFAULT '',
  signal_type VARCHAR(32) DEFAULT '',
  jd_text_snapshot TEXT,                -- 生成时的标准化 jd_text 快照
  total_score DOUBLE NOT NULL,
  reasons_json JSON NOT NULL,
  trial_candidates_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',   -- pending/adopted/ignored/needs_clarification
  ignore_reason VARCHAR(255) DEFAULT '',
  weight_version INT NOT NULL DEFAULT 1,
  sent_at DATETIME NULL,                -- 推送幂等（B13）
  send_attempts INT NOT NULL DEFAULT 0,
  last_send_error VARCHAR(255) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rec (rec_date, consultant, job_signal_fingerprint)
);

CREATE TABLE IF NOT EXISTS weight_config (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  version INT NOT NULL,
  weights_json JSON NOT NULL,           -- 纯数值 {"freshness":0.25,...}（B12）
  change_source VARCHAR(16) NOT NULL DEFAULT 'slider',
  change_note VARCHAR(255) DEFAULT '',
  changed_by VARCHAR(64) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_version (version)
);

CREATE TABLE IF NOT EXISTS adoption_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  recommendation_id BIGINT NOT NULL,
  request_id VARCHAR(64) NOT NULL,      -- 请求级幂等（B5）
  event_type VARCHAR(16) NOT NULL,      -- adopted/ignored
  actor VARCHAR(64) DEFAULT '',
  detail_json JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_request (request_id),
  KEY idx_rec (recommendation_id)
);
```

- `scripts/migrate_decision_schema.py`：手动执行一次的建表脚本（不在测试/请求里隐式建表，B11）。
- `db.py`：`current_weights()` seed 落库逻辑同 v1（纯数值 seed）。
- 测试：`@pytest.mark.integration` 标记，断言三表存在。

**Commit** `feat(decision): 决策三张表 schema（含推送幂等/请求幂等）+ migration 脚本`

### Task 2: 信号打分引擎

**Files:** `ttc_daemon/decision/signal_scorer.py`；Test: `candidate-collector/test_signal_scorer.py`

在 v1 伪码基础上修订：
- `score_signal(signal, weights, supply_hits, now=None)`——**now 可注入**，测试不靠墙钟。
- 「薪资适配」改名「**薪资信息完整度**」（B7）。
- signal_type 进入决策理由（如"信号状态：heating"）；`cooling` 在分数上降权（×0.5）。
- 维度注册表放代码里：`DIMENSION_REGISTRY = {"freshness": {"desc": ...}, ...}`，DB 只存数值（B12）。
- freshness/salary/urgency/supply/client_history 五维逻辑同 v1。

测试：v1 的两个用例 + 「now 注入后同一信号分数确定」+「未知维度权重被拒绝」。

**Commit** `feat(decision): 信号五维规则打分引擎（now可注入/维度注册表/signal_type入理由）`

### Task 3: 试单选人（含 B1/B2/B8/B9 修复）

**Files:** `ttc_daemon/decision/trial_picker.py`；Test: `candidate-collector/test_trial_picker.py`

```python
from resume_scorer import build_dimensions, _score_dimension

def score_pool(jd_text: str, candidates: list[dict]) -> list[dict]:
    """同一 JD 只对候选人池打一次分，返回全部得分（降序）。B9：supply_hits 和 Top3 都从这里出。"""
    dims, _source = build_dimensions(jd_text)          # B1：tuple 解包
    out = []
    for c in candidates:
        text = c.get("raw_text") or ""
        if len(text.strip()) < 10:
            continue
        total = sum(_score_dimension(text, d).weighted for d in dims)  # B2：0-100
        ev = []
        for d in dims:
            ds = _score_dimension(text, d)
            if ds.evidence:
                ev.append(ds.evidence[0])
        out.append({"fingerprint": c["fingerprint"], "name": c.get("name") or "未知",
                    "score": round(total, 1), "evidence": ev[:2]})
    return sorted(out, key=lambda x: -x["score"])

def pick_trial(scored: list[dict], pass_score: float, limit: int = 3) -> list[dict]:
    return [s for s in scored if s["score"] >= pass_score][:limit]

def supply_hits(scored: list[dict], pass_score: float) -> int:
    return sum(1 for s in scored if s["score"] >= pass_score)
```

注意：上面 evidence 收集有重复打分，实现时合并成单循环一次拿分数+证据。PASS_SCORE 来自 Phase 0 校准结果，写成常量带注释说明校准依据。

**Commit** `feat(decision): 试单选人——单次遍历出供给数+Top3（修复tuple/量纲）`

### Task 4: 推荐生成器

**Files:** `ttc_daemon/decision/recommend.py`；Test: `candidate-collector/test_recommend.py`

- SQL：`WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND signal_type IN ('new','heating','active') AND job_title IS NOT NULL AND job_title != ''`（B6）
- jd_text 标准化拼接（B14）：
  ```
  岗位：{job_title}
  公司：{company}
  关键词：{keywords_json 解析后空格连接}
  聊天证据：{excerpt}
  ```
  有效技能关键词 <2 → status='needs_clarification'，照常落库但不进推送队列。
- 候选人：`SELECT fingerprint, name, raw_text FROM cloud_candidates WHERE char_length(raw_text) > 100`
- 每信号：`score_pool` 一次 → `supply_hits` → `score_signal` → Top3 → upsert（ON DUPLICATE KEY UPDATE 不动 status/sent_at，避免覆盖已采纳/已推送）；`jd_text_snapshot` 留痕。
- CLI：`PYTHONPATH=ttc_daemon:candidate-collector python -m decision.recommend --consultant ashley --dry-run` 先输出一条真实推荐供人工审核再落库。

**Commit** `feat(decision): 每日推荐生成器（signal_type过滤/jd标准化/快照留痕/幂等）`

### Task 5: 飞书卡片推送

**Files:** `ttc_daemon/decision/push_card.py`；Test: `candidate-collector/test_push_card.py`

- 复用 `feishu_bot._webhook_url()`；webhook 未配置时 `--dry-run` 打印卡片 JSON，**推送失败绝不阻塞推荐生成**。
- 卡片：标题 `📋 今日选品推荐 i/N · {job_title} @ {company} · {total}分`；决策指示区 5 维各一行（维度 得分×权重=加权 · 理由，含 signal_type 行）；试单 3 人各一行（姓名 匹配分 · 证据）；按钮 `✅ 采纳` `❌ 忽略` 为 URL 按钮，链接带 **HMAC 签名 token**（B4）；底部「调权重」链接。
- 只推 `status='pending' AND sent_at IS NULL`；发送成功写 `sent_at`，失败写 `last_send_error` 且 `send_attempts+1`；`--force` 才可重发（B13）。
- 信号不足 N 条时有几条推几条，首卡注明"今日有效信号仅 N 条"。
- 手动验证：`TTC_FEISHU_BOT_WEBHOOK=... python -m decision.push_card --rec-id 1` 真发一条确认渲染。

**Commit** `feat(decision): 飞书卡片推送（决策指示+试单3人+签名URL按钮+推送幂等）`

### Task 6: 采纳回写 API（B4/B5/B10 修复）

**Files:** `ttc_daemon/decision/api.py`（APIRouter）、`ttc_daemon/decision/security.py`（HMAC token）、`candidate-collector/static/apps/brianx/confirm.html`；Modify: `candidate-collector/app.py`（+1 行 `include_router`）；Test: `candidate-collector/test_decision_api.py`

端点：
1. `GET /api/decision/respond?token=...` → **只渲染确认页不写库**（防预览/扫描误写，B4）。页面显示推荐摘要 + 大字确认按钮；忽略时附可选原因输入，随 POST 一次提交（不允许先记忽略再补原因）。
2. `POST /api/decision/respond` body `{token, ignore_reason?}` → 验签（HMAC(rec_id|action|日期)，当日有效）→ action 白名单校验 → 状态机：`pending→adopted/ignored`，已响应的推荐重复 POST 返回当前状态不重复记事件；事件带 `request_id`（token hash）靠 UNIQUE 兜底幂等 → 写 `adoption_events` + 更新 `recommendations.status`。
3. `GET /api/decision/stats?days=7` → 从 `recommendations.status` 按不同推荐算（B5）：`{"pushed": n, "responded": m, "adopted": a, "ignored": i, "response_rate": ..., "adoption_rate": ..., "by_day": [...]}`。
4. `GET /api/decision/today` → 今日推荐列表（面板用）。

**Commit** `feat(decision): 采纳/忽略回写API（GET展示POST写入+HMAC签名+状态机幂等+按状态统计）`

### Task 7: 调权面板（砍到最小）

**Files:** `candidate-collector/static/apps/brianx/weights.html`；`api.py` +2 端点

- `GET /api/decision/weights` → 当前版本 + 数值权重 + 注册表 desc。
- `POST /api/decision/weights` body `{weights, note, changed_by}` → **未知维度直接 422 拒绝**（B12）；权重和 ≠1.0±0.01 时服务端归一并告知；version+1 落库。
- 页面：5 个 slider + 实时归一化显示 + 「新版本 v{N} 已生效，明早推荐将使用」。**无自然语言框、无新增参数按钮。**

**Commit** `feat(decision): 调权面板（slider+版本留痕+未知维度拒绝）`

### Task 8: 每日定时

**Files:** `scripts/cron_brianx_daily.sh`

- 8:50 `decision.recommend` → 9:00 `decision.push_card --daily`（先一条昨日采纳率摘要卡，再逐条今日推荐）。
- 脚本开头健康检查 8765，没起就拉起（nohup）；脚本加 flock 防重复运行；失败非零退出留日志。
- crontab 行写进文档由用户自己加；launchd 保活 8765 列为可选优化。

**Commit** `feat(decision): 每日定时推荐+昨日采纳率摘要卡+服务健康检查`

---

## Phase 2：Workspace Shell v0.1（8/4–8/5，阻塞 Check-in 1 之前必须完成）

**产品定位：通用应用工作台/应用容器，不是塞几个 iframe。Brian X 是第一个 App。**

### AppManifest（Phase 1 期间就定义好，Phase 2 直接消费）

```json
{
  "id": "brianx",
  "name": "Brian X",
  "icon": "/static/icons/brianx.svg",
  "entry_url": "/static/apps/brianx/index.html",
  "launch_mode": "internal",
  "permissions": ["job.read", "candidate.read", "recommendation.respond"],
  "context_types": ["job", "candidate"]
}
```

注册表存 `workspace/registry/apps.json`（后端 `GET /api/workspace/apps` 下发）。四种启动模式：`internal`（自己开发的页面）/ `iframe`（可嵌入的内外网页）/ `external`（不可嵌入降级系统浏览器）/ `desktop_webview`（将来 Electron）。**第一版承诺：所有 App 都能统一打开，能嵌的内嵌，不能嵌的自动降级——不承诺任意网站都在窗口内运行。**

### Shell v0.1 功能（单页 HTML + 原生 JS，`static/workspace/`）

做：App 注册表加载、左侧 App Dock、多标签页、iframe 容器（`sandbox` 属性）、external 降级、URL 参数传上下文（`?candidate_id=&job_id=`）、最近打开（localStorage）。

不做：任意网址输入、浏览器扩展、下载/密码管理、桌面 WebView、复杂跨 App 消息总线、多窗口、分屏。

### App Bridge 最小协议（先定义后实现，本期只落地 URL 传参）

```text
openApp(id, context) / openEntity(type, id) / getContext()
createTask() / emitEvent() / subscribeEvent()  ← 后三个本周只写接口文档不实现
```

### 后端

`ttc_daemon/workspace/api.py`（APIRouter）：`GET /api/workspace/apps`、`GET /api/workspace/recent`。安全底线：嵌入域名白名单、iframe sandbox、权限声明进 manifest、**候选人数据只经后端 API，前端/App 永不接触 RDS 凭证**、写操作全走后端审计。

**Commit** `feat(workspace): Shell v0.1——AppDock/多标签/manifest注册表/iframe+external降级`

---

## Phase 3：黑客松里程碑对齐（8/8 → 9/21）

| 时间 | 交付 |
|---|---|
| 8/8–8/14 | 人才库 App 注册（iframe 模式，打通候选人上下文：Brian X 点候选人 → 新标签开人才库详情 → 保留职位上下文 → 返回）；积累真实采纳率/响应率数据；R5 信号量监控 |
| **8/17 Check-in 1** | 演示：Workspace 统一入口 + Brian X 活闭环 + 第一周真实采纳率数字 |
| 8/18–8/28 | CRM、飞书注册为 external/iframe App；按嵌入失败实况补 fallback；权重面板真实迭代记录（版本留痕即"迭代速度"证据） |
| **8/31 Check-in 2** | 中期复盘：采纳率趋势 + 权重迭代史 + 工作流打法（单点 agent 替代）叙事 |
| 9/1–9/12 | 试单结果追踪（started/successful/failed，把北极星指标升级为业务结果）；bridge emitEvent 落地（candidate.reviewed）；按需 Electron 评估 |
| **9/14 Check-in 3** | 模拟考试 |
| **9/21 决赛** | 完整闭环 + 可复制性叙事（Workspace 是平台，Brian X 只是第一个 App，隔壁组也能注册自己的 App） |

---

## 今日验收标准（比 v1 更严，全部满足才算交付）

1. 一条真实有效岗位信号能生成有证据的 Top3（人工判断合理）。
2. 相同日期重复生成不新增推荐；重跑推送不重复发卡。
3. 目标飞书端（手机）能打开确认页；**打开链接本身不改数据，POST 确认才写库**。
4. 重复 POST 只产生一次有效结果；先忽略后采纳按当前状态统计。
5. 已关闭/fake_active 岗位永不进推荐。
6. stats 同时展示响应率和采纳率，按不同推荐计算。
7. 改权重产生新版本，旧推荐保留原权重版本；未知维度被拒绝。
8. webhook 或 RDS 故障留可诊断错误，不静默假成功。
9. 信号不足时有几条推几条并注明，不空推不报错。
10. Brian X 页面位于 `static/apps/brianx/` 且有 AppManifest，可被明天的 Shell 直接注册。

## 明确不做（YAGNI）

自然语言调权、新增参数按钮、应用机器人真按钮回调、客户历史转化真实数据（恒 0.5）、张浩组库对接、分屏/多窗口/任意网址输入、Electron（确有必要再评估）、正式 HTTPS 域名（cloudflared 临时隧道兜底）、向前/回滚 migration SQL（错了 DROP 重来）。

## 风险

- `job_signals` 量不足是**确定发生**而非风险 → Phase 0 手动灌信号是正式步骤；R5 cron 今天必须查明为什么只有 1 条。
- 8765 服务保活 → cron 脚本内健康检查兜底；DHCP IP 变化 → 用 cloudflared 隧道或 mDNS 主机名写进卡片。
- 确认页手机可达性 → Phase 0 闸门真机验证，不过不开发卡片。
- 今天 8 个 Task 偏满 → Task 7 可滑到 8/4，闭环（Task 1-6）不可滑。

# Brian X + TTC Workspace 设计方案（开发规格书）

> 本文档自包含。开发者无需任何背景知识，严格按本文档执行即可。
> 版本：2026-08-03 · 状态：已冻结，变更需文档版本号 +1

---

## 1. 仓库与环境

### 1.1 仓库路径

仓库根目录（下称 `$ROOT`）：`/Users/ashley/Downloads/ttc的交易系统`

目录名 `candidate-collector` 含连字符，**不能作为 Python 包名 import**。所有跨目录导入通过 `sys.path` 解决，见 §6.1。

### 1.2 Python 环境

- 解释器：`$ROOT/candidate-collector/.venv/bin/python`（Python 3.12，pymysql / fastapi / pytest 9.1.1 / requests 已安装）
- 所有 Python 命令必须用该解释器，禁止用系统 python。

### 1.3 环境变量

凭据文件 `$ROOT/.env`（已存在，禁止提交 git）。运行任何连库/推送命令前：

```bash
cd $ROOT && set -a && source .env && set +a
```

| 变量 | 状态 | 用途 |
|---|---|---|
| `RDS_HOST` / `RDS_USER` / `RDS_PASSWORD` | 已有 | 云端 MySQL 连接 |
| `TTC_FEISHU_BOT_WEBHOOK` | 已有 | 飞书自定义机器人 webhook 地址 |
| `TTC_DECISION_HMAC_SECRET` | **新增** | 回写 token 签名密钥，≥32 随机字符 |
| `TTC_DECISION_BASE_URL` | **新增** | 卡片按钮链接前缀，如 `http://192.168.x.x:8765` 或 cloudflared 隧道域名 |

### 1.4 云端数据库

- 阿里云 RDS MySQL 8.0，库 `ttc_talent`，时区 `+08:00`。
- **MySQL 方言禁忌（违反即报错）**：不支持 `ILIKE`（用 `LIKE`）、`CREATE INDEX IF NOT EXISTS`、`NULLS LAST`、`ADD COLUMN IF NOT EXISTS`。
- pymysql 写 JSON 列必须先 `json.dumps`，禁止直接绑定 dict。

### 1.5 现有数据（2026-08-03 实测）

- `cloud_candidates`：804 行，其中 `char_length(raw_text) > 100` 的 729 行。主要列：`fingerprint, name, platform, current_company, current_role, phone, expected_salary, keywords_json, raw_text`。
- `job_signals`：主要列：`fingerprint, job_title, company, keywords_json, excerpt, signal_type, last_seen_at`。`signal_type` 枚举：`new | heating | cooling | fake_active | closed | active`。当前仅 1 行，开发前需手动灌入 ≥5 条测试数据（见 §12 Step 0）。

---

## 2. 系统总览

```
job_signals (RDS)                    cloud_candidates (RDS)
      │                                      │
      ▼                                      ▼
┌─────────────────────────────────────────────────┐
│ decision.recommend（每日 8:50 cron）              │
│  过滤信号 → 标准化 jd_text → trial_picker 打分    │
│  → signal_scorer 五维打分 → upsert recommendations│
└─────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────┐
│ decision.push_card（每日 9:00 cron）              │
│  未推送推荐 → 飞书卡片（webhook）→ 写 sent_at      │
└─────────────────────────────────────────────────┘
      │ 顾问手机点卡片按钮（URL 带 HMAC token）
      ▼
confirm.html（GET 静态页，不写库）→ GET preview（只读）
      │ 用户点确认按钮
      ▼
POST /api/decision/respond → 验签 → 状态机 → 写库
      │
      ▼
GET /api/decision/stats（采纳率/响应率）← index.html 面板
GET/POST /api/decision/weights（权重版本管理）← weights.html
```

组件边界：
- 所有 RDS 读写只允许发生在 `ttc_daemon/decision/` 包内，前端与卡片生成器不直连数据库（push_card 例外：它通过 decision.db 更新 sent_at）。
- 前端全部是无框架静态 HTML + 原生 JS，位于 `candidate-collector/static/` 下，通过既有 StaticFiles 挂载（URL 前缀 `/static`）访问。
- HTTP 服务复用 `candidate-collector/app.py`（FastAPI，端口 8765）。

---

## 3. 目录结构

`[新建]` = 本次创建；`[修改]` = 改动既有文件。其余文件禁止改动。

```
$ROOT/
├── ttc_daemon/
│   ├── decision/                      [新建包]
│   │   ├── __init__.py                空文件
│   │   ├── _bootstrap.py              sys.path 引导（§6.1）
│   │   ├── schema.sql                 建表 SQL（§5）
│   │   ├── db.py                      连接与权重读取（§6.2）
│   │   ├── signal_scorer.py           信号五维打分（§6.3）
│   │   ├── trial_picker.py            候选人池打分与 Top3（§6.4）
│   │   ├── recommend.py               推荐生成器 + CLI（§6.5）
│   │   ├── security.py                HMAC token（§6.6）
│   │   ├── push_card.py               飞书卡片构建与推送 + CLI（§6.7）
│   │   └── api.py                     FastAPI APIRouter（§7）
│   └── workspace/                     [新建包，Phase 2]
│       ├── __init__.py                空文件
│       └── api.py                     GET /api/workspace/apps（§10.4）
├── workspace/
│   └── registry/
│       └── apps.json                  [新建] App 注册表（§10.2）
├── scripts/
│   ├── migrate_decision_schema.py     [新建] 手动建表脚本（§5.2）
│   └── cron_brianx_daily.sh           [新建] 每日任务（§11）
├── candidate-collector/
│   ├── conftest.py                    [新建] pytest 路径引导（§13.1）
│   ├── app.py                         [修改] +3 行挂载 decision router（§7.1）
│   ├── run.sh                         [修改] --host 改为 0.0.0.0（§7.2）
│   ├── static/
│   │   ├── apps/brianx/               [新建]
│   │   │   ├── app.manifest.json      App 清单（§10.1）
│   │   │   ├── index.html             今日推荐面板（§9.1）
│   │   │   ├── confirm.html           采纳/忽略确认页（§9.2）
│   │   │   └── weights.html           调权面板（§9.3）
│   │   └── workspace/                 [新建，Phase 2]
│   │       ├── index.html             Shell 页面（§10.3）
│   │       └── shell.js               Shell 逻辑（§10.3）
│   ├── test_decision_db.py            [新建] integration
│   ├── test_signal_scorer.py          [新建]
│   ├── test_trial_picker.py           [新建]
│   ├── test_security.py               [新建]
│   ├── test_recommend.py              [新建]
│   ├── test_push_card.py              [新建]
│   └── test_decision_api.py           [新建]
└── docs/design/2026-08-03-brianx-workspace-design.md   本文档
```

---

## 4. 既有代码接口（复用，禁止修改这些文件）

### 4.1 数据库连接 — `candidate-collector/cloud_sync/client.py`

```python
from cloud_sync.client import get_conn

with get_conn() as conn, conn.cursor() as cur:
    cur.execute("SELECT ...")
    rows = cur.fetchall()
    conn.commit()   # 写操作必须显式 commit
```

`get_conn` 是 `@contextmanager`，yield `pymysql.Connection`。cursor 默认返回 tuple（非 dict）。

### 4.2 简历打分引擎 — `candidate-collector/resume_scorer.py`

```python
def build_dimensions(jd_text: str, weights_config=None) -> tuple[list[Dimension], str]
# 返回 (维度列表, 来源说明)。注意是 tuple，必须解包：dims, source = build_dimensions(jd)

def _score_dimension(text: str, dim: Dimension) -> DimScore

@dataclass
class Dimension:
    name: str
    weight: float          # 0-100，各维度合计 100
    keywords: list[str]
    core: bool
    strong_keywords: list[str]

@dataclass
class DimScore:
    name: str
    weight: float
    score: float           # 0-10
    weighted: float        # = score/10 × weight，0-100 量纲。总分必须对它求和
    hits: list[str]
    evidence: list[str]
    core: bool
```

**禁止事项**：
- 禁止用 `ds.score * dim.weight` 计算总分（量纲放大 10 倍）。正确：`sum(ds.weighted ...)`，结果 0-100。
- 禁止调用 `score_resume()`（返回 0-10 分制、短文本抛 ValueError、每次调用重建维度）。
- 禁止修改 `resume_scorer.py`。`_score_dimension` 虽为私有命名，本设计显式允许跨包使用。

### 4.3 飞书推送 — `ttc_daemon/notifications/feishu_bot.py`

```python
from notifications.feishu_bot import _webhook_url, _send_card

url = _webhook_url()          # 读 env TTC_FEISHU_BOT_WEBHOOK，未配置返回 None
ok = _send_card(payload)      # payload 为完整消息体 dict，内部 requests.post(webhook, json=payload)
```

`_send_card` 接收的 payload 格式：`{"msg_type": "interactive", "card": {...}}`（见 §8）。未配置 webhook 时它会降级到 lark-cli 发纯文本；push_card 必须先检查 `_webhook_url()` 是否为 None，为 None 时走 dry-run。

### 4.4 FastAPI 挂载先例 — `candidate-collector/app.py`

- 第 202 行：`app = FastAPI(...)`
- 第 210 行：`app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")`，其中 `ROOT` = `candidate-collector/` 目录
- 第 211 行已有先例：`app.include_router(db_admin.router)`

### 4.5 安全警示

`ttc_daemon/config.py:66` 存在硬编码的飞书 Base token，属于历史遗留问题。**新代码禁止效仿**：任何密钥只从环境变量读取。

---

## 5. 数据库设计

### 5.1 `ttc_daemon/decision/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS recommendations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  rec_date DATE NOT NULL,
  consultant VARCHAR(64) NOT NULL DEFAULT '',
  job_signal_fingerprint VARCHAR(64) NOT NULL,
  job_title VARCHAR(255) DEFAULT '',
  company VARCHAR(255) DEFAULT '',
  signal_type VARCHAR(32) DEFAULT '',
  jd_text_snapshot TEXT,
  total_score DOUBLE NOT NULL,
  reasons_json JSON NOT NULL,
  trial_candidates_json JSON NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  ignore_reason VARCHAR(255) DEFAULT '',
  weight_version INT NOT NULL DEFAULT 1,
  sent_at DATETIME NULL,
  send_attempts INT NOT NULL DEFAULT 0,
  last_send_error VARCHAR(255) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rec (rec_date, consultant, job_signal_fingerprint)
);

CREATE TABLE IF NOT EXISTS weight_config (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  version INT NOT NULL,
  weights_json JSON NOT NULL,
  change_source VARCHAR(16) NOT NULL DEFAULT 'slider',
  change_note VARCHAR(255) DEFAULT '',
  changed_by VARCHAR(64) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_version (version)
);

CREATE TABLE IF NOT EXISTS adoption_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  recommendation_id BIGINT NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(16) NOT NULL,
  actor VARCHAR(64) DEFAULT '',
  detail_json JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_request (request_id),
  KEY idx_rec (recommendation_id)
);
```

`recommendations.status` 状态机：

```
pending ──→ adopted        （POST action=adopt）
pending ──→ ignored        （POST action=ignore）
needs_clarification        （生成时关键词不足，终态，不推送）
adopted / ignored          （终态；重复 POST 返回当前状态，不产生新事件）
```

### 5.2 `scripts/migrate_decision_schema.py`

手动执行一次的建表脚本。逻辑：导入 `_bootstrap` → 读 `schema.sql` → 按 `;` 切分逐条执行 → commit → 打印 `SHOW TABLES` 结果。

执行命令：

```bash
cd $ROOT && set -a && source .env && set +a && \
PYTHONPATH=ttc_daemon:candidate-collector candidate-collector/.venv/bin/python scripts/migrate_decision_schema.py
```

禁止在 pytest、FastAPI 启动或 recommend 运行时隐式建表。

---

## 6. 后端模块规格

### 6.1 `ttc_daemon/decision/_bootstrap.py`

跨目录导入的唯一引导点。内容：

```python
"""把 candidate-collector 加入 sys.path。decision 包内模块必须在其他 import 前先导入本模块。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_CC = str(ROOT / "candidate-collector")
if _CC not in sys.path:
    sys.path.insert(0, _CC)
```

decision 包内每个模块的第一条可执行 import 必须是 `from decision import _bootstrap  # noqa: F401`。运行时命令统一带 `PYTHONPATH=ttc_daemon:candidate-collector`；pytest 由 `conftest.py` 处理（§13.1）。

### 6.2 `ttc_daemon/decision/db.py`

职责：连接获取、权重读取。公开接口：

```python
def current_weights() -> dict
# 返回 {"version": int, "weights": {dim_name: float, ...}}
# 逻辑：SELECT version, weights_json FROM weight_config ORDER BY version DESC LIMIT 1
#   有行 → {"version": row[0], "weights": json.loads(row[1])}
#   无行 → 插入 seed（version=1, change_source='seed'），返回 seed
# seed = {"freshness":0.25, "salary_fit":0.20, "urgency":0.20, "supply_match":0.25, "client_history":0.10}
# weights_json 只存 维度名→数值，不存 desc（desc 在 signal_scorer.DIMENSION_REGISTRY）
```

### 6.3 `ttc_daemon/decision/signal_scorer.py`

职责：岗位信号五维打分，每维输出 0-100 子分 + 中文理由。公开接口：

```python
DIMENSION_REGISTRY: dict[str, dict]  # {"freshness": {"desc": "信号新鲜度..."}, ...} 五维齐全

def score_signal(signal: dict, weights: dict, supply_hits: int,
                 now: datetime | None = None) -> dict
```

`signal` dict 键：`job_title, company, excerpt, keywords_json, signal_type, last_seen_at`（last_seen_at 为 `datetime` 或 `"YYYY-MM-DD HH:MM:SS"` 字符串）。

`now` 为 None 时用 `datetime.now()`；测试必须显式注入 now。

返回：

```python
{
  "total": float,          # 0-100，round(..., 1)
  "dimensions": [           # 按注册表顺序，每项：
    {"name": str, "score": float, "weight": float, "weighted": float, "reason": str}
  ]
}
```

维度规则（子分均 0-100）：

| 维度 | 规则 | reason 示例 |
|---|---|---|
| `freshness` | days = (now − last_seen_at) 天数（浮点，下限 0）；score = max(0, 100 − 15 × max(0, days − 1)) | `"信号 1.2 天前活跃"` |
| `salary_fit`（卡片显示名：**薪资信息完整度**） | excerpt 匹配 `(\d+)\s*[-~至]\s*(\d+)\s*[kK]`；无匹配 40 分；hi≤lo 或 hi>200 给 30 分；带宽 10-30k 给 90 分，否则 60 分 | `"薪资 40-60k 带宽20k"` |
| `urgency` | job_title+excerpt 含 `急招/急聘/尽快/ASAP/asap/本周到岗/立即到岗/刚需` → 100，否则 30 | `"命中紧急词：急招/尽快"` |
| `supply_match` | min(100, supply_hits × 10) | `"人才库命中 12 人可试单"` |
| `client_history` | 恒 50 | `"冷启动默认中性（无历史转化数据）"` |

signal_type 修正（在维度计算后、返回前应用，并追加一条 reason 到 urgency 维度）：
- `heating`：urgency 子分 = min(100, urgency + 20)，reason 追加 `"；信号状态：heating"`。
- `cooling`：total ×= 0.5，urgency reason 追加 `"；信号状态：cooling，总分减半"`。

未知维度处理：`score_signal` 遇到 `weights` 中不在 `DIMENSION_REGISTRY` 的键，抛 `ValueError(f"未知维度: {name}")`。

### 6.4 `ttc_daemon/decision/trial_picker.py`

职责：对候选人池按 jd_text 打分，单次遍历同时产出供给数与 Top3。公开接口：

```python
PASS_SCORE = 55  # 临时默认值；§12 Step 0 校准后更新此常量并在注释写明校准依据

def score_pool(jd_text: str, candidates: list[dict]) -> list[dict]
# candidates 元素：{"fingerprint": str, "name": str|None, "raw_text": str|None}
# 流程：dims, _source = build_dimensions(jd_text)   # tuple 必须解包
#   每个候选人：text = raw_text or ""；len(text.strip()) < 10 → 跳过
#   单循环内对每个 dim 调一次 _score_dimension(text, dim)，同时累计：
#     total += ds.weighted；ds.evidence 非空 → evidence.append(ds.evidence[0])
#   同一 dim 禁止重复调用 _score_dimension
# 返回降序列表：[{"fingerprint", "name"（None→"未知"）, "score": round(total,1), "evidence": 最多2条}]

def supply_hits(scored: list[dict], pass_score: float = PASS_SCORE) -> int
def pick_trial(scored: list[dict], pass_score: float = PASS_SCORE, limit: int = 3) -> list[dict]
```

### 6.5 `ttc_daemon/decision/recommend.py`

职责：每日推荐生成。公开接口：

```python
def normalize_jd_text(signal: dict) -> tuple[str, int]
# 返回 (jd_text, 有效关键词数)。格式：
#   岗位：{job_title}\n公司：{company}\n关键词：{空格连接}\n聊天证据：{excerpt}
# 有效关键词 = json.loads(keywords_json or "[]") 中 len(kw.strip()) >= 2 的个数

def daily_recommend(consultant: str = "", top: int = 3, dry_run: bool = False) -> list[dict]
```

`daily_recommend` 流程（严格按序）：

1. 信号查询：
   ```sql
   SELECT fingerprint, job_title, company, keywords_json, excerpt, signal_type, last_seen_at
   FROM job_signals
   WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
     AND signal_type IN ('new', 'heating', 'active')
     AND job_title IS NOT NULL AND job_title <> ''
   ```
2. 候选人查询（一次，全信号复用）：
   ```sql
   SELECT fingerprint, name, raw_text FROM cloud_candidates WHERE char_length(raw_text) > 100
   ```
3. `weights = db.current_weights()`。
4. 每个信号：`jd_text, kw_count = normalize_jd_text(signal)` → `scored = score_pool(jd_text, candidates)` → `hits = supply_hits(scored)` → `result = score_signal(signal, weights["weights"], hits)`。
5. 筛选：`kw_count < 2` → status = `needs_clarification`，trial = `[]`；否则 status = `pending`，`trial = pick_trial(scored)`。
6. 按 total_score 降序取前 `top` 条。
7. `dry_run=True`：打印结果不落库，直接返回。
8. 落库（逐条）：
   ```sql
   INSERT INTO recommendations
     (rec_date, consultant, job_signal_fingerprint, job_title, company, signal_type,
      jd_text_snapshot, total_score, reasons_json, trial_candidates_json, status, weight_version)
   VALUES (CURDATE(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
   ON DUPLICATE KEY UPDATE
     total_score=VALUES(total_score), reasons_json=VALUES(reasons_json),
     trial_candidates_json=VALUES(trial_candidates_json), weight_version=VALUES(weight_version),
     jd_text_snapshot=VALUES(jd_text_snapshot)
   ```
   **禁止**在 UPDATE 子句中出现 `status`、`sent_at`（避免覆盖已采纳状态与推送记录）。JSON 列一律 `json.dumps(..., ensure_ascii=False)`。

CLI（`if __name__ == "__main__"` 或 `python -m decision.recommend`）：argparse 参数 `--consultant`（默认 `""`）、`--top`（默认 3）、`--dry-run`（flag）。

### 6.6 `ttc_daemon/decision/security.py`

```python
def make_token(rec_id: int, rec_date: str) -> str
# msg = f"{rec_id}|{rec_date}"   rec_date 为 ISO 格式 "YYYY-MM-DD"
# sig = HMAC-SHA256(env TTC_DECISION_HMAC_SECRET, msg).hexdigest()[:24]
# return f"{rec_id}.{sig}"

def verify_token(token: str) -> int
# 解析 rec_id 与 sig；从 DB 取该 rec 的 rec_date 重算签名比对（hmac.compare_digest）
# 任一失败抛 ValueError("无效token")；成功返回 rec_id
# secret 未配置 → 抛 RuntimeError("TTC_DECISION_HMAC_SECRET 未配置")
```

token 不绑定 action：action 由 POST body 传入并做白名单校验。actor 不取自客户端输入，取 `recommendations.consultant` 列。

### 6.7 `ttc_daemon/decision/push_card.py`

职责：卡片构建与推送。公开接口：

```python
def build_card(rec: dict, base_url: str, index: int, total: int) -> dict
# rec：recommendations 行（reasons_json / trial_candidates_json 已 json.loads）
# 返回 §8 的 payload dict；按钮 URL 由 make_token(rec["id"], rec["rec_date"]) 生成

def push_pending(dry_run: bool = False, force: bool = False, daily: bool = False) -> dict
# 返回 {"sent": int, "failed": int, "skipped": int}
```

`push_pending` 流程：

1. `_webhook_url()` 为 None 且非 dry_run → 打印警告并返回 `{"sent":0,...}`，**禁止抛异常**。
2. env `TTC_DECISION_BASE_URL` 未配置且非 dry_run → 同上返回（按钮无法生成）。
3. 查询：
   ```sql
   SELECT * FROM recommendations
   WHERE rec_date = CURDATE() AND status = 'pending' AND sent_at IS NULL
   ORDER BY total_score DESC
   ```
   `force=True` 时去掉 `sent_at IS NULL` 条件。
4. 无记录 → 返回 skipped。
5. `daily=True` 时先推一条摘要卡（§8.2）：调用 stats 逻辑取昨日数据；统计失败不阻塞后续推送。
6. 逐条 `_send_card(build_card(...))`：成功 → `UPDATE recommendations SET sent_at=NOW(), send_attempts=send_attempts+1, last_send_error='' WHERE id=%s`；异常 → `send_attempts+1, last_send_error=<异常摘要前200字符>`。单条失败不中断后续。
7. dry_run：构建全部卡片打印 JSON，不发请求、不写库。

CLI：`python -m decision.push_card [--dry-run] [--force] [--daily] [--rec-id N]`（`--rec-id` 只推指定一条，用于手动验证）。

### 6.8 `ttc_daemon/decision/api.py`

`router = APIRouter(prefix="/api/decision", tags=["decision"])`。端点规格见 §7.3。本文件只做参数校验与编排水，SQL 写在模块内私有函数，禁止把 SQL 写进前端或卡片代码。

---

## 7. HTTP API 规格

### 7.1 挂载方式（修改 `candidate-collector/app.py`）

在第 211 行 `app.include_router(db_admin.router)` 之后添加：

```python
import sys as _sys
_sys.path.insert(0, str(ROOT.parent / "ttc_daemon"))
from decision import api as _decision_api
app.include_router(_decision_api.router)
```

Phase 2 再加 `from workspace import api as _workspace_api; app.include_router(_workspace_api.router)`。

### 7.2 监听地址（修改 `candidate-collector/run.sh`）

`--host 127.0.0.1` 改为 `--host 0.0.0.0`。安全边界：decision 全部写接口由 HMAC token 鉴权（§6.6），weights 写接口为内网信任（MVP 接受）；禁止在公网暴露本服务，外网访问必须走 cloudflared 隧道。

### 7.3 端点清单

统一约定：JSON 请求/响应；业务错误返回对应 4xx + `{"detail": "中文原因"}`。

#### GET `/api/decision/preview?token=...`（只读，禁止任何写操作）

- 验签失败 → 401。
- 成功 → 200：
```json
{
  "rec_id": 12, "job_title": "高级Java开发", "company": "某大厂",
  "total_score": 78.5, "status": "pending",
  "dimensions": [{"name":"freshness","score":100.0,"weight":0.25,"weighted":25.0,"reason":"信号 0.5 天前活跃"}],
  "trial_candidates": [{"fingerprint":"...","name":"张三","score":82.0,"evidence":["8年Java 微服务"]}]
}
```

#### POST `/api/decision/respond`

请求：`{"token": "...", "action": "adopt" | "ignore", "ignore_reason": "可选，仅 ignore"}`

处理（严格按序）：
1. `action` 不在白名单 → 422。
2. `verify_token` 失败 → 401。
3. 查 recommendations 行，不存在 → 404。
4. `status != "pending"` → 200 `{"ok": true, "already": true, "status": <当前状态>}`，不写任何数据。
5. 写库（同一事务）：
   - `UPDATE recommendations SET status=%s, ignore_reason=%s WHERE id=%s AND status='pending'`；影响行数 = 0（并发重复）→ 按第 4 步返回。
   - `INSERT INTO adoption_events (recommendation_id, request_id, event_type, actor, detail_json)`；`request_id` = token 的 sig 部分；`actor` = 该行的 `consultant` 列；`event_type` = `"adopted"` 或 `"ignored"`。UNIQUE 冲突（`uq_request`）按幂等成功处理。
6. 成功 → 200 `{"ok": true, "already": false, "status": "adopted"}`。

#### GET `/api/decision/stats?days=7`

从 `recommendations` 按行统计（禁止从 adoption_events 计数）：

```json
{
  "days": 7, "pushed": 12, "responded": 9, "adopted": 6, "ignored": 3, "pending": 3,
  "response_rate": 0.75, "adoption_rate": 0.67,
  "by_day": [{"date": "2026-08-03", "pushed": 3, "adopted": 2, "ignored": 1}]
}
```

口径：`pushed` = sent_at 非空；`responded` = status ∈ (adopted, ignored)；`response_rate` = responded/pushed（分母 0 → null）；`adoption_rate` = adopted/(adopted+ignored)（分母 0 → null）。days 参数 clamp 到 1-90。

#### GET `/api/decision/today`

今日全部推荐（含 needs_clarification），按 total_score 降序，字段同 preview 外加 `sent_at`、`signal_type`。

#### GET `/api/decision/weights`

```json
{"version": 3, "weights": {"freshness": 0.25, ...},
 "registry": {"freshness": {"desc": "..."}, ...}}
```

#### POST `/api/decision/weights`

请求：`{"weights": {...}, "note": "...", "changed_by": "..."}`

1. weights 键集合 ≠ DIMENSION_REGISTRY 键集合 → 422 `{"detail": "维度不匹配", "unknown": [...], "missing": [...]}`（**禁止静默接受未知维度**）。
2. 值非 [0,1] 数值 → 422。
3. 权重和与 1.0 偏差 > 0.01 → 服务端归一化，响应带 `"normalized": true`。
4. version = 当前最大 version + 1，插入，`change_source="slider"`。
5. 200 `{"ok": true, "version": 4, "weights": {...}, "normalized": false}`。

---

## 8. 飞书卡片规格

### 8.1 推荐卡

payload（`_send_card` 的参数）：

```json
{
  "msg_type": "interactive",
  "card": {
    "header": {"template": "blue",
      "title": {"tag": "plain_text", "content": "📋 今日选品推荐 1/3 · 高级Java开发 @ 某大厂 · 78.5分"}},
    "elements": [
      {"tag": "div", "text": {"tag": "lark_md", "content":
        "**决策指示**\n信号新鲜度 100×0.25=25.0 · 信号 0.5 天前活跃\n薪资信息完整度 90×0.20=18.0 · 薪资 40-60k 带宽20k\n（五维各一行，格式：显示名 子分×权重=加权 · 理由）"}},
      {"tag": "hr"},
      {"tag": "div", "text": {"tag": "lark_md", "content":
        "**试单人选**\n1. 张三 82.0分 · 8年Java 微服务\n2. ...（无人选时：暂无可试单人选）"}},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"tag": "plain_text", "content": "✅ 采纳去做"},
         "type": "primary", "url": "{BASE_URL}/static/apps/brianx/confirm.html?token={token}&action=adopt"},
        {"tag": "button", "text": {"tag": "plain_text", "content": "❌ 忽略"},
         "type": "danger", "url": "{BASE_URL}/static/apps/brianx/confirm.html?token={token}&action=ignore"}
      ]},
      {"tag": "note", "elements": [{"tag": "plain_text",
        "content": "调权重: {BASE_URL}/static/apps/brianx/weights.html ｜ 面板: {BASE_URL}/static/apps/brianx/index.html"}]}
    ]
  }
}
```

今日有效信号不足 3 条时，第一张卡 header 前加一条 `{"tag":"div"...}` 注明 `今日有效岗位信号仅 N 条`。

### 8.2 昨日摘要卡（`--daily` 模式第一条）

header：`📊 昨日推荐回顾 · 2026-08-02`；body 一行：`推送 3 · 响应 2 · 采纳 1 · 忽略 1 · 采纳率 50%`（分母为 0 显示 `暂无数据`）。无按钮。

---

## 9. 前端页面规格

无框架、无构建步骤、单文件 HTML（内联 CSS/JS）。统一约定：fetch 失败时页面顶部显示红色错误条，禁止静默失败。

### 9.1 `static/apps/brianx/index.html` — 今日推荐面板

- 加载时并行请求 `GET /api/decision/today` 与 `GET /api/decision/stats?days=7`。
- 顶部统计条：推送数 / 响应率 / 采纳率。
- 推荐列表，每条卡片：标题（职位@公司·总分）、五维指示表、试单人选、状态徽章（pending 灰 / adopted 绿 / ignored 红 / needs_clarification 黄）、`采纳` `忽略` 按钮（链接同飞书卡按钮 URL 规则，token 由 today 接口返回——today 响应需包含每条 rec 的 `token` 字段，由后端 `make_token` 生成）。

### 9.2 `static/apps/brianx/confirm.html` — 确认页

- 从 URL query 读 `token`、`action`。
- onload：`GET /api/decision/preview?token=`，渲染推荐摘要（职位、公司、总分、试单人选）。
- action=ignore 时显示一个可选文本框（忽略原因）。
- 页面中央一个大确认按钮，文案：`确认采纳该推荐` / `确认忽略该推荐`。**页面加载与浏览过程禁止触发任何写请求。**
- 点击确认 → `POST /api/decision/respond` → 成功显示 `已记录：采纳 ✅`（或忽略）；`already:true` 显示 `该推荐已处理过，当前状态：xxx`；401 显示 `链接无效或已过期`。

### 9.3 `static/apps/brianx/weights.html` — 调权面板

- onload：`GET /api/decision/weights`，渲染 5 个 slider（0-100%，步进 1%），每行显示：维度中文名（registry desc）、slider、归一化后百分比。
- 任一 slider 变化 → 实时重算并显示归一化结果。
- `保存新版本` 按钮 → POST；响应 `normalized:true` 时提示 `权重已归一化`；成功后显示 `新版本 v{N} 已生效，明早推荐将使用` 并刷新当前版本号。
- 422 时展示 `detail` / `unknown` / `missing`。

### 9.4 页面通用约束

- 禁止引用外部 CDN（内网环境）；全部样式内联。
- 禁止在前端出现任何数据库凭据、webhook 地址、HMAC secret。

---

## 10. Workspace 规格（Phase 2，Phase 1 验收后启动）

### 10.1 AppManifest schema

每个 App 一份 JSON：

```json
{
  "id": "brianx",
  "name": "Brian X",
  "icon": "/static/icons/brianx.svg",
  "entry_url": "/static/apps/brianx/index.html",
  "launch_mode": "internal",
  "fallback_mode": "external",
  "allowed_origins": [],
  "permissions": ["job.read", "candidate.read", "recommendation.respond"],
  "context_types": ["job", "candidate"]
}
```

字段约束：`launch_mode` ∈ `internal | iframe | desktop_webview`（`external` 仅允许出现在 `fallback_mode`）；`entry_url` 为 internal 时是站内路径，否则为完整 URL。

### 10.2 `workspace/registry/apps.json`

数组，初始 3 项：

1. Brian X（如上，`/static/apps/brianx/app.manifest.json` 内容与之保持一致，registry 为唯一权威源）。
2. 人才库：`launch_mode: "iframe"`，`fallback_mode: "external"`，entry_url 指向既有简历库页面。
3. 飞书：`launch_mode: "iframe"`，`fallback_mode: "external"`，`entry_url: "https://www.feishu.cn/messenger/"`。

### 10.3 Shell（`static/workspace/index.html` + `shell.js`）

功能清单（只做这些）：

1. 加载 `GET /api/workspace/apps`，渲染左侧 App Dock（图标 + 名称）。
2. 点击 App → 新建标签页：顶部标签栏（标题 + 关闭按钮），内容区：
   - `internal` / `iframe` → `<iframe sandbox="allow-scripts allow-same-origin allow-forms">`，src = entry_url + context query。
   - 每个 iframe 标签页右上角固定一个 `在外部打开` 按钮（`window.open(src)`），作为嵌入失败的降级出口。
3. 上下文传递：`openApp(id, context)` 把 context 对象序列化为 URL query（如 `?candidate_id=x&job_id=y`）拼到 entry_url 后。Shell 暴露全局函数 `window.TTC = { openApp, openUrl, getContext }`；`getContext` 解析当前页 query。**本期不实现** `createTask / emitEvent / subscribeEvent / setContext / closeTab`（仅在 shell.js 注释中预留签名）。
4. 最近打开：每次打开标签记录 `{app_id, url, title, ts}` 到 localStorage 键 `ttc.workspace.recent`（上限 10 条，去重按 url），Dock 下方展示。
5. 标签页切换/关闭、iframe 刷新按钮。前进/后退不做（iframe 内导航由目标站自理）。

安全约束：`allowed_origins` 非空的 App，iframe src 的 origin 必须在列表内，否则强制 `window.open`；禁止向 iframe postMessage 发送任何凭据。

### 10.4 `ttc_daemon/workspace/api.py`

`APIRouter(prefix="/api/workspace")`，一个端点：`GET /api/workspace/apps` → 读取 `$ROOT/workspace/registry/apps.json` 原样返回（带 5 秒内存缓存）。文件不存在或 JSON 非法 → 500 + 中文错误。禁止接受任何写请求。

---

## 11. 定时任务 — `scripts/cron_brianx_daily.sh`

```bash
#!/bin/bash
# 每日 8:50 生成推荐，9:00 推送。由 crontab 触发。
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>logs/brianx_daily.lock
flock -n 9 || { echo "another instance running"; exit 0; }
set -a && source .env && set +a
export PYTHONPATH=ttc_daemon:candidate-collector
PY=candidate-collector/.venv/bin/python

# 服务健康检查：8765 不可达则拉起
if ! curl -sf -m 3 http://127.0.0.1:8765/docs >/dev/null 2>&1; then
  nohup bash candidate-collector/run.sh >>logs/app_8765.log 2>&1 &
  sleep 3
fi

$PY -m decision.recommend --consultant "${TTC_CONSULTANT:-ashley}"
$PY -m decision.push_card --daily
```

crontab（文档提供，用户自行 `crontab -e` 添加）：

```
50 8 * * * cd /Users/ashley/Downloads/ttc的交易系统 && bash scripts/cron_brianx_daily.sh >> logs/brianx_daily.log 2>&1
```

`logs/` 目录由脚本 `mkdir -p` 保证存在。

---

## 12. 开发顺序（严格按序，每步完成并测试通过后进入下一步）

**Step 0 — 数据与链路准备（前置，不写产品代码）**

1. 手动向 `job_signals` 插入 ≥5 条真实格式测试数据（signal_type 覆盖 new/heating/active/closed 各至少 1 条，closed 用于验证过滤）。
2. 执行 §5.2 migration 建表。
3. 用 1 条真实信号对 729 名候选人跑 `score_pool` 原型脚本，输出分数分布与 Top10 名单，人工判断 Top3 合理性，据此确定 `PASS_SCORE` 并写入 `trial_picker.py` 常量（注释记录校准样本与日期）。
4. 修改 run.sh 为 0.0.0.0 并重启服务；用目标手机（飞书移动端）打开 `http://<局域网IP>:8765/docs` 确认可达；不可达则改用 `cloudflared tunnel --url http://127.0.0.1:8765`，把最终地址写入 `.env` 的 `TTC_DECISION_BASE_URL`。
5. `.env` 增加 `TTC_DECISION_HMAC_SECRET`（`openssl rand -hex 32` 生成）。

**Step 1 — 纯逻辑层（不连 RDS、不发飞书）**：`_bootstrap` → `signal_scorer` → `trial_picker` → `security`，对应测试全绿。

**Step 2 — 持久化与生成**：`db.py` → `recommend.py`；`--dry-run` 输出一条真实推荐人工审核；再实跑一次落库；重复实跑验证不新增重复行。

**Step 3 — API**：`api.py` + app.py 挂载；TestClient 测试全绿；`curl` 实测六个端点。

**Step 4 — 推送**：`push_card.py`；`--dry-run` 验证卡片 JSON；配置 webhook 后 `--rec-id` 真发一条到测试群，手机渲染确认；完整跑一次 `--daily`，重跑验证不重复发卡。

**Step 5 — 前端三页**：confirm → index → weights；手机飞书内点击真实卡片按钮走通完整闭环。

**Step 6 — 定时**：cron 脚本 + crontab 行交付。

**Step 7（Phase 2）— Workspace**：apps.json → workspace/api.py → shell → Brian X 注册验证 → 人才库/飞书注册。

---

## 13. 测试规格

### 13.1 `candidate-collector/conftest.py`

```python
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for p in (str(ROOT / "candidate-collector"), str(ROOT / "ttc_daemon")):
    if p not in sys.path:
        sys.path.insert(0, p)
```

### 13.2 测试运行命令

```bash
cd $ROOT
# 单元测试（禁止触网、禁止连 RDS）
candidate-collector/.venv/bin/python -m pytest candidate-collector -m "not integration" -v
# 集成测试（连 RDS，需 source .env）
set -a && source .env && set +a && \
candidate-collector/.venv/bin/python -m pytest candidate-collector -m integration -v
```

未注册 marker 时 pytest 报 warning 可接受；如需消除，在 `candidate-collector/pytest.ini` 添加 markers 声明。

### 13.3 测试清单

| 文件 | 类型 | 必测断言 |
|---|---|---|
| `test_signal_scorer.py` | 单元 | 五维齐全且每维 reason 非空；注入 now 后结果确定；含紧急词 > 不含；cooling 总分减半；未知维度抛 ValueError |
| `test_trial_picker.py` | 单元 | ≤3 人且降序；evidence 字段存在；raw_text 过短被跳过；build_dimensions tuple 正确解包（回归 B1）；分数为 0-100 量纲（回归 B2） |
| `test_security.py` | 单元 | token 生成/验证往返；篡改 sig 抛 ValueError；篡改 rec_id 抛 ValueError；secret 缺失抛 RuntimeError（monkeypatch env） |
| `test_recommend.py` | 单元（monkeypatch DB） | closed/fake_active 信号被过滤（回归 B6）；关键词 <2 → needs_clarification；同日同信号重复执行只 upsert 一行且不覆盖 status/sent_at |
| `test_push_card.py` | 单元 | payload 含 msg_type=interactive；按钮 URL 含 token 与 action；五维 reason 全部出现在卡片文本；webhook 未配置时 push_pending 返回而非抛异常 |
| `test_decision_api.py` | 单元（TestClient + monkeypatch get_conn） | preview 无写操作（回归 B4）；POST adopt 后 status 变更且事件落库；重复 POST 返回 already:true 且不新增事件（回归 B5）；stats 分母为 0 时比率为 null；未知维度调权 422 |
| `test_decision_db.py` | **integration** | 执行 migration 后三表存在 |

---

## 14. 验收标准（逐条勾选，全部通过才算交付）

**Phase 1**
1. 一条真实有效信号生成有证据的 Top3，人工判断人选合理。
2. 同日重复执行 recommend 不新增推荐行；已采纳推荐不被重新生成覆盖状态。
3. 重跑 push_card 不重复发卡；webhook 故障时 last_send_error 有记录且进程退出码正常。
4. 手机飞书点击卡片按钮 → confirm 页正常渲染 → 确认前查库无任何写入 → 点击确认后 status 与事件各更新一次。
5. 同一链接重复确认，第二次返回 already:true，事件表仍只有一条。
6. signal_type 为 closed / fake_active 的信号不出现在 recommendations。
7. stats 接口同时返回响应率与采纳率，数值与手工 SQL 核对一致。
8. POST weights 产生 version+1；旧推荐的 weight_version 不变；含未知维度的请求返回 422。
9. `job_signals` 只有 1 条有效信号时，只推 1 张卡且卡片注明信号量不足。
10. RDS 连接失败时 recommend/push_card 打印明确错误并非零退出，无假成功。

**Phase 2**
11. `GET /api/workspace/apps` 返回 3 个 App；Shell 左侧 Dock 渲染完整。
12. Brian X 在 Shell 内以 internal 模式打开，功能与直接访问一致。
13. 飞书 App 嵌入失败时可一键 `在外部打开`。
14. 最近打开列表正确记录且去重。

---

## 15. 明确不做（本期范围外，禁止顺手实现）

- 飞书应用机器人按钮回调（webhook 收不到回调，URL 按钮是定案）
- 自然语言调权、动态新增打分维度
- `client_history` 真实数据（恒 50）
- 试单结果追踪（started/successful/failed，下一轮）
- App Bridge 的 `createTask / emitEvent / subscribeEvent`
- 分屏、多窗口、任意网址输入、浏览器扩展、Electron
- 用户登录体系（weights 写接口内网信任）
- 数据库 migration 回滚脚本（出错 DROP 三表重建）

---

## 16. 已知坑清单（违反任意一条必然返工）

1. `build_dimensions()` 返回 tuple，必须 `dims, _ = build_dimensions(...)`。
2. 总分用 `ds.weighted` 求和（0-100），禁止 `ds.score * dim.weight`。
3. `score_resume()` 返回 0-10 分制且短文本抛异常，本系统不用它。
4. pymysql 写 JSON 列前必须 `json.dumps`。
5. MySQL 无 `ILIKE` / `CREATE INDEX IF NOT EXISTS` / `NULLS LAST` / `ADD COLUMN IF NOT EXISTS`。
6. `candidate-collector` 目录名含连字符，靠 `_bootstrap.py` / conftest / PYTHONPATH 解决导入，禁止尝试把它改成合法包名（影响面超出本期）。
7. GET 请求禁止产生任何数据库写入。
8. 统计指标只从 `recommendations` 行状态计算，`adoption_events` 仅作审计。
9. upsert recommendations 时禁止更新 `status` 与 `sent_at` 列。
10. 任何密钥只读环境变量；`ttc_daemon/config.py:66` 的硬编码 token 是反例，禁止模仿。

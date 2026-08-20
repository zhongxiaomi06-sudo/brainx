# Braintex — Brian X 决策工作台（独立项目）

> 2026-08-04 从 `jiands233/ttc-ai-recruiting-workflow` 分支 `feature/brianx-workspace`
> （commit be7832f）拆出的独立项目。设计见
> [docs/2026-08-03-brianx-workspace-design.md](docs/2026-08-03-brianx-workspace-design.md)、
> [docs/2026-08-03-brianx-mvp.md](docs/2026-08-03-brianx-mvp.md)。

## 组成

- `decision/` — 决策工作流核心：JD 归一化与推荐（recommend）、信号打分（signal_scorer）、
  试用池挑选（trial_picker）、飞书卡片推送（push_card）、权重/反馈 API（api）、
  token 安全（security）、RDS 存取（db + schema.sql）
- `cloud_sync/` — RDS 连接（client/config，decision.db 惰性依赖；凭据走环境变量，不落库）
- `static/` — 工作台前端：apps/brianx（index/confirm/weights + manifest）、workspace shell、icons
- `scripts/` — cron 日推（cron_brianx_daily.sh）、schema 迁移（migrate_decision_schema.py）
- `tests/` — 7 个单元测试（全自包含，不依赖真实 RDS/飞书）

## 运行

```bash
uv venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest tests/ -q          # 单元测试
# API 挂载：decision.api 是 FastAPI APIRouter（prefix /api/decision），
# 可挂到任意 FastAPI app；schema 用 scripts/migrate_decision_schema.py 应用到 RDS。
```

## 与兄弟项目的边界

- **Reloop**（人才库，~/Downloads/reloop）：候选人数据的唯一真相源（cloud_candidates）。
  Braintex 只读其 RDS 数据做推荐/决策，不写候选人。
- `ttc_daemon`：原宿主；feishu_bot 通知与 static/index.html 的 XSS 加固属各自项目，未带入。

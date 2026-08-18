#!/usr/bin/env bash
# braintex 工作台启动器：加载本机 .env 后起 FastAPI（默认 127.0.0.1:8766）。
# 工作台里有「飞书连接」页：一键授权 lark-cli → 自动采集你的驾驶舱群信号入共享库。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
export PYTHONPATH="$ROOT"
PORT="${TTC_BRAINTEX_PORT:-8766}"
exec "$ROOT/.venv/bin/python" -m uvicorn decision.app:app --host 127.0.0.1 --port "$PORT"

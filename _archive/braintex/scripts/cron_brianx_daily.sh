#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
if command -v flock >/dev/null 2>&1; then
  exec 9>logs/brianx_daily.lock
  flock -n 9 || { echo "another instance running"; exit 0; }
else
  LOCK_DIR=logs/brianx_daily.lockdir
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "another instance running"
    exit 0
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
fi
set -a
source .env
set +a
export PYTHONPATH=ttc_daemon:candidate-collector
PY="${TTC_PYTHON:-python3.12}"
if [ -z "${TTC_PYTHON:-}" ] && [ -x candidate-collector/.venv/bin/python ]; then
  PY=candidate-collector/.venv/bin/python
fi

if ! curl -sf -m 3 http://127.0.0.1:8765/docs >/dev/null 2>&1; then
  nohup bash candidate-collector/run.sh >>logs/app_8765.log 2>&1 &
  sleep 3
fi

"$PY" -m decision.recommend --consultant "${TTC_CONSULTANT:-ashley}"
"$PY" -m decision.push_card --daily

#!/usr/bin/env bash
# braintex MCP server 启动包装：加载本地 .env 后启动 stdio 服务。
# Codex/Claude/OpenCode 的 MCP 注册指向本脚本——密钥只落在 .env（chmod 600），不进任何配置文件。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$ROOT/.env" ]; then
  echo "braintex-mcp: 缺少 $ROOT/.env（先运行 install.sh）" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a
export PYTHONPATH="$ROOT"
exec "$ROOT/.venv/bin/python" -m decision.mcp_server

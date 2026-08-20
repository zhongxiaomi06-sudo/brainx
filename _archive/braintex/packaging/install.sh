#!/usr/bin/env bash
# braintex-mcp 一键安装：venv + 依赖 + .env + 注册 Codex MCP。
#
# 用法：
#   ./install.sh                          # 交互式安装到 ~/.braintex-mcp 并注册 Codex
#   ./install.sh --dir /opt/braintex-mcp  # 自定义安装目录
#   ./install.sh --env-file ./my.env      # 直接复用已有 .env（非交互）
#   ./install.sh --no-register            # 只装文件，不写 Codex 配置
#   ./install.sh --also-claude            # 同时注册 Claude Code（~/.claude.json）
#   ./install.sh --also-opencode          # 同时注册 OpenCode（opencode.json）
#
# 非交互模式：预置以下环境变量后运行即可（不再询问）：
#   RDS_HOST RDS_USER RDS_PASSWORD TTC_DECISION_MCP_TOKEN（RDS_PORT/RDS_DB 有默认值）
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.braintex-mcp"
ENV_FILE=""
DO_REGISTER=1
ALSO_CLAUDE=0
ALSO_OPENCODE=0
CODEX_CONFIG="$HOME/.codex/config.toml"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --no-register) DO_REGISTER=0; shift ;;
    --also-claude) ALSO_CLAUDE=1; shift ;;
    --also-opencode) ALSO_OPENCODE=1; shift ;;
    --codex-config) CODEX_CONFIG="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

echo "==> braintex-mcp 安装到 $INSTALL_DIR"

# 1) 拷贝运行文件
mkdir -p "$INSTALL_DIR"
cp -R "$PKG_DIR/decision" "$INSTALL_DIR/decision"
find "$INSTALL_DIR/decision" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
cp "$PKG_DIR/requirements.txt" "$INSTALL_DIR/requirements.txt"
cp -R "$PKG_DIR/static" "$INSTALL_DIR/static"
mkdir -p "$INSTALL_DIR/bin"
cp "$PKG_DIR/bin/braintex-mcp.sh" "$INSTALL_DIR/bin/braintex-mcp.sh"
cp "$PKG_DIR/bin/braintex-web.sh" "$INSTALL_DIR/bin/braintex-web.sh"
chmod +x "$INSTALL_DIR/bin/braintex-mcp.sh" "$INSTALL_DIR/bin/braintex-web.sh"

# 2) Python venv + 依赖
PY="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3 || true)"
[ -n "$PY" ] || { echo "未找到 python3（需要 3.10+）" >&2; exit 1; }
PYVER="$("$PY" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
PYMAJOR="${PYVER%%.*}"; PYMINOR="${PYVER##*.}"
if [ "$PYMAJOR" -lt 3 ] || { [ "$PYMAJOR" -eq 3 ] && [ "$PYMINOR" -lt 10 ]; }; then
  echo "python $PYVER 过低，需要 3.10+" >&2; exit 1
fi
echo "==> 使用 $PY ($PYVER) 创建 venv"
if [ ! -x "$INSTALL_DIR/.venv/bin/python" ]; then
  "$PY" -m venv "$INSTALL_DIR/.venv"
fi
"$INSTALL_DIR/.venv/bin/pip" install -q --upgrade pip
"$INSTALL_DIR/.venv/bin/pip" install -q -r "$INSTALL_DIR/requirements.txt"

# 3) .env（密钥只落这里，chmod 600）
#    自动发现：本机已有 TTC 检出（有 TTC 账号的同事）→ 直接复用其 RDS 连接信息；
#    MCP 令牌是本机凭证（每台机器各自校验自己的 server 进程），缺省自动生成，
#    全程零密钥交付——不需要向发包人索取任何东西。
read_env_key() { grep "^$1=" "$2" 2>/dev/null | head -1 | cut -d= -f2-; }

discover_ttc_env() {
  local c
  for c in "${TTC_ENV:-}" "$HOME/Downloads/ttc的交易系统/.env" \
           "$HOME"/Downloads/ttc*/.env "$HOME"/Documents/ttc*/.env "$HOME"/ttc*/.env; do
    if [ -n "$c" ] && [ -f "$c" ] && grep -q '^RDS_PASSWORD=' "$c" 2>/dev/null; then
      printf '%s' "$c"; return 0
    fi
  done
  return 1
}

if [ -n "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$INSTALL_DIR/.env"
elif [ ! -f "$INSTALL_DIR/.env" ]; then
  DISCOVERED="$(discover_ttc_env || true)"
  if [ -n "$DISCOVERED" ]; then
    echo "==> 发现本机 TTC 环境: $DISCOVERED（自动复用 RDS 连接信息）"
    : "${RDS_HOST:=$(read_env_key RDS_HOST "$DISCOVERED")}"
    : "${RDS_PORT:=$(read_env_key RDS_PORT "$DISCOVERED")}"
    : "${RDS_DB:=$(read_env_key RDS_DB "$DISCOVERED")}"
    : "${RDS_USER:=$(read_env_key RDS_USER "$DISCOVERED")}"
    : "${RDS_PASSWORD:=$(read_env_key RDS_PASSWORD "$DISCOVERED")}"
    : "${TTC_DECISION_MCP_TOKEN:=$(read_env_key TTC_DECISION_MCP_TOKEN "$DISCOVERED")}"
  fi
  : "${RDS_HOST:=ttc-rds-public-0707.mysql.rds.aliyuncs.com}"
  : "${RDS_PORT:=3306}"
  : "${RDS_DB:=ttc_talent}"
  : "${RDS_USER:=ttc_sync}"
  if [ -z "${RDS_PASSWORD:-}" ]; then
    echo "==> 未发现本机 TTC 环境，需要手动提供 RDS 密码（向部署发起方索取）"
    printf 'RDS 密码: '; read -rs RDS_PASSWORD; echo
  fi
  if [ -z "${TTC_DECISION_MCP_TOKEN:-}" ]; then
    TTC_DECISION_MCP_TOKEN="$("$INSTALL_DIR/.venv/bin/python" -c 'import secrets; print(secrets.token_hex(32))')"
    echo "==> 已自动生成本机 MCP 令牌（写入 .env；agent 调用工具时读 $INSTALL_DIR/.env 获取）"
  fi
  {
    echo "RDS_HOST=$RDS_HOST"
    echo "RDS_PORT=$RDS_PORT"
    echo "RDS_DB=$RDS_DB"
    echo "RDS_USER=$RDS_USER"
    echo "RDS_PASSWORD=$RDS_PASSWORD"
    echo "TTC_DECISION_MCP_TOKEN=$TTC_DECISION_MCP_TOKEN"
  } > "$INSTALL_DIR/.env"
else
  echo "==> 复用已有 $INSTALL_DIR/.env"
fi
chmod 600 "$INSTALL_DIR/.env"

# 4) 自检：导入 + 鉴权 + 真库读取
echo "==> 自检（连接 RDS + 强制鉴权）"
set -a; . "$INSTALL_DIR/.env"; set +a
PYTHONPATH="$INSTALL_DIR" "$INSTALL_DIR/.venv/bin/python" - <<'PY'
import os
from decision import mcp_server as m
token = os.environ.get("TTC_DECISION_MCP_TOKEN", "")
bad = m.decision_engagements(token="wrong", actor="install-check")
assert bad.get("code") == "auth_failed", f"鉴权未生效: {bad}"
ok = m.decision_engagements(token=token, actor="install-check")
assert ok.get("ok"), f"读取失败: {ok}"
print(f"    鉴权拦截 ✓  RDS 读取 ✓（watch_cap={ok.get('watch_cap')}）")
PY

# 5) 注册 Codex MCP（幂等）
WRAPPER="$INSTALL_DIR/bin/braintex-mcp.sh"
register_codex() {
  mkdir -p "$(dirname "$CODEX_CONFIG")"
  touch "$CODEX_CONFIG"
  if grep -q '^\[mcp_servers\.braintex\]' "$CODEX_CONFIG"; then
    echo "==> Codex 配置已存在 [mcp_servers.braintex]，跳过"
    return
  fi
  {
    echo ""
    echo "[mcp_servers.braintex]"
    echo "command = \"$WRAPPER\""
    echo "startup_timeout_sec = 30.0"
  } >> "$CODEX_CONFIG"
  echo "==> 已写入 $CODEX_CONFIG"
}
[ "$DO_REGISTER" -eq 1 ] && register_codex

# 6) 可选：Claude Code / OpenCode
if [ "$ALSO_CLAUDE" -eq 1 ] || [ "$ALSO_OPENCODE" -eq 1 ]; then
  ALSO_CLAUDE="$ALSO_CLAUDE" ALSO_OPENCODE="$ALSO_OPENCODE" WRAPPER="$WRAPPER" \
  "$INSTALL_DIR/.venv/bin/python" - <<'PY'
import json, os, pathlib
wrapper = os.environ["WRAPPER"]
home = pathlib.Path.home()
if os.environ.get("ALSO_CLAUDE") == "1":
    p = home / ".claude.json"
    cfg = json.loads(p.read_text()) if p.exists() else {}
    cfg.setdefault("mcpServers", {})["braintex"] = {"type": "stdio", "command": wrapper}
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
    print(f"==> 已注册 Claude Code: {p}")
if os.environ.get("ALSO_OPENCODE") == "1":
    p = home / ".config" / "opencode" / "opencode.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    cfg = json.loads(p.read_text()) if p.exists() else {}
    cfg.setdefault("mcp", {})["braintex"] = {
        "type": "local", "command": [wrapper], "enabled": True}
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
    print(f"==> 已注册 OpenCode: {p}")
PY
fi

# 7) 飞书连接前置检查（非阻塞）：没有 lark-cli 只提示，不装也能用决策功能
if command -v lark-cli >/dev/null 2>&1; then
  echo "==> lark-cli 已安装：工作台「飞书连接」页可一键授权接入你的驾驶舱群"
else
  echo "!! 未检测到 lark-cli：想接入自己的驾驶舱信号，先装 lark-cli（问发包人要安装方式）"
fi

echo ""
echo "✅ 安装完成。重启 Codex 后即可用自然语言操作 braintex，例如："
echo "   「看看我今天的推荐」「把 xx 岗位加入关注」「这个岗位供给怎么样」「面试过了记一下」"
echo "   agent 调用工具需要的 token 在 $INSTALL_DIR/.env 的 TTC_DECISION_MCP_TOKEN"
echo ""
echo "🖥  工作台（含「飞书连接」按钮，接入你自己的驾驶舱 → 共享库）："
echo "   $INSTALL_DIR/bin/braintex-web.sh"
echo "   然后浏览器打开 http://127.0.0.1:8766/static/apps/brianx/feishu.html"
echo ""
echo "   卸载：rm -rf \"$INSTALL_DIR\" 并删除 $CODEX_CONFIG 里的 [mcp_servers.braintex] 段"

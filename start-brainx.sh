#!/usr/bin/env bash
# Brain X Workbench one-click launcher (run via Git Bash).
# Usage: double-click start-brainx.bat, or run this script from Git Bash.
set -u

# 切到脚本所在目录（用纯内建展开，不依赖 dirname，因为此时 PATH 可能不全）
case "$0" in
  */*) SCRIPT_DIR="${0%/*}" ;;
  *)   SCRIPT_DIR="$PWD" ;;
esac
cd "$SCRIPT_DIR" || exit 1

echo "== Brain X Workbench launcher =="
echo "Project dir: $(pwd)"
echo

# ---------------------------------------------------------------------------
# 双击 .bat 时，系统 PATH 里通常只有 node/npm，没有 Git 的 usr/bin|bin。
# 这两个目录提供 dirname、bash（npm 脚本 shebang 需要）、sleep、seq 等核心工具。
# 必须在最早阶段、且只用品内建（不调用任何外部命令）把它们加进 PATH，
# 否则后续 dirname / npm 都会报 command not found。
# ---------------------------------------------------------------------------
add_git_bins() {
  local b bindir d p
  # 脚本正由某个 bash 执行，$BASH 即其绝对路径——最可靠，优先用它反推 usr/bin。
  if [ -n "${BASH:-}" ] && [ -x "$BASH" ]; then
    b="$BASH"
  elif [ -n "${GIT_BASH_EXE:-}" ] && [ -x "$GIT_BASH_EXE" ]; then
    b="$GIT_BASH_EXE"
  else
    # 兜底：按常见安装位置搜索 bash.exe
    local candidates=(
      "/c/Program Files/Git/bin/bash.exe"
      "/c/Program Files/Git/usr/bin/bash.exe"
      "/c/Program Files (x86)/Git/bin/bash.exe"
      "$HOME/AppData/Local/Programs/Git/bin/bash.exe"
      "$HOME/scoop/apps/git/current/bin/bash.exe"
      "/c/tools/Git/bin/bash.exe"
    )
    for d in "${candidates[@]}"; do
      if [ -x "$d" ]; then b="$d"; break; fi
    done
  fi
  [ -z "${b:-}" ] && return
  bindir="${b%/*}"                                   # 纯内建，等价于 dirname
  # 无论 bash 在 bin 还是 usr/bin，把 bin、../bin、../usr/bin 都加上，
  # 确保 dirname 以及 npm shebang 需要的 msys bash 都在 PATH 上。
  for d in "$bindir" "$bindir/../bin" "$bindir/../usr/bin"; do
    p="$(cd "$d" 2>/dev/null && pwd)"
    [ -z "$p" ] && continue
    case ":$PATH:" in *":$p:"*) ;; *) PATH="$p:$PATH" ;; esac
  done
}
add_git_bins

# ---------------------------------------------------------------------------
# 关键：让 npm 用 bash 执行脚本，而不是 Windows 的 cmd.exe。
# 否则 `npm run build` / `npm run start`（server.js 拉前端也是它）会报
# 'WRANGLER_LOG_PATH' 不是内部或外部命令——因为 cmd 不认识 `VAR=value cmd` 的 Unix 语法。
# 把当前 bash 的绝对路径（转成 Windows 格式）设给 npm 的 script-shell 即可。
# ---------------------------------------------------------------------------
if [ -n "${BASH:-}" ]; then
  if command -v cygpath >/dev/null 2>&1; then
    export npm_config_script_shell="$(cygpath -w "$BASH")"
  else
    export npm_config_script_shell="$BASH"
  fi
  echo "npm script-shell: $npm_config_script_shell"
fi

# ---------------------------------------------------------------------------
# 非交互式 bash 可能仍缺少 node/npm（视机器而定），主动补上常见安装目录。
# ---------------------------------------------------------------------------
ensure_on_path() {
  local name="$1"; shift
  if command -v "$name" >/dev/null 2>&1; then return 0; fi
  for d in "$@"; do
    if [ -x "$d/$name" ] || [ -x "$d/${name}.exe" ]; then
      export PATH="$d:$PATH"; return 0
    fi
  done
  return 1
}

NODE_DIRS=(
  "/c/Program Files/nodejs"
  "/c/Program Files (x86)/nodejs"
  "$HOME/scoop/apps/nodejs/current"
  "$HOME/AppData/Roaming/npm"
  "$HOME/.workbuddy/binaries/node/versions/22.22.2"
  "/d/AI中医药开发"
)
NPM_DIRS=(
  "/c/Program Files/nodejs"
  "/c/Program Files (x86)/nodejs"
  "$HOME/scoop/apps/nodejs/current"
  "$HOME/AppData/Roaming/npm"
  "$HOME/.workbuddy/binaries/node/versions/22.22.2"
  "/d/AI中医药开发"
)

fail() {
  echo "ERROR: $1"
  read -r -p "按回车关闭窗口..." _ || true
  exit 1
}

ensure_on_path node "${NODE_DIRS[@]}" || fail "找不到 node，请确认已安装 Node.js 并加入 PATH。"
ensure_on_path npm  "${NPM_DIRS[@]}"  || fail "找不到 npm（node 已找到，但同目录没有 npm）。"

echo "Using node: $(command -v node)"
echo "Using npm : $(command -v npm)"
echo

APP_PORT="${BRAINX_PORT:-3000}"

# 1) Backend dependencies
if [ ! -d node_modules ]; then
  echo "[1/4] Installing backend deps (npm install) ..."
  npm install || fail "npm install 失败"
else
  echo "[1/4] Backend deps present, skipping"
fi

# 2) Frontend dependencies
if [ ! -d frontend/btex-frontend/node_modules ]; then
  echo "[2/4] Installing frontend deps (can take a few minutes) ..."
  npm --prefix frontend/btex-frontend install || fail "前端 npm install 失败"
else
  echo "[2/4] Frontend deps present, skipping"
fi

# 3) Frontend production build (server.js serves this via vinext start)
if [ ! -d frontend/btex-frontend/.next ] && [ ! -d frontend/btex-frontend/dist ]; then
  echo "[3/4] Building frontend (vinext build) ..."
  npm --prefix frontend/btex-frontend run build || fail "前端 build 失败"
else
  echo "[3/4] Frontend already built, skipping"
fi

# 4) Start server (foreground) and open the browser once the port answers.
echo "[4/4] Starting server: node src/server.js"
echo "App: http://localhost:${APP_PORT}   (按 Ctrl+C 停止)"
echo

# 端口就绪后自动开浏览器（后台子 shell，不阻塞 node 前台运行）
( for i in $(seq 1 60); do
    if (exec 3<>/dev/tcp/127.0.0.1/${APP_PORT}) 2>/dev/null; then
      exec 3>&- 3<&-
      sleep 1
      powershell.exe -NoProfile -Command "Start-Process 'http://localhost:${APP_PORT}'" >/dev/null 2>&1 \
        || cmd.exe //c start "" "http://localhost:${APP_PORT}" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
  done ) &

node src/server.js
NODE_EXIT=$?
echo
echo "=== node 已退出 (exit=$NODE_EXIT) ==="
read -r -p "按回车关闭窗口..." _ || true

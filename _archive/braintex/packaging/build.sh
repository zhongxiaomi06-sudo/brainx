#!/usr/bin/env bash
# 构建 braintex-mcp 分发包：把 decision/ 运行时代码 + 安装器打成 tar.gz。
# 用法：bash packaging/build.sh [版本号]（默认 1.0.0）
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-1.0.0}"
PKG="braintex-mcp-$VERSION"
STAGE="$(mktemp -d)/$PKG"

mkdir -p "$STAGE/bin"
cp -R "$REPO_ROOT/decision" "$STAGE/decision"
cp -R "$REPO_ROOT/static" "$STAGE/static"
find "$STAGE/decision" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
cp "$REPO_ROOT/packaging/install.sh" "$STAGE/install.sh"
cp "$REPO_ROOT/packaging/requirements.txt" "$STAGE/requirements.txt"
cp "$REPO_ROOT/packaging/README.md" "$STAGE/README.md"
cp "$REPO_ROOT/packaging/.env.example" "$STAGE/.env.example"
cp "$REPO_ROOT/packaging/bin/braintex-mcp.sh" "$STAGE/bin/braintex-mcp.sh"
cp "$REPO_ROOT/packaging/bin/braintex-web.sh" "$STAGE/bin/braintex-web.sh"
chmod +x "$STAGE/install.sh" "$STAGE/bin/braintex-mcp.sh" "$STAGE/bin/braintex-web.sh"

OUT="$REPO_ROOT/dist"
mkdir -p "$OUT"
tar -czf "$OUT/$PKG.tar.gz" -C "$(dirname "$STAGE")" "$PKG"
echo "$OUT/$PKG.tar.gz"

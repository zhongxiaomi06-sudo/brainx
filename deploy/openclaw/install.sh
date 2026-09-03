#!/usr/bin/env bash
set -euo pipefail

BRAINX_DEPLOY_ROOT=${BRAINX_DEPLOY_ROOT:-/opt/brainx}
BRAINX_OPENCLAW_STATE=${BRAINX_OPENCLAW_STATE:-/var/lib/brainx/.openclaw}
BRAINX_OPENCLAW_BIN=${BRAINX_OPENCLAW_BIN:-/usr/local/bin/openclaw}
BRAINX_INSTALL_MODE=${1:---check}

if [[ "$BRAINX_INSTALL_MODE" != "--check" && "$BRAINX_INSTALL_MODE" != "--apply" ]]; then
  echo "usage: sudo deploy/openclaw/install.sh [--check|--apply]" >&2
  exit 64
fi

for required in node npm "$BRAINX_OPENCLAW_BIN"; do
  command -v "$required" >/dev/null || { echo "missing command: $required" >&2; exit 69; }
done

OPENCLAW_ACTUAL_VERSION=$($BRAINX_OPENCLAW_BIN --version)
[[ "$OPENCLAW_ACTUAL_VERSION" == *"2026.7.1-2"* ]] || {
  echo "OpenClaw 2026.7.1-2 required; found: $OPENCLAW_ACTUAL_VERSION" >&2
  exit 65
}

for required_file in \
  "$BRAINX_DEPLOY_ROOT/deploy/openclaw/openclaw.production.json" \
  "$BRAINX_DEPLOY_ROOT/deploy/openclaw/brainx-agent.env.example" \
  "$BRAINX_DEPLOY_ROOT/deploy/openclaw/brainx-worker.env.example" \
  "$BRAINX_DEPLOY_ROOT/deploy/openclaw/openclaw.env.example" \
  "$BRAINX_DEPLOY_ROOT/plugins/brainx-openclaw/package.json" \
  "$BRAINX_DEPLOY_ROOT/deploy/systemd/brainx-agent-gateway.service" \
  "$BRAINX_DEPLOY_ROOT/deploy/systemd/brainx-integration-worker.service" \
  "$BRAINX_DEPLOY_ROOT/deploy/systemd/openclaw-brainx.service"; do
  [[ -f "$required_file" ]] || { echo "missing file: $required_file" >&2; exit 66; }
done

if [[ "$BRAINX_INSTALL_MODE" == "--check" ]]; then
  echo "preflight passed; rerun with --apply, then fill /etc/brainx/*.env before starting services"
  exit 0
fi

[[ $(id -u) -eq 0 ]] || { echo "--apply requires root" >&2; exit 77; }
id brainx >/dev/null 2>&1 || useradd --system --home-dir /var/lib/brainx --create-home brainx
install -d -m 0750 -o brainx -g brainx /etc/brainx "$BRAINX_OPENCLAW_STATE" "$BRAINX_DEPLOY_ROOT/data"
install -d -m 0755 -o brainx -g brainx /var/lib/brainx/.npm # brainx 首次 npm 写缓存 EACCES（2026-09-03 实证）

install_env() {
  local env_source=$1
  local env_target=$2
  if [[ ! -f "$env_target" ]]; then
    install -m 0640 -o root -g brainx "$env_source" "$env_target"
    echo "created $env_target; replace every placeholder before starting services" >&2
  fi
}

install_env "$BRAINX_DEPLOY_ROOT/deploy/openclaw/brainx-agent.env.example" /etc/brainx/agent.env
install_env "$BRAINX_DEPLOY_ROOT/deploy/openclaw/brainx-worker.env.example" /etc/brainx/worker.env
install_env "$BRAINX_DEPLOY_ROOT/deploy/openclaw/openclaw.env.example" /etc/brainx/openclaw.env

install -m 0640 -o brainx -g brainx "$BRAINX_DEPLOY_ROOT/deploy/openclaw/openclaw.production.json" "$BRAINX_OPENCLAW_STATE/openclaw.json"
install -m 0644 "$BRAINX_DEPLOY_ROOT/deploy/systemd/"*.service /etc/systemd/system/

BRAINX_PLUGIN_TMP=$(mktemp -d /tmp/brainx-openclaw.XXXXXX)
trap 'rm -rf -- "$BRAINX_PLUGIN_TMP"' EXIT
npm pack "$BRAINX_DEPLOY_ROOT/./plugins/brainx-openclaw" --pack-destination "$BRAINX_PLUGIN_TMP" >/dev/null
BRAINX_PLUGIN_ARCHIVE="$BRAINX_PLUGIN_TMP/brainx-openclaw-plugin-1.0.0.tgz"
[[ -f "$BRAINX_PLUGIN_ARCHIVE" ]] || { echo "plugin package missing" >&2; exit 70; }
install_plugin() {
  local plugin_spec=$1
  shift
  sudo -u brainx env \
    HOME=/var/lib/brainx \
    OPENCLAW_CONFIG_PATH="$BRAINX_OPENCLAW_STATE/openclaw.json" \
    OPENCLAW_STATE_DIR="$BRAINX_OPENCLAW_STATE" \
    "$BRAINX_OPENCLAW_BIN" plugins install --force "$@" "$plugin_spec"
}

install_plugin @openclaw/feishu@2026.7.1 --pin
install_plugin "$BRAINX_PLUGIN_ARCHIVE"
systemctl daemon-reload
echo "installed; fill /etc/brainx/*.env, then validate and enable services per runbook"

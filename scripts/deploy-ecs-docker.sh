#!/usr/bin/env bash
# deploy-ecs-docker.sh — 在 ECS 上「干净替换」部署 BrainX（Docker 单容器）。
#
# 干什么：
#   1) 拉最新代码（git pull，或首次 clone）
#   2) 构建新镜像 brainx:latest
#   3) 停掉并删除旧容器（旧代码/旧进程随之清除，环境隔离）
#   4) 以持久化 data 卷 + .env 注入的方式启动新容器
#
# 用法（在 ECS 上）：
#   git clone https://github.com/zhongxiaomi06-sudo/brainx.git /opt/brainx   # 首次
#   cd /opt/brainx && cp .env.example .env && vi .env                        # 填凭证
#   bash scripts/deploy-ecs-docker.sh
#
# 依赖：ECS 已装 docker、git。
set -euo pipefail

APP_NAME="${APP_NAME:-brainx}"
IMAGE="${IMAGE:-brainx:latest}"
HOST_PORT="${HOST_PORT:-3000}"      # 对外端口（可改 80）
CONTAINER_PORT=3000
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_VOL="${DATA_VOL:-brainx-data}" # 持久化 SQLite（data/brainx.db）

log(){ printf '\033[36m[deploy-ecs]\033[0m %s\n' "$*"; }

cd "$REPO_DIR"

# —— 0) 安全检查：必须有 .env，且 .env 不能进 git —— #
if [ ! -f .env ]; then
  echo "❌ 缺少 .env。请先 cp .env.example .env 并填入凭证（数据库/飞书/TTC/LLM）。"
  exit 1
fi

# —— 1) 拉最新代码 —— #
if [ -d .git ]; then
  log "拉取最新代码（git pull）…"
  git fetch origin main && git reset --hard origin/main
else
  log "非 git 目录，跳过拉取（假定代码已就位）。"
fi
log "当前提交：$(git rev-parse --short HEAD 2>/dev/null || echo 未知)"

# —— 2) 构建新镜像 —— #
log "构建镜像 $IMAGE …"
docker build -t "$IMAGE" .

# —— 3) 停并删旧容器（干净替换）—— #
if docker ps -a --format '{{.Names}}' | grep -qx "$APP_NAME"; then
  log "停止并删除旧容器 $APP_NAME …"
  docker rm -f "$APP_NAME" >/dev/null
fi

# —— 4) 起新容器（持久化 data 卷 + .env 注入 + 自动重启）—— #
docker volume create "$DATA_VOL" >/dev/null 2>&1 || true
log "启动新容器 $APP_NAME（端口 $HOST_PORT → $CONTAINER_PORT）…"
docker run -d \
  --name "$APP_NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  --env-file .env \
  -v "${DATA_VOL}:/app/data" \
  "$IMAGE"

# —— 5) 健康检查 —— #
log "等待服务就绪…"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/" --max-time 5 || echo 000)
  if [ "$code" = "200" ]; then log "✅ 服务已就绪：http://<ECS_IP>:${HOST_PORT}/"; break; fi
  sleep 3
  [ "$i" = "20" ] && { log "⚠️ 健康检查未通过（HTTP $code）。查日志：docker logs $APP_NAME"; }
done

# —— 6) 清理悬空镜像（回收旧镜像层，释放磁盘）—— #
log "清理悬空镜像…"
docker image prune -f >/dev/null 2>&1 || true
log "完成。查看日志：docker logs -f $APP_NAME"

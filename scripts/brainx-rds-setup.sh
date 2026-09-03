#!/usr/bin/env bash
# brainx-rds-setup.sh — RDS 接入预置（2026-09-03）。
# 用法（在服务器上执行，紧跟密码参数）：
#   bash scripts/brainx-rds-setup.sh --user brainx_agent_readonly --password '你的密码' [--database brainx_talent]
# 行为：把 MySQL 段写入 /etc/brainx/agent.env 与 /opt/brainx/.env（占位不存在才追加），
# 然后跑连通性自检（pingMysql）与 candidate_shortlist 真实调用冒烟。
set -euo pipefail

USER_NAME=""
PASSWORD=""
DATABASE="brainx_talent"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2;;
    --password) PASSWORD="$2"; shift 2;;
    --database) DATABASE="$2"; shift 2;;
    *) echo "未知参数: $1" >&2; exit 64;;
  esac
done
[[ -n "$USER_NAME" && -n "$PASSWORD" ]] || { echo "缺 --user/--password" >&2; exit 64; }

HOST="${BRAINX_RDS_HOST:-ttc-rds-public-0707.mysql.rds.aliyuncs.com}"
append_kv() {
  local file="$1" key="$2" value="$3"
  grep -q "^${key}=" "$file" 2>/dev/null && sed -i "s|^${key}=.*|${key}=${value}|" "$file" || echo "${key}=${value}" >> "$file"
}
for ENV_FILE in /etc/brainx/agent.env /opt/brainx/.env; do
  append_kv "$ENV_FILE" BRAINX_MYSQL_HOST "$HOST"
  append_kv "$ENV_FILE" BRAINX_MYSQL_PORT 3306
  append_kv "$ENV_FILE" BRAINX_MYSQL_USER "$USER_NAME"
  append_kv "$ENV_FILE" BRAINX_MYSQL_PASSWORD "$PASSWORD"
  append_kv "$ENV_FILE" BRAINX_MYSQL_DATABASE "$DATABASE"
  append_kv "$ENV_FILE" BRAINX_MYSQL_SSL 1
  chmod 640 "$ENV_FILE" 2>/dev/null || true
  echo "已写入 $ENV_FILE"
done

cd /opt/brainx
echo "== 连通性自检 =="
node -e "
import('./src/db.js').then(async ({ pingMysql, closeMysql }) => {
  try {
    const [rows] = await pingMysql();
    console.log('RDS 连接 OK:', JSON.stringify(rows));
  } finally { await closeMysql(); }
}).catch((e) => { console.error('RDS 连接失败:', e.message); process.exit(1); })
"

echo "== candidate_shortlist 冒烟（PoC 职位） =="
node -e "
import('./src/candidate-shortlist.js').then(async ({ candidateShortlist }) => {
  const out = await candidateShortlist({ tenantId: 'yorkteam', consultantId: 'felix',
    jobId: 'reloop-position:31', purpose: 'candidate_review' }).catch((e) => ({ error: e.message, code: e.code }));
  console.log(JSON.stringify(out).slice(0, 500));
})"
echo "完成。接下来重启 brainx-agent-gateway 使配置生效：systemctl restart brainx-agent-gateway"

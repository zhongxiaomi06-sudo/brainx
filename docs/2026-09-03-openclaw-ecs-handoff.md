# BrainX × OpenClaw ECS 部署交接单

> 上级：[文档书总目录](README.md) · [生产运行手册](2026-09-03-openclaw-production-runbook.md) · [部署编排](DEPLOYMENT.md) · [安全手册](SECURITY.md)

## 这是什么

阿里云 ECS 是一台云服务器；ECS Workbench 是在浏览器里操作这台服务器的终端。首次安装命令需要由服务器维护同事在 Workbench 的 `root` 终端执行。顾问电脑不安装 OpenClaw、代码或数据库凭据，最终只在飞书和 HTTPS 工作台使用 Agent。

本交接单只代表“代码和部署材料已准备”。只有完成本文真实环境验收并留存证据后，才能称为“已上线”。

## 交付内容

- BrainX 正式应用与数据库迁移：仓库根目录、`migrations/`、`talent-migrations/`。
- BrainX 原生 OpenClaw 插件：`plugins/brainx-openclaw/`。
- OpenClaw 固定生产配置：`deploy/openclaw/openclaw.production.json`。
- 无密钥环境模板：`deploy/openclaw/brainx-agent.env.example`、`deploy/openclaw/brainx-worker.env.example`、`deploy/openclaw/openclaw.env.example`。
- 三个常驻服务：`deploy/systemd/brainx-agent-gateway.service`、`brainx-integration-worker.service`、`openclaw-brainx.service`。
- 幂等安装器：`deploy/openclaw/install.sh`。

不要通过飞书、GitHub issue、PR 评论或压缩包传真实密码。真实值由服务器同事直接写入 `/etc/brainx/*.env`。

## 一、维护同事先确认

以下条件缺一项就停止，不要带病上线：

```bash
id
test -d /opt/brainx/.git
node --version
npm --version
openclaw --version
command -v node
command -v openclaw
systemctl status brainx --no-pager
```

要求：

- 当前终端具备 root 权限；
- `/opt/brainx` 是现有正式仓库；
- Node 满足仓库 `package.json` 要求，systemd 使用的 Node 位于 `/usr/bin/node`；
- OpenClaw 可执行文件位于 `/usr/local/bin/openclaw`，版本精确为 `2026.7.1-2`；
- 先记录当前 BrainX commit 和服务状态，作为回滚点。

如果路径不同，先由维护同事调整 systemd 单元或建立受控安装路径，不要临时改仓库源码。

## 二、获取已审核版本

PR 合并后只部署明确的 release commit，不直接部署未固定的远程分支：

```bash
cd /opt/brainx
git fetch origin
git status --short --branch
git rev-parse HEAD
git checkout <RELEASE_COMMIT>
npm ci
npm --prefix frontend/btex-frontend ci
npm --prefix frontend/btex-frontend run build
npm run verify
```

`git status` 如有来源不明的本地改动，立即停止并确认，不能覆盖。

## 三、备份并检查 RDS

先按[安全手册](SECURITY.md)备份 `data/.secret` 和 SQLite，并在 RDS 控制台创建快照。随后用只读健康检查确认网络、SSL、库名和账号有效：

```bash
cd /opt/brainx
npm run talent:health
```

准备两个互不复用的常驻账号：Gateway 账号只允许 `brainx_talent` SELECT；worker 账号只允许 `reloop_app` 所需来源表 SELECT，以及 `brainx_talent` 的 SELECT/INSERT/UPDATE/DELETE。执行首次 additive migration 时临时使用具备所需 DDL 权限的迁移账号；迁移完成后立即撤销。禁止使用超管作为常驻凭据。

## 四、预检并安装三个服务

```bash
cd /opt/brainx
sudo deploy/openclaw/install.sh --check
sudo deploy/openclaw/install.sh --apply
```

安装器会创建：

- `/etc/brainx/agent.env`
- `/etc/brainx/worker.env`
- `/etc/brainx/openclaw.env`
- `/var/lib/brainx/.openclaw/openclaw.json`
- 三个 systemd unit

安装器不会生成或猜测真实密钥，也不会自动启动服务。

## 五、只在服务器写真实配置

分别编辑三个环境文件，替换所有 `replace-`、`cli_replace`、`ou_replace`、`oc_replace` 和 `must-equal-` 占位值：

```bash
chmod 0640 /etc/brainx/agent.env /etc/brainx/worker.env /etc/brainx/openclaw.env
chown root:brainx /etc/brainx/agent.env /etc/brainx/worker.env /etc/brainx/openclaw.env
```

关键规则：

- `BRAINX_AGENT_GATEWAY_TOKEN` 在两个文件中必须相同；
- `BRAINX_AGENT_ASSERTION_SECRET` 在两个文件中必须相同；
- Gateway token、assertion secret、audit key、OpenClaw gateway token 必须分别随机生成且不少于 32 字节，不能复用；
- `BRAINX_AGENT_FEISHU_APP_KEYS_JSON` 中的 account 名必须与 OpenClaw 飞书 account 一致；
- Agent Gateway 的 RDS 账号必须只读，worker 使用另一个最小 DML 账号；
- 飞书 App Secret、模型密钥、RDS 密码只留在服务器环境文件；
- 文档原文未获数据责任人批准前，保持 `BRAINX_DOCUMENT_LLM_ENABLED=0`。

## 六、迁移与显式身份绑定

先在一次性的 root shell 中注入临时迁移账号执行；下列 `export` 只表示变量名，真实值不得写进本文或 shell history：

```bash
cd /opt/brainx
export BRAINX_MYSQL_HOST=<RDS_HOST>
export BRAINX_MYSQL_PORT=3306
export BRAINX_MYSQL_DATABASE=brainx_talent
export BRAINX_MYSQL_USER=<TEMP_MIGRATION_USER>
read -rsp "Migration password: " BRAINX_MYSQL_PASSWORD
export BRAINX_MYSQL_PASSWORD
export BRAINX_MYSQL_SSL=1
npm run init-talent
npm run talent:health
exit
```

迁移成功后撤销临时迁移账号。然后由加载了 `/etc/brainx/agent.env` 的管理员 shell 逐个绑定灰度顾问；以下仅是形状示例，尖括号必须替换，不能从聊天文本猜身份：

```bash
node bin/brainx-agent-admin.mjs bind-identity \
  --tenant <TENANT_ID> \
  --account mia \
  --open-id <FEISHU_OPEN_ID> \
  --consultant <BRAINX_CONSULTANT_ID> \
  --employee-ref <INTERNAL_EMPLOYEE_REF>

node bin/brainx-agent-admin.mjs grant-group \
  --tenant <TENANT_ID> \
  --account mia \
  --chat-id <FEISHU_CHAT_ID> \
  --purposes daily_brief,job_review,candidate_review,interview_prep,personal_review,run_status,self_context \
  --senders <FEISHU_OPEN_ID> \
  --projects <AUTHORIZED_PROJECT_ID>
```

首批最多三名顾问。Mia 的授权不能复制给其他顾问；每个人、每个群、每个项目都要显式登记。

## 七、启动顺序

```bash
systemctl daemon-reload
systemctl enable --now brainx-agent-gateway
systemctl enable --now brainx-integration-worker
systemctl enable --now openclaw-brainx
systemctl restart brainx
```

只允许 nginx 的 443 对公网开放。`3101`、`3102`、`18789` 必须只在服务器回环地址监听。

## 八、机器验收

```bash
systemctl status brainx brainx-agent-gateway brainx-integration-worker openclaw-brainx --no-pager
curl -fsS http://127.0.0.1:3102/internal/v1/agent/health
curl -fsS https://base.yorkteam.cn/api/v1/meta/guard
ss -lntp
sudo -u brainx /bin/bash
set -a
source /etc/brainx/openclaw.env
set +a
export HOME=/var/lib/brainx
export OPENCLAW_CONFIG_PATH=/var/lib/brainx/.openclaw/openclaw.json
export OPENCLAW_STATE_DIR=/var/lib/brainx/.openclaw
openclaw plugins inspect brainx-openclaw --runtime --json
openclaw doctor
openclaw security audit
exit
```

Agent Gateway 健康响应必须是 `ready`，并且只列出 10 个批准工具。日志和响应中不得出现密码、token、open_id、手机号、邮箱或简历正文。

## 九、业务验收

由白名单顾问完成并记录结果：

1. Mia 私聊机器人询问“我今天先做什么”；
2. 白名单群里 @机器人请求一个授权职位的 Top 3；
3. 未绑定账号、未知群、越权项目和重复请求全部失败；
4. 候选回复无手机号、邮箱、完整姓名和简历原文；
5. 手机和另一台电脑点击卡片，进入 `https://base.yorkteam.cn`，未登录先授权，有权可看、无权拒绝；
6. 重启三个新增服务后，任务与 outbox 可继续恢复。

## 十、交回证据

维护同事只需回传以下脱敏结果：

- release commit；
- 四个服务的 `active (running)` 状态；
- 两个健康接口的状态码和脱敏响应；
- OpenClaw 实际工具名列表与 doctor/audit 结论；
- 端口监听摘要；
- 私聊、群聊、越权、手机深链五项通过/失败结果；
- 如失败，回传错误码和脱敏日志，不回传环境文件。

收到完整证据前，任务状态保持“代码就绪，生产待部署”。

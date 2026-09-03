# BrainTex 服务器部署与飞书接入 Agent 完整施工手册

> 上级入口：[文档书总目录](README.md) · [ECS 交接单](2026-09-03-openclaw-ecs-handoff.md) · [生产运行手册](2026-09-03-openclaw-production-runbook.md) · [安全手册](SECURITY.md)
>
> 配套视图：[BrainTex 生产架构与工作流](design/braintex-production-workflow.html)
>
> 适用基线：BrainX 当前仓库、OpenClaw `2026.7.1-2`、官方飞书插件 `@openclaw/feishu@2026.7.1`、仓库内 `@brainx/openclaw-plugin@1.0.0`。

## 0. 给执行 Agent 的最高优先级规则

目标不是“让开发者电脑能跑”，而是把 OpenClaw、BrainX 插件、Agent Gateway、worker 和数据库连接全部常驻在一台受控 Linux 服务器。任何顾问在任意电脑或手机上只需登录飞书、添加同一个 BrainTex 机器人并获得业务授权，不安装 OpenClaw，不持有代码、模型密钥、数据库密码或飞书 App Secret。

执行时必须遵守：

1. 先读本手册与根目录 `AGENTS.md`，先检查再修改；发现来源不明改动立即停止。
2. 不猜测密钥、用户、租户、顾问、群或项目 ID；这些值只能由负责人核实后在服务器本地录入。
3. 不把 `.env`、`/etc/brainx/*.env`、`data/.secret`、数据库备份或日志发到聊天、Git、PR 或工单。
4. 不更新锁定版本，不另选 OpenClaw/飞书插件版本，不把 stdio MCP PoC 当生产身份方案。
5. 不开放 Shell、SQL、文件、浏览器、网络搜索、会话派生、消息代发、建群或飞书文档工具。
6. 不修改已安装第三方插件目录，不为同一飞书应用再启动第二条 WebSocket 长连接。
7. 任一步失败就保持失败关闭；不得用演示数据、Mia 的身份或更大权限“先跑起来”。
8. 只有完整自动门禁、真实飞书正向/负向验收和异机测试均通过，才可以报告“已上线”。

## 1. 最终拓扑与机器边界

```text
任意电脑/手机上的飞书
  ↕ 飞书云（机器人消息与卡片；服务器主动建立 WebSocket）
ECS：OpenClaw :18789(loopback)
  → BrainX 原生插件（10 个只读工具 + /brainx 首页）
  → Agent Gateway :3102(loopback)
  → BrainX 领域能力 → SQLite 决策/审计 + RDS 人才事实
  ← 事实、证据、风险、下一步
飞书卡片 / 对话回复 ──可选 HTTPS──→ nginx :443 → BrainX :3101(loopback)

ECS：integration worker
  → reloop 结构化来源 / 受控文档暂存
  → candidate_fact_v1 / candidate_match_bundle_v1 / shadow 评测
```

公网只允许 nginx `443`。`3101`、`3102`、`18789`、SQLite 和 RDS 不得直接暴露公网。WebSocket 是服务器向飞书主动连接，不要求公网 webhook。

## 2. 人与 Agent 的职责分界

| 项目 | 部署 Agent 可做 | 必须由人确认或操作 |
|---|---|---|
| 代码与依赖 | 检查 commit、安装锁定依赖、构建、运行测试 | 指定允许发布的 commit |
| 飞书后台 | 给出精确 scope、事件和检查项 | 管理员勾选权限、审批并发布应用版本 |
| 密钥 | 生成随机值、检查长度与占位符 | 提供 App Secret、模型密钥、RDS 密码并在服务器录入 |
| 身份绑定 | 执行明确给出的绑定命令 | 核实 open_id、consultant_id、employee_ref、tenant 和项目范围 |
| 数据库 | 只读健康检查、additive migration、权限负测 | RDS 快照、账号授权和迁移窗口批准 |
| 上线 | 启动、健康检查、采集脱敏证据 | 顾问完成真实飞书和异机验收 |
| 扩权 | 不得自行扩权 | 数据责任人和飞书管理员单独审批 |

## 3. 开始前的停止线

在服务器 root 终端执行只读检查：

```bash
id
uname -a
test -d /opt/brainx/.git
cd /opt/brainx
git status --short --branch
git rev-parse HEAD
node --version
npm --version
command -v openclaw
openclaw --version
systemctl status brainx --no-pager
systemctl cat brainx
ss -lntp
```

继续条件：root 身份明确；仓库存在且工作区无来源不明改动；Node 满足 `package.json` 的 `>=22.5`；OpenClaw 路径为 `/usr/local/bin/openclaw` 且版本精确包含 `2026.7.1-2`；现有 BrainX 服务、端口和回滚 commit 已记录。

`bin/brainx.service` 是历史文件，包含旧公网地址与旧端口，不是本轮 OpenClaw 安装器管理的服务。不得把它直接覆盖到生产。现有 `brainx.service` 如与当前 nginx upstream 不一致，先由服务器负责人决定迁移窗口。

## 4. 固定源码与完成本地门禁

只部署负责人指定的 release commit，不直接运行浮动分支：

```bash
cd /opt/brainx
git fetch origin
git status --short --branch
git checkout <RELEASE_COMMIT>
npm ci
npm --prefix frontend/btex-frontend ci
npm --prefix frontend/btex-frontend run build
npm run verify
```

必须查看 `.quality-gate/reports/latest.md`，结论为“通过”、Push 条件为“满足”。若服务器上的源码由压缩包复制而来且没有 `.git`，停止并让负责人提供带 commit 的正式制品；不能用“文件看起来一样”代替版本证据。

## 5. 飞书开发者后台配置

### 5.1 应用形态

使用一个企业自建应用，启用机器人能力。记录 App ID；App Secret 只进入 `/etc/brainx/openclaw.env`。不要创建第二个机器人来绕过配置问题。

### 5.2 第一版应用身份权限

在权限管理按最小能力申请并以后台实际名称复核：

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:send_as_bot",
      "im:chat",
      "contact:user.base:readonly",
      "im:resource"
    ]
  }
}
```

首期不申请建群、加人、文档、云盘、知识库、多维表格写入或群全量消息权限。机器人入群不等于获得 BrainX 数据授权；第一版群里必须 @ 机器人，只处理白名单 sender。

### 5.3 事件与长连接

选择“使用长连接接收事件”，至少订阅：

- `im.message.receive_v1`：私聊与群 @ 消息；
- `card.action.trigger`：功能首页和结果卡按钮；
- `im.chat.member.bot.added_v1`、`im.chat.member.bot.deleted_v1`：建议订阅，当前锁定插件仅记录加入/移出日志；
- `application.bot.menu_v6`：只有配置飞书机器人菜单时才需要。

先让服务器上的 OpenClaw 建立长连接，再在后台保存事件配置。权限或事件变化后必须“创建版本并发布”，未发布的勾选不会生效。

### 5.4 应用可用范围

首批只放三名已核实顾问和两个测试群。不要一开始全公司可见。每个顾问的 BrainX 身份、每个群的 sender/purpose/project 范围还要在 Agent Gateway 再绑定一次。

## 6. 安装 OpenClaw、官方飞书插件和 BrainX 插件

仓库安装器不会替你安装 OpenClaw 主程序；它会校验版本、安装两个插件，并把七个已审核生产 Skill 同步到服务账号的 workspace。若主程序缺失，先从组织批准的软件源安装精确版本并确认 `/usr/local/bin/openclaw`，不要自行升级到“最新版”。

```bash
cd /opt/brainx
sudo deploy/openclaw/install.sh --check
sudo deploy/openclaw/install.sh --apply
```

`--apply` 会创建 `brainx` 系统用户、三个环境文件、OpenClaw 配置、三个 systemd unit，并安装：

- `@openclaw/feishu@2026.7.1`；
- 仓库内 `@brainx/openclaw-plugin@1.0.0`。

同时安装 `brainx-today`、`brainx-job`、`brainx-talent`、`brainx-match`、`brainx-engagement-draft`、`brainx-interview-prep`、`brainx-review` 七个生产 Skill。其余仓库 Skill 不进入首批生产，避免把历史工具名或更宽能力一起带入。

安装器不会覆盖已经存在的环境文件，也不会启动服务。每次新 release 包含插件变化时都必须重新运行 `--apply`，否则服务器仍在运行旧插件副本。

## 7. 配置三个环境文件

所有文件保持 `0640 root:brainx`。先生成互不复用的随机值，例如 `openssl rand -hex 32`；不要把生成结果留在聊天或命令参数里。

### 7.1 `/etc/brainx/agent.env`

| 变量 | 规则 |
|---|---|
| `BRAINX_AGENT_GATEWAY_TOKEN` | 随机，至少 32 字节；与 `openclaw.env` 完全相同 |
| `BRAINX_AGENT_ASSERTION_SECRET` | 另一个随机值；与 `openclaw.env` 完全相同 |
| `BRAINX_AGENT_AUDIT_KEY` | 第三个独立随机值 |
| `BRAINX_AGENT_FEISHU_APP_KEYS_JSON` | account 到独立绑定键的 JSON；键名必须含 `mia` |
| `BRAINX_AGENT_ADMIN_ID` / `ALLOWLIST` | 经确认的管理员操作员 ID |
| `BRAINX_DB` | `/opt/brainx/data/brainx.sqlite` |
| `BRAINX_MYSQL_*` | `brainx_talent` 只读账号，仅 SELECT，SSL=1 |

### 7.2 `/etc/brainx/worker.env`

| 变量 | 规则 |
|---|---|
| `BRAINX_DB` | 与 Gateway 使用同一决策账本路径 |
| 三个 `*_ENABLED` | 首批按模板开启；文档 LLM 开关默认保持 0 |
| `BRAINX_DOCUMENT_STAGING_ROOT` | `/opt/brainx/data/document-staging`，不得指向任意用户目录 |
| `BRAINX_TENANT_ID` 与 reloop 四项绑定 | 由数据责任人逐项核实，不从聊天猜 |
| `BRAINX_MYSQL_*` | 独立 worker 账号：来源 SELECT；目标库最小 DML；无 DDL |
| `BRAINX_LLM_*` | 仅文档责任人批准后配置，密钥只留服务器 |

### 7.3 `/etc/brainx/openclaw.env`

| 变量 | 规则 |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | 独立随机值，不与 BrainX token 复用 |
| `BRAINX_FEISHU_APP_ID/SECRET` | 同一个已发布飞书应用 |
| `BRAINX_FEISHU_ALLOWED_OPEN_ID_1..6` | 六名已批准顾问；每个 Open ID 还必须在 Agent Gateway 中绑定到同一个飞书 account `mia` 和本人 consultant |
| `BRAINX_FEISHU_ALLOWED_CHAT_ID_1..3` | 最多三个批准群；未使用槽位重复一个已授权群 ID，不扩大范围 |
| `BRAINX_BASE_URL` | 正式 HTTPS 根地址，用于 `/brainx` 工作台按钮 |
| 两个 Agent secret | 与 `agent.env` 对应值逐字一致 |
| `STEPFUN_API_KEY` | 公司默认模型凭证，仅保存在服务器；配置通过 SecretRef 读取，不得写入仓库或聊天 |

生产默认模型为 `stepfun/step-3.5-flash`，失败时回退到 `stepfun/step-3.7-flash`。私聊会话按飞书用户隔离，顾问可发送 `/model`，或点击 `/brainx` 首页的“切换我的模型”，在管理员已批准的模型目录内改变本人当前会话模型；该操作不修改其他顾问会话，也不需要编辑服务器文件。个人自带 API Key/OAuth 属于后续独立 Agent 认证能力，不得通过飞书消息收集密钥。

校验所有占位符已经替换，但不要输出值：

```bash
grep -En 'replace-|must-equal-|cli_replace|ou_replace|oc_replace' /etc/brainx/*.env
stat -c '%a %U %G %n' /etc/brainx/*.env
```

第一条必须零输出；第二条必须显示 `640 root brainx`。不要使用 `set -x`，不要把环境文件整体打印到终端录屏。

### 7.4 主 BrainX 应用

保留服务器现有 `/opt/brainx/.env` 与 `data/.secret`，不要被安装器模板覆盖。主应用至少要有正式 `BRAINX_BASE_URL=https://...`、自身飞书 OAuth 配置和已验证的数据连接。`.env` 权限应为 600；`data/.secret` 必须先备份，丢失会使已有登录令牌无法解密。

## 8. 数据库账号、备份与迁移

至少分三类账号：

1. Agent Gateway：`brainx_talent` 只读；
2. integration worker：reloop 来源只读，`brainx_talent` 最小 DML；
3. 临时迁移账号：仅迁移窗口使用 DDL，完成后立即撤销。

先做 RDS 快照和 `data/.secret`/SQLite 加密备份。再在一次性 shell 中注入临时迁移账号：

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

迁移必须 additive；禁止删除表、清库或回滚数据。健康检查失败时先查 RDS 白名单、SSL、库名与账号，不要扩大到超管常驻。

## 9. 显式绑定顾问与群

在加载 `/etc/brainx/agent.env` 的管理员 shell 里执行。下列值必须来自人类核实：

```bash
cd /opt/brainx
set -a
source /etc/brainx/agent.env
set +a

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

一个 `(account_id, open_id)` 只能绑定一个顾问。能看到机器人、在同一个群或名字叫 Mia 都不能替代绑定。撤权使用 `revoke-identity` / `revoke-group`，撤权后立即做负向查询。

## 10. 启动顺序

```bash
systemctl daemon-reload
systemctl enable --now brainx-agent-gateway
systemctl enable --now brainx-integration-worker
systemctl enable --now openclaw-brainx
systemctl restart brainx
```

依赖顺序是：BrainX 数据与迁移就绪 → Agent Gateway → worker → OpenClaw → 主应用/nginx。OpenClaw unit 明确依赖 Agent Gateway；不要通过循环重启掩盖配置错误。

## 11. 机器级验收

```bash
systemctl status brainx brainx-agent-gateway brainx-integration-worker openclaw-brainx --no-pager
curl -fsS http://127.0.0.1:3102/internal/v1/agent/health
curl -fsS https://<BRAINX_PUBLIC_HOST>/api/v1/meta/guard
ss -lntp

sudo -u brainx /bin/bash
set -a
source /etc/brainx/openclaw.env
set +a
export HOME=/var/lib/brainx
export OPENCLAW_CONFIG_PATH=/var/lib/brainx/.openclaw/openclaw.json
export OPENCLAW_STATE_DIR=/var/lib/brainx/.openclaw
openclaw plugins inspect brainx-openclaw --runtime --json
openclaw skills list
openclaw doctor
openclaw security audit
exit
```

必须满足：

- 四个服务均为 `active (running)`；
- Agent Gateway 返回 `status=ready`，工具恰好是批准的 10 个；
- 插件 runtime 为 `loaded`，`commands` 含 `brainx`，工具恰好 10 个；
- Skill 列表包含上述七个生产 Skill，且均为可用状态；
- Feishu channel 为 ON/OK；
- `18789`、`3102`、BrainX upstream 只绑定 loopback，公网只见 443；
- 日志没有 secret、token、open_id、手机号、邮箱、简历正文或完整 prompt。

插件真实请求必须命中 `/internal/v1/agent/tools/<tool_name>`，并携带 `agent_tool_request.v1`、client 版本、短时主体签名和 request_id。只看到“插件 loaded”不能证明数据链路可用。

## 12. 飞书业务验收

按顺序完成，不跳步：

1. 已绑定顾问私聊发送 `/brainx`，看到八个业务按钮（含推荐设置和会话模型切换）及 HTTPS 工作台按钮；该页不调用模型。
2. 点击“今天先做什么”，确认回复只基于本人授权数据，并标记事实、判断、风险与下一步。
3. 点击“推荐值得做的职位”，核对职位确实属于本人或项目授权。
4. 选择一个授权职位找人，返回最多三名脱敏候选；手机号、邮箱、完整姓名和简历原文命中为零。
5. 白名单群中只有 @ 机器人且 sender 在白名单时触发；不 @、未知 sender、未知群都不进入模型。
6. 另一名顾问请求仅授权给第一人的职位，统一拒绝且不泄露对象是否存在。
7. 手机和另一台没有 OpenClaw/源码的电脑登录飞书，重复步骤 1—4；结果应一致。
8. 点击工作台：未登录先走飞书 OAuth，有权对象可见，无权对象拒绝；URL 不含身份、token 或 scope。
9. 重启三个新增服务，再做一次查询，确认会话、任务租约和 outbox 可恢复。

这九项全部有脱敏证据，才能证明“任何电脑可用”。开发者本机成功、服务器 `curl` 成功或飞书能收到普通消息都不能替代。

## 13. 新用户说明与当前限制

新顾问被加入 allowlist 和身份绑定后，管理员应告诉他：在 BrainTex 私聊输入 `/brainx` 打开功能首页；群里必须 @机器人；所有判断只基于他有权数据；外发和业务写入仍由顾问确认。

当前官方飞书插件虽能收到 `im.chat.member.bot.added_v1`，但锁定版本只记日志，没有自定义欢迎回调。因此“刚添加机器人便自动弹卡”尚未完成。不要改第三方安装目录实现临时补丁；当前可靠入口是 `/brainx`，后续应通过官方扩展点或自有通道层补齐同源欢迎卡。

## 14. 常见故障决策表

| 现象 | 先查 | 不要做 |
|---|---|---|
| 飞书完全没回复 | OpenClaw 服务、Feishu channel、应用是否发布、`im.message.receive_v1` | 新建第二个机器人 |
| 群里不回复 | 群 ID、sender allowlist、是否 @、应用可用范围 | 关闭全部群限制 |
| 按钮无反应 | `card.action.trigger`、应用版本、官方插件版本 | 把按钮改成不鉴权写接口 |
| `/brainx` 没有卡片 | BrainX 插件是否重新 `--apply`、runtime 是否含 command | 只重启主 BrainX |
| 插件 loaded 但查询失败 | Agent Gateway health、两个共享 secret、请求路径/契约、身份绑定 | 给 OpenClaw 数据库密码 |
| 返回无权 | `(account, open_id)` 绑定、tenant、purpose、project grant | 复制 Mia 授权 |
| 人才为空 | reloop 绑定、worker 状态、人才/职位双授权、事实版本 | 返回演示候选人 |
| 工作台按钮不见 | `openclaw.env` 的 `BRAINX_BASE_URL` 是否 HTTPS | 使用 localhost 或裸 IP HTTP |
| 回答过慢或费用升高 | 模型凭证、超时、工具轮次、任务上限 | 无限重试或放开 Shell |

## 15. 回滚

1. 停 `openclaw-brainx`，阻断新 Agent 请求；保留 BrainX 工作台。
2. 停 worker；保留 PENDING/RUNNING 任务、outbox、SQLite 和 RDS 数据。
3. 回到上一个已验收 commit，重新运行安装器以恢复对应插件包。
4. additive 表不做破坏性回滚；只撤销新授权、关闭新 handler。
5. 启动 Agent Gateway 与 OpenClaw，重跑健康、权限负测和一条 Mia 私聊。

身份越权、敏感数据泄漏或错误外发时立即停止 OpenClaw；数据源不可用时返回不可用，不返回记忆或演示数据。

## 16. 交付证据模板

部署 Agent 最终只回传：

```text
release_commit: <sha>
quality_gate: PASS / FAIL
services: brainx=?, agent_gateway=?, worker=?, openclaw=?
agent_health: ready / unavailable
plugin: loaded; command_count=?; tool_count=?
feishu: dm=?, group_at=?, card_action=?
isolation: unknown_user=?, unknown_group=?, cross_user=?, revoked_user=?
privacy_scan: phone=0; email=0; resume_raw=0
cross_device: phone=?; second_computer=?
public_ports: <只保留脱敏端口摘要>
open_items: <不含密钥和个人 ID>
```

任何真实证据缺失时，结论只能是“代码就绪 / 服务器待配置 / 灰度待验收”之一，不能写“已完成”。

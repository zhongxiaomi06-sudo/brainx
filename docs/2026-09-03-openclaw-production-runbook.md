# OpenClaw 多顾问生产运行手册

> 上级：[文档书总目录](README.md) · [完整施工手册](2026-09-03-braintex-server-deployment-agent-manual.md) · [部署编排](DEPLOYMENT.md) · [安全手册](SECURITY.md) · [验收入口](../specs/003-openclaw-production/quickstart.md)

## 目标拓扑

顾问只使用飞书或 HTTPS 工作台；OpenClaw、BrainX 插件、Agent Gateway 和 worker 全部常驻 ECS。公网只开放 nginx 的 443，`3101` 与 `3102` 只监听回环。OpenClaw 飞书渠道使用 WebSocket，不需要公网 webhook。

## 首次安装

1. 将已验收 commit 部署到 `/opt/brainx`，安装 Node 依赖并构建前端。
2. 安装并锁定 OpenClaw `2026.7.1-2`，执行 `sudo deploy/openclaw/install.sh --check`。`--apply` 会锁定安装官方飞书插件 `@openclaw/feishu@2026.7.1` 和仓库内 BrainX 插件。
3. 执行 `--apply`，然后在 `/etc/brainx/agent.env`、`worker.env` 与 `openclaw.env` 替换全部占位值；文件保持 `0640 root:brainx`。Gateway 使用人才库只读账号，确定性 worker 使用独立最小 DML 账号。
4. 运行 SQLite/RDS additive migration；先做 RDS 备份和只读健康检查，再执行写迁移。
5. 用 `brainx-agent-admin` 逐一绑定六名在职灰度顾问，并显式登记测试群、sender、purpose 与项目范围。Otto 已离职：保留历史审计，但 `consultants.active=0` 且不得存在 ACTIVE 身份绑定。
6. 当前一体化生产部署使用 `brainx-worker` 承担 bridge、简历和推送；`brainx-integration-worker` 保持 disabled，禁止两者同时消费。依次启动 `brainx-agent-gateway`、`brainx-worker`、`openclaw-brainx`，最后重启现有 `brainx.service`。
7. 用已绑定顾问的飞书私聊输入 `/brainx`，确认返回六入口功能首页；再点击一条职位入口和一条人才入口。

不得把 Gateway、OpenClaw 控制面、RDS 或 SQLite 暴露公网；不得从聊天文本推断 consultant_id；不得复制 Mia 的授权给其他顾问。

## 每次发布验收

```text
npm run verify
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
curl -fsS http://127.0.0.1:3102/internal/v1/agent/health
curl -fsS https://base.yorkteam.cn/api/v1/meta/guard
```

然后由六名在职灰度顾问完成私聊、白名单群 @、跨人负向读取、候选敏感字段扫描和手机/异机 HTTPS 深链。当前批准 21 个窄工具，包含 OpenMai 直接搜索、本人待确认草稿列表和显式草稿裁决；未知群、撤权用户、跨项目和重复 nonce 必须失败。

## York 业务主体与审计身份

- York 是机器人面向团队的业务主体；稳定技术账号只负责飞书长连接和工具投递。
- 权限与审计永远使用消息发送人的真实 `open_id → consultant_id`，不得把六人的动作统一记录成 York。
- 第一批历史群消息可以用于回填草稿，但不得据此自动授权全部历史群；首轮只登记已经核验的灰度群，后续逐群扩容。
- OpenClaw 只负责对话和窄工具编排；`brainx-worker` 写入账本与草稿，职位权威事实必须由顾问通过 `brainx_review_job_fact` 显式确认。
- 主题和技术账号命名放在数据链路稳定后切换；切换时必须迁移 ACTIVE binding/group scope 并保留真实操作者不变。

功能首页验收详见 [BrainTex 飞书功能首页与新用户指引](2026-09-03-braintex-feishu-home.md)。当前锁定版飞书插件不支持自定义 bot-added 回复，不得通过改安装目录或启动第二条同应用 WS 连接绕过。

## 日常运维

- 每日看四个服务状态、最近错误码、草稿积压、任务和 outbox；日志不得出现 prompt、简历正文、联系方式或密钥。
- 任务租约过期会被同类 handler 重新领取；费用或尝试次数到上限后进入 FAILED，不无限消耗模型额度。
- 发飞书前重新校验授权；撤权同时取消未发送 outbox 并失效缓存/索引。
- 人才同步只在所有分页成功后推进游标；文档 schema 不合格进入 NEEDS_REVIEW，扫描件进入 OCR_REQUIRED。
- 新匹配只输出 SHADOW 的 Recall@20/NDCG@10 报告，未经负责人签署不改变正式顺序。

## 回滚

1. 停止 `openclaw-brainx`，阻断新 Agent 请求；保留 BrainX 工作台。
2. 停止 worker；不要删除 PENDING/RUNNING 任务、outbox、SQLite 或 RDS 事实版本。
3. 将 `/opt/brainx` 切回上一个已验收 commit，重新安装对应插件包并重启 Gateway/OpenClaw。
4. additive 数据表不回滚删除；如需语义回退，只撤销新授权和关闭新 handler。
5. 重跑健康、权限负向测试和一条 Mia 私聊；确认后再恢复 worker。

## 故障优先级

身份/越权或敏感数据泄漏立即停 OpenClaw；签名、RDS 或飞书故障保持失败关闭，不返回假数据；仅卡片深链故障时保留对话读取并停止发新卡。任何真实部署证据缺失都只能标记“代码就绪”，不能标记“已上线”。

## 2026-09-03 个人模型生产发布证据

- 运行版本：`afddd38ab7258bdd2a2ae9086d5e27475e383396`；该版本已合并服务器原有六人灰度分支，未覆盖 `backups/` 与 `deploy/openclaw/sandbox/`。
- 回退点：`/root/brainx-backups/20260903-220634-personal-model`，权限仅 root；包含 BrainX SQLite 压缩副本、环境/系统服务/nginx 配置和排除 npm 缓存后的 OpenClaw 状态，附 SHA-256 清单。
- 本地与远端门禁：完整门禁 24/24 通过；后端 503/503、前端 42/42、Storybook 81/81；PR #47 的 `quality-gate` 与 `docker-build` 均成功。
- 生产检查：HTTPS 聚合健康端点 200；未登录个人模型接口 401；BrainX、Agent Gateway、OpenClaw 三服务 active，最近错误日志为空；飞书与 BrainX 插件分别为 2026.7.1 loaded、1.1.6 loaded。
- 权限检查：`mia` 飞书技术账号下六名顾问均为 ACTIVE；渠道私聊白名单为 6 人，工具白名单 21 个，会话只见本人且 Agent 间通信关闭。
- 模型边界：共享默认模型、共享 StepFun 环境变量及旧 main Agent 内嵌 StepFun Key 均已移除；StepFun 只保留无凭据的可选模型目录，顾问模型与 Key 必须写入其动态个人 Agent。
- 尚未完成：当前生产 OpenClaw 尚无动态个人 Agent/binding；每位顾问需先私聊发送 `/brainx` 生成个人 Agent，再从“配置我的模型”录入本人 Key。至少两位顾问使用不同供应商完成真实问答，才能把六人真机验收标记为通过。

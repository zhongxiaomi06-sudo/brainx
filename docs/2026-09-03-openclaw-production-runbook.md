# OpenClaw 多顾问生产运行手册

> 上级：[文档书总目录](README.md) · [部署编排](DEPLOYMENT.md) · [安全手册](SECURITY.md) · [验收入口](../specs/003-openclaw-production/quickstart.md)

## 目标拓扑

顾问只使用飞书或 HTTPS 工作台；OpenClaw、BrainX 插件、Agent Gateway 和 worker 全部常驻 ECS。公网只开放 nginx 的 443，`3101` 与 `3102` 只监听回环。OpenClaw 飞书渠道使用 WebSocket，不需要公网 webhook。

## 首次安装

1. 将已验收 commit 部署到 `/opt/brainx`，安装 Node 依赖并构建前端。
2. 安装并锁定 OpenClaw `2026.7.1-2`，执行 `sudo deploy/openclaw/install.sh --check`。
3. 执行 `--apply`，然后在 `/etc/brainx/agent.env`、`worker.env` 与 `openclaw.env` 替换全部占位值；文件保持 `0640 root:brainx`。Gateway 使用人才库只读账号，确定性 worker 使用独立最小 DML 账号。
4. 运行 SQLite/RDS additive migration；先做 RDS 备份和只读健康检查，再执行写迁移。
5. 用 `brainx-agent-admin` 逐一绑定最多三名灰度顾问，并显式登记测试群、sender、purpose 与项目范围。
6. 依次启动 `brainx-agent-gateway`、`brainx-integration-worker`、`openclaw-brainx`，最后重启现有 `brainx.service`。

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

然后由三名灰度顾问完成私聊、白名单群 @、跨人负向读取、候选敏感字段扫描和手机/异机 HTTPS 深链。只有 10 个批准工具可见，未知群、撤权用户、跨项目和重复 nonce 必须失败。

## 日常运维

- 每日看三个服务状态、最近错误码、积压任务和 outbox；日志不得出现 prompt、简历正文、联系方式或密钥。
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

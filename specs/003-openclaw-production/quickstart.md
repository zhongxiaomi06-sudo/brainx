# Quickstart: OpenClaw 多顾问生产化验收

本文件是验收入口，不包含真实凭据。部署细节以 [部署编排](../../docs/DEPLOYMENT.md) 为准。

## 1. 本地自动化

```text
node --test --test-force-exit tests/agent-*.test.mjs tests/openclaw-plugin.test.mjs
node --test --test-force-exit tests/talent-pipeline.test.mjs tests/talent-revocation.test.mjs
npm run verify:quick
```

预期：身份伪造、未知群、跨顾问、跨项目、重复 nonce、过期 assertion、未知工具、敏感字段投影全部被拒绝；合法私聊读取成功。

## 2. 插件打包验收

```text
cd plugins/brainx-openclaw
npm ci
npm pack --dry-run
npm pack
openclaw --profile brainx plugins install ./brainx-openclaw-*.tgz
openclaw --profile brainx plugins inspect brainx-openclaw --runtime --json
```

检查：manifest、运行时注册和配置 allowlist 中的 10 个工具完全一致；没有 MCP、exec、process、read/write/edit/apply_patch、browser/web、session send/spawn 或飞书 workspace 管理工具。

## 3. 服务启动验收

仅使用脱敏测试环境变量启动：

```text
node --env-file=.env bin/brainx-agent-gateway.mjs
curl -fsS http://127.0.0.1:3102/internal/v1/agent/health
```

健康响应不得包含 token、签名密钥、数据库密码、open_id 或业务数据。

## 4. 身份和群范围

由管理员使用 `brainx-agent-admin` 显式绑定：

- 一个生产 Feishu account 对应一个租户；
- 每个 `(account_id, open_id)` 只绑定一个顾问；
- 群 scope 显式列出 sender、purpose 和可选项目；
- 撤销后立即执行负向读取测试。

不得从用户消息里的姓名或 consultant_id 自动绑定。

## 5. 飞书真实灰度

至少使用三名白名单顾问和两个测试群：

1. 三人分别私聊“我今天先做什么”；
2. 两人询问同一只授权给一人的职位；
3. 白名单群 @ 机器人请求 Top3；
4. 非白名单用户、群和机器人消息尝试触发；
5. 候选人回复检查手机号/邮箱/完整姓名/简历原文为 0；
6. 连续完成今日简报、职位判断、shortlist、候选证据和沟通草稿；
7. 重放同一签名请求，确认只第一次成功；
8. 重启 OpenClaw、Agent Gateway 和 worker，确认任务状态可恢复。

## 6. HTTPS 深链

- 所有卡片 URL 必须以 `https://base.yorkteam.cn` 开头；
- 在手机和另一台电脑打开，未登录先走飞书 OAuth；
- 有权限顾问打开目标对象，无权限顾问得到统一拒绝；
- 仓库、配置和已发送新卡中 `127.0.0.1` 深链命中为 0。

## 7. 发布门禁

```text
openclaw --profile brainx doctor
openclaw --profile brainx security audit
npm run verify
git status --short --branch
```

只有完整门禁结论为“通过”、Push 条件为“满足”、生产工具枚举一致、真实灰度证据齐全时才允许 push 和创建 PR。

## 8. 失败判定

以下任一项发生，本功能不得宣称完成：

- 顾问仍需在自己电脑安装 OpenClaw；
- 模型参数可改变 consultant/tenant/scope；
- 群聊出现敏感候选字段；
- Agent Gateway 或 OpenClaw 控制面公网可访问；
- 数据源失败时返回内存假数据；
- 新匹配在无评测签署时改变正式排序；
- 任务重启后永久 RUNNING；
- 完整质量门禁失败或没有新鲜生产证据。

# Quickstart: 顾问个人模型配置验收

> 只使用假密钥做自动化；真实密钥仅由凭据所有者在 HTTPS 页面输入。

## 1. 自动化

```bash
npm run verify:quick
node --test tests/personal-model-config.test.mjs tests/personal-model-routes.test.mjs tests/openclaw-production-config.test.mjs
npm --prefix frontend/btex-frontend test
```

预期：供应商/模型/密钥校验、无同意拒绝、身份派生、两顾问隔离、CLI stdin、超时/回滚、响应不含密钥、动态 Agent、共享 Skills 和配置保留断言全部通过。

## 2. 隔离 OpenClaw state

在临时目录用假 Key：

1. 创建两个 Agent 与两个 direct peer binding。
2. 分别调用个人模型服务配置 `openai/gpt-5.4` 和 `stepfun/step-3.5-flash`。
3. `openclaw models auth list --agent <id> --json` 只显示各自 profile 元数据。
4. 修改 Mia 后再次读取 Felix，结果不得改变。
5. 扫描临时 config、BrainX SQLite 和命令记录，不得出现完整假 Key；Key 只允许存在于 OpenClaw 个人 Agent 认证 SQLite。

## 3. 发布前服务器验收

1. 备份 `/var/lib/brainx/.openclaw`、BrainX SQLite、环境文件和当前 commit。
2. 确认生产配置不再含 `STEPFUN_API_KEY` SecretRef 或全局 StepFun primary。
3. 安装器升级后确认既有 `agents.list`、`bindings` 和个人 auth store 未被覆盖。
4. 确认七个 BrainX Skills 位于 `<state-dir>/skills` 并对个人 Agent 可见。
5. 确认 OpenClaw/Gateway/BrainX/nginx 运行，worker 仅在真实 RDS 配置完整时启用。

## 4. 六人真机验收

每位灰度顾问：

1. 私聊发送 `/brainx`，确认确定性首页出现。
2. 点击“配置我的模型”，OAuth 登录后进入个人模型页。
3. 选择供应商、填写模型 ID 和本人 Key，阅读提示并勾选同意。
4. 保存后页面显示本人供应商/模型/ACTIVE，不显示 Key。
5. 回飞书发送 `/model status` 和一个不含候选隐私的简单问题。
6. 再查询一条本人授权职位；检查回答身份、工具和数据范围均属于本人。

至少选两位顾问配置不同供应商，交叉修改并复验互不影响。共享群在公司模型未配置时必须明确不可用，不能借个人 Key。

## 5. 失败与回滚

- 用未授权账号、错误同意版本、非法模型名、带换行 Key、并发保存和不存在 Agent 分别验证失败关闭。
- 发现跨人凭据/会话、日志泄密或个人 Key 被群使用时，立即停止 OpenClaw 服务。
- 回滚代码时保留个人 auth store 备份；不得用旧安装器整文件覆盖生产 OpenClaw config。

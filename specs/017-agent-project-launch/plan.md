# 017 — 实施计划

## 改动清单

| 文件 | 改动 |
|---|---|
| src/agent-gateway/tools-actions.js | 新增 `launchProjectChat` handler（调 `launchProject`，幂等键 `agent-launch:<cid>:<job>`）+ 注册 `brainx_launch_project_chat` |
| src/agent-gateway/tool-registry.js | AGENT_TOOL_ROWS 增 `brainx_launch_project_chat`（purpose job_action、groupRequiresProject、job_id+confirm 必填、projectKey job_id） |
| src/agent-gateway/authorization.js | allowIntakeBinding 仅限 group（否则 GROUP_REQUIRED）；authorizeIntakeBinding 区分 GROUP_NOT_INTAKED / GROUP_ALREADY_BOUND |
| src/agent-gateway/envelopes.js | 新增 8 条业务错误文案（GROUP_* / PROJECT_MEMBERSHIP_REQUIRED / AGENT_IDENTITY_BINDING_REQUIRED / BRAINX_BASE_URL_REQUIRED / FEISHU_CHAT_CREATE_FAILED / PROJECT_LAUNCH_IN_PROGRESS） |
| plugins/brainx-openclaw/runtime.js | BRAINX_OPENCLAW_TOOLS 增 `brainx_launch_project_chat`；PLUGIN_VERSION 1.4.0→1.4.1 |
| plugins/brainx-openclaw/openclaw.plugin.json | contracts.tools 加 `brainx_launch_project_chat` |
| plugins/brainx-openclaw/package.json | 版本 1.4.0→1.4.1 |
| plugins/brainx-openclaw/prompt.js | 接单流程补第 4 步：私聊接单后无群则直接建群；补充私聊不能 bind 的指引 |
| deploy/openclaw/openclaw.production.json | tools.allow 加 `brainx_launch_project_chat` |
| tests/fixtures/openclaw-production/plugin-contract.json | allowed_tools 加 `brainx_launch_project_chat` |
| tests/openclaw-plugin.test.mjs | 工具数 24→25 |
| tests/group-intake.test.mjs | 更新 intake 拒绝断言为 GROUP_NOT_INTAKED / GROUP_ALREADY_BOUND；新增私聊早失败用例 |
| tests/agent-action-tools.test.mjs | 新增 `brainx_launch_project_chat` 用例（幂等 + 建群 + 拒绝未确认） |
| specs/017-agent-project-launch/ | spec/plan/tasks |
| docs/AGENT_COMMIT_LOG.md + docs/README.md | 记录本次改动 |

## 顺序

1. 规格三件套
2. 错误文案（envelopes）→ 授权早失败（authorization）
3. 工具（tool-registry + tools-actions）
4. 插件四处同步 + 生产配置 + 契约 fixture
5. 测试与断言同步
6. `npm run verify:quick` → `npm run verify`
7. 文档 + commit

## 风险

| 风险 | 处置 |
|---|---|
| 新增工具漏同步某处白名单 → 生产「allowlist contains unknown entries」 | 三处 + fixture 一起改，靠 `openclaw-plugin.test.mjs` / `openclaw-production-config.test.mjs` 的 deepEqual 兜住 |
| 群内调用建群造成重复群 | `launchProject` 已有 `getProjectLaunch` 幂等 + `PROJECT_CHAT_CONFLICT` 冲突保护；`already:true` 直接返回 |
| 改错误码破坏既有断言 | 同步更新 group-intake 测试断言 |
| 生产插件副本未同步 → 旧 schema | 部署步骤：cp 到 `/var/lib/brainx/.openclaw/extensions/brainx-openclaw/` + openclaw.json tools.allow 加名 + 重启四服务 |

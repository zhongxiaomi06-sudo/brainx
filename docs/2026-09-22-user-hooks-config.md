# Per-user Hook 配置（OpenClaw 插件）

> 上级目录：[BrainX 文档书](README.md)
>
> 适用范围：BrainTex（OpenClaw 插件 brainx-openclaw）里「某人私聊/群里说 X → 确定性做 Y」类的 per-user hook

## 背景与结论

2026-09-22 之前，每个顾问级 hook 都是一个按人名硬编码的 JS 文件（`linda-private-launch.js`、`wendy-private-group.js`、`yang-offer-reply.js`），开通新顾问必须写代码、改 `index.js`、发版。现已统一为配置驱动：所有 per-user hook 收进 `plugins/brainx-openclaw/user-hooks.json`，由通用引擎 `plugins/brainx-openclaw/user-hooks.js` 加载执行。**开通新顾问 = 写一条 JSON 配置，不再写代码**——这是团队复制该能力的前提。

三个历史 hook 的行为、priority、幂等键、文案全部原样迁入配置，未改变线上行为。

## 配置格式

文件：`plugins/brainx-openclaw/user-hooks.json`（随插件包发布）。生产上可设环境变量 `BRAINX_USER_HOOKS_FILE` 指向插件目录外的配置文件，改配置不用动包内容；改完重启 `openclaw-brainx` 生效。

```json
{
  "version": 1,
  "hooks": [
    {
      "id": "someone-private-launch",
      "priority": 96,
      "trigger": {
        "session": "direct",
        "sender_open_id": "ou_xxx",
        "keywords_all": ["接单"]
      },
      "action": {
        "type": "accept_job",
        "job_id": "JC3V82F",
        "job_label": "JC3V82F 北京脑利科技 CEO助理",
        "idempotency_key": "someone-private-launch-JC3V82F",
        "account_id": "mia"
      }
    }
  ]
}
```

### trigger（触发条件）

- `session`：`"direct"`（私聊）或 `"group"`（群聊），必填。
- `sender_open_id`：可选。限定发送人 open_id；事件里能取到 sender 且不匹配时不触发（防他人误触）。
- `chat_id`：可选。`session=group` 时限定群（`oc_` 开头）。
- `keywords_all` / `keywords_any`：入站文本关键词，至少给一种。`all` 全含才触发，`any` 含一即触发。

### action（动作模板）

- `fixed_reply`：直接回固定文案，拦截 LLM。字段：`text`（字符串或按行数组，数组由引擎以 `\n` 连接——长文案必须用数组写法，避免单行超过门禁长度限制）。
- `accept_job`：私聊直调 `brainx_accept_job`（接单 + 自动找人），按 already / search.status 分支回复。字段：`job_id`、`job_label`（回复里展示的职位名）、`idempotency_key`（缺省自动生成 `<id>-<job_id>`）、`account_id`（缺省 `mia`）、`replies`（可选，覆盖引擎默认文案，支持 `{{job_label}}` 占位符）。
- `offer_group`：私聊按候选人映射建/找 Offer 决策群并幂等发报告卡。字段：`candidates`（候选人姓名 → `{ group_name, report_doc_id, report_url, members }`）、`success_template`（可选，占位符 `{{name}}` `{{action}}` `{{group_name}}` `{{report_url}}`）、`no_match_reply`（可选）。

### priority

注册 `before_agent_reply` 的优先级，缺省 95。现有约定：群沉默纪律（mention-silence）= 100，per-user hook 用 90–96，都在 LLM 之前拦截。同一条消息最多被一个 hook 命中（先发者胜出），配置时确保各 hook 的 trigger 不重叠。

## 安全与降级边界

- 配置只放 open_id、chat_id、职位编号、文案等非密信息；密钥（飞书 app secret、网关 token、assertion secret）仍只走服务环境变量，**不得写入 user-hooks.json**。
- 引擎缓存入站文本用 `message_received`（`before_agent_reply` 的 event 不含原文，2026-09-17 根因）；进程重启丢缓存时 fail-open 交给 LLM，不误拦截。
- 配置文件缺失、损坏或单条配置非法：记 warn 日志并跳过，不拖垮插件其余能力。
- `offer_group` 缺飞书凭据时 fail-open；`accept_job` 缺网关凭据时由网关调用层按 `PLUGIN_NOT_CONFIGURED` 失败并回复用户。

## 验证方法

- 单元测试：`tests/user-hooks.test.mjs`（18 例）覆盖三种动作模板、触发/不触发边界、fail-open、纯配置开通新顾问。
- 改动后运行 `npm run verify:quick`；push 前按 [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md) 执行。
- 真机验收：配置重启发服务后，用目标顾问账号按 trigger 发消息，确认回复与网关调用（`agent_tool_calls` 表）符合预期。

## 相关文档

- [BrainX 文档书](README.md)
- [OpenClaw 多顾问生产运行手册](2026-09-03-openclaw-production-runbook.md)
- [BrainTex 同事开通与首次使用实用手册](2026-09-10-braintex-coworker-onboarding-runbook.md)
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)
- [安全操作手册](SECURITY.md)

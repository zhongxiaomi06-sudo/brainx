# Contract: Personal Model Profile API v1

所有接口复用 `brainx_session` Cookie。服务端从已验证 session 取得 `consultant_id` 与 `open_id`；请求体中的身份字段一律拒绝。

## `GET /api/v1/model-profile`

返回当前顾问状态和批准供应商目录，不读取密钥。

成功 `200`：

```json
{
  "schema_version": "personal_model_profile.v1",
  "ready": true,
  "agent_ready": true,
  "provider_id": "stepfun",
  "model_id": "step-3.5-flash",
  "status": "ACTIVE",
  "consent_version": "model-data-consent.v1",
  "consented_at": "2026-09-03T12:00:00.000Z",
  "configured_at": "2026-09-03T12:00:02.000Z",
  "providers": [
    { "id": "openai", "label": "OpenAI", "example_models": ["gpt-5.4"] },
    { "id": "anthropic", "label": "Anthropic", "example_models": ["claude-sonnet-4-6"] },
    { "id": "google", "label": "Google Gemini", "example_models": ["gemini-3-flash-preview"] },
    { "id": "stepfun", "label": "阶跃 StepFun", "example_models": ["step-3.5-flash", "step-3.7-flash"] }
  ]
}
```

未触发个人 Agent 时仍返回 `200`，其中 `agent_ready=false`、`ready=false` 和操作提示。

## `PUT /api/v1/model-profile`

请求最大 4 KiB：

```json
{
  "provider_id": "stepfun",
  "model_id": "step-3.5-flash",
  "api_key": "secret submitted in HTTPS body only",
  "consent": true,
  "consent_version": "model-data-consent.v1"
}
```

禁止字段：`consultant_id`、`open_id`、`agent_id`、`base_url`、`command`、`args`、`env`。

成功 `200`：返回与 GET 相同的非敏感状态。响应不得包含 `api_key`、key 尾号、供应商原始认证响应或 OpenClaw auth 对象。

错误：

| Code | HTTP | Meaning |
|---|---:|---|
| `UNAUTHORIZED` | 401 | Web session 无效 |
| `MODEL_CONFIG_DISABLED` | 503 | 生产功能开关未开 |
| `MODEL_CONSENT_REQUIRED` | 422 | 未确认或版本不符 |
| `MODEL_PROVIDER_INVALID` | 422 | 供应商不在批准目录 |
| `MODEL_ID_INVALID` | 422 | 模型 ID 格式非法 |
| `MODEL_KEY_INVALID` | 422 | 凭据为空、过长或含换行 |
| `PERSONAL_AGENT_NOT_READY` | 409 | 尚无该 open_id 的个人 Agent/binding |
| `MODEL_CONFIG_BUSY` | 409 | 本人已有配置操作在执行 |
| `OPENCLAW_UNAVAILABLE` | 503 | CLI/state 不可用或超时 |
| `MODEL_CONFIG_FAILED` | 502 | 受控配置步骤失败并已回滚 |
| `MODEL_ROLLBACK_FAILED` | 500 | 回滚失败，必须运维介入 |

日志只允许 request id、consultant id、provider/model、阶段、耗时和归一化错误码。

## `DELETE /api/v1/model-profile`

停用本人个人模型；无请求体。成功 `200` 返回 `status=DISABLED`。幂等：重复停用返回 `already=true`。

## OpenClaw route contract

- Feishu DM 首次到达后创建个人 Agent 和精确 `(channel=feishu, accountId, peer.kind=direct, peer.id=open_id)` binding。
- 个人配置只能作用于 binding 指向的 Agent。
- `tools.sessions.visibility=self`；`tools.agentToAgent.enabled=false`。
- `/model` 裸命令只改变当前 session；`-a`/`-g` 对普通用户拒绝。
- 群 peer 不解析为个人 Agent，且不使用 `consultant_model_profiles` 凭据。

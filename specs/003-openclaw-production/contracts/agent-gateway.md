# Contract: BrainX Agent Gateway v1

## Endpoint

`POST /internal/v1/agent/tools/{tool_name}`

Gateway 仅监听回环地址。Header：

- `Authorization: Bearer <BRAINX_AGENT_GATEWAY_TOKEN>`
- `Content-Type: application/json`

请求体：

```json
{
  "schema_version": "agent_tool_request.v1",
  "request_id": "uuid",
  "principal_assertion": "base64url(payload).base64url(signature)",
  "arguments": {},
  "client": {
    "plugin_version": "1.0.0",
    "openclaw_version": "2026.7.1-2",
    "model_ref": "optional"
  }
}
```

Body 上限 64 KiB；超出返回 413。只接受 POST 和单段白名单工具名。

## Principal payload

```json
{
  "schema_version": "brainx_principal.v1",
  "request_id": "uuid",
  "nonce": "base64url-random",
  "channel": "feishu",
  "account_id": "openclaw-account-id",
  "requester_sender_id": "ou_xxx",
  "chat_type": "p2p",
  "chat_id": "opaque-id",
  "thread_id": null,
  "purpose": "daily_brief",
  "tool_name": "brainx_daily_brief",
  "arguments_sha256": "hex",
  "issued_at": "ISO-8601",
  "expires_at": "ISO-8601"
}
```

签名输入是 payload 的 canonical JSON UTF-8 字节；HMAC-SHA256；有效期默认 60 秒且不得超过 120 秒。`request_id` 必须与请求体一致，arguments hash 必须匹配，nonce/request_id 原子消费一次。

## Approved tools

所有参数对象均 `additionalProperties:false`；下表未出现的身份/权限字段一律非法。

| Tool | Arguments | Purpose | Limit |
|---|---|---|---|
| `brainx_me_context` | `{}` | self_context | 1 result |
| `brainx_daily_brief` | `{date?,limit?}` | daily_brief | limit 1..10 |
| `brainx_job_assessment` | `{job_id}` | job_review | 1 job |
| `brainx_candidate_shortlist` | `{job_id,page_token?,limit?}` | candidate_review | p2p ≤5, group ≤3 |
| `brainx_candidate_facts` | `{candidate_ref,purpose}` | candidate_review/interview_prep | 1 candidate |
| `brainx_candidate_fit` | `{job_id,candidate_ref}` | candidate_review | 1 immutable match |
| `brainx_gap_questions` | `{object_type,object_ref,job_id?}` | job_review/candidate_review | ≤3 questions |
| `brainx_interview_prep` | `{job_id,candidate_ref}` | interview_prep | ≤12 questions |
| `brainx_personal_review` | `{date_from,date_to}` | personal_review | current consultant only |
| `brainx_run_status` | `{run_id}` | run_status | owned/authorized run only |

禁止参数名：`tenant_id`、`consultant_id`、`sender`、`open_id`、`scope`、`sql`、`url`、`command`、`file`。

## Success envelope

```json
{
  "schema_version": "agent_tool_response.v1",
  "request_id": "uuid",
  "run_id": "uuid",
  "tool_name": "brainx_daily_brief",
  "data": {},
  "facts": [],
  "inferences": [],
  "recommendations": [],
  "unknowns": [],
  "evidence_refs": [],
  "data_scope": {
    "tenant_ref": "self",
    "consultant_ref": "self",
    "chat_type": "p2p",
    "redaction_policy": "agent-field-policy.v1"
  },
  "source_versions": {},
  "generated_at": "ISO-8601",
  "next_allowed_actions": []
}
```

HTTP 200 表示工具成功执行，即使业务结果为空；空结果必须在 `unknowns` 或 `data.empty_reason` 说明。

## Error envelope

```json
{
  "error": {
    "code": "NOT_FOUND_OR_FORBIDDEN",
    "message": "当前会话无法读取该对象",
    "retryable": false,
    "request_id": "uuid"
  }
}
```

| Code | HTTP | Retry |
|---|---:|---|
| UNAUTHENTICATED | 401 | no |
| UNBOUND_IDENTITY | 403 | no |
| NOT_FOUND_OR_FORBIDDEN | 404 | no |
| INVALID_ARGUMENT | 422 | no |
| STALE_DATA | 409 | no |
| SOURCE_UNAVAILABLE | 503 | bounded |
| SUPERMAI_UNAVAILABLE | 503 | bounded |
| QUALITY_INSUFFICIENT | 409 | no |
| RATE_LIMITED | 429 | after retry-after |
| TOOL_DISABLED | 404 | no |
| REPLAYED_REQUEST | 409 | no |
| INTERNAL | 500 | no |

错误不得包含堆栈、SQL、源 token、对象存在性或其他顾问信息。

## Projection rules

### p2p

- 仅当前用途必要的授权事实和证据摘要。
- 默认不返回联系方式、完整原文、私人评价或源系统凭据。
- shortlist 上限 5。

### group

- 必须存在 ACTIVE group scope，sender 和 purpose 均获准。
- 候选人只返回脱敏姓名/短 ID、公开经历摘要、匹配证据和未知项。
- 删除电话、邮箱、薪资隐私、完整简历、私人备注和其他项目反馈。
- shortlist 上限 3。

## Health endpoint

`GET /internal/v1/agent/health` 仅回环可访问，返回进程状态、SQLite/RDS 可用状态、工具目录版本和工具名；不返回密钥、身份表内容或业务数据。

## Plugin contract

- manifest `contracts.tools` 必须与 Approved tools 完全一致。
- 工具 factory 缺 `requesterSenderId`、Feishu channel、accountId 或合法 `deliveryContext.to` 时返回本地拒绝，不发 HTTP。
- Gateway URL 固定来自插件配置/环境，工具参数不能覆盖。
- 插件只把 Gateway envelope 转为 text content + details，不二次扩权或拼接其他来源。

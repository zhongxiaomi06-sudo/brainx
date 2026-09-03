# Data Model: OpenClaw 多顾问生产化

## SQLite 决策域

### feishu_identity_bindings

App 维度实名绑定，一条 ACTIVE 绑定唯一确定一个租户和顾问。

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| binding_id | TEXT PK | UUID |
| tenant_id | TEXT NOT NULL | BrainX 租户 |
| channel_account_id | TEXT NOT NULL | OpenClaw Feishu account ID |
| feishu_app_key_hash | TEXT NOT NULL | App 稳定标识哈希，不存 secret |
| open_id | TEXT NOT NULL | 当前 App 下 sender open_id |
| union_id | TEXT NULL | 可获得时保存 |
| consultant_id | TEXT NOT NULL FK | 顾问 |
| employee_ref | TEXT NULL | 内部稳定员工 ID |
| binding_status | TEXT CHECK | PENDING/ACTIVE/REVOKED |
| verified_at/by | TEXT | 验证时间/管理员 |
| revoked_at | TEXT NULL | 撤销时间 |
| created_at/updated_at | TEXT | 审计时间 |

唯一性：`(channel_account_id, open_id)` 在 ACTIVE 状态只能解析一人；冲突时授权层拒绝。

### agent_group_scopes

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| group_scope_id | TEXT PK | UUID |
| tenant_id | TEXT NOT NULL | 群所属租户 |
| channel_account_id | TEXT NOT NULL | Feishu account |
| chat_id | TEXT NOT NULL | `deliveryContext.to` 去掉 `chat:` 后的值 |
| scope_status | TEXT CHECK | ACTIVE/REVOKED |
| allowed_purposes_json | TEXT | 允许用途数组 |
| allowed_senders_json | TEXT | 允许 open_id 数组；空数组表示无人 |
| project_refs_json | TEXT | 可选项目范围 |
| require_mention | INTEGER | 首期恒为 1 |
| created_at/updated_at/revoked_at | TEXT | 生命周期 |

### agent_runs

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| run_id | TEXT PK | 一次工具请求关联 ID |
| request_id | TEXT UNIQUE | assertion request ID |
| tenant_id/consultant_id | TEXT | 服务端解析结果 |
| channel/account_id/chat_type | TEXT | 渠道范围 |
| sender_hash/chat_id_hash | TEXT | 脱敏主体和会话 |
| purpose/tool_name | TEXT | 用途和工具 |
| status | TEXT CHECK | RECEIVED/AUTHORIZED/SUCCEEDED/REFUSED/FAILED |
| model_ref/skill_version | TEXT NULL | 插件提供的非授权元数据 |
| started_at/completed_at | TEXT | 时间 |
| error_code | TEXT NULL | 稳定错误码 |

### agent_tool_calls

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| tool_call_id | TEXT PK | UUID |
| run_id | TEXT FK | 关联 Agent run |
| tool_name/tool_version | TEXT | 固定目录版本 |
| arguments_hash/arguments_summary_json | TEXT | 脱敏参数摘要 |
| authorization_result/policy_version | TEXT | 裁决证据 |
| data_versions_json/evidence_refs_json | TEXT | 数据版本和证据引用 |
| status/duration_ms/error_code | TEXT | 结果 |
| created_at/completed_at | TEXT | 时间 |

### agent_nonces

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| nonce | TEXT PK | 一次性随机值 |
| request_id | TEXT UNIQUE | 请求 ID |
| expires_at | TEXT | 过期时间 |
| consumed_at | TEXT | 原子插入即消费 |

定期删除过期记录，但不得在验签成功前删除或复用。

### agent_rate_limits

`bucket_key` PK、`window_started_at`、`request_count`、`updated_at`。bucket 使用 tenant+consultant+tool 哈希，不存 open_id 明文。

### integration_jobs

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| job_id | TEXT PK | 稳定任务 ID |
| tenant_id/consultant_id | TEXT | 所属主体 |
| kind | TEXT | TALENT_SYNC/PARSE_DOCUMENT/MATCH_EVAL/SEARCH |
| idempotency_key | TEXT UNIQUE | 去重 |
| status | TEXT CHECK | PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED |
| payload_json/result_ref | TEXT | 最小输入/结果引用，不存原文 |
| attempts/max_attempts | INTEGER | 有界重试 |
| lease_owner/lease_expires_at | TEXT | 重启恢复租约 |
| cost_units/cost_limit | INTEGER | 次数/费用保护 |
| requested_at/started_at/completed_at | TEXT | 时间 |
| error_code/error_summary | TEXT | 脱敏错误 |

### integration_outbox

`outbox_id` PK、`job_id` FK、`channel`、`account_id`、`target_hash`、`thread_id_hash`、`payload_ref`、`status`、`attempts`、`next_attempt_at`、`sent_at`。首期只投递回原会话，发送前重新鉴权。

## MySQL 人才域

现有 `0001_candidate_data_v1.mjs` 和 `0002_job_access_grants.mjs` 已提供多数基础表。本功能只做 additive migration。

### source_sync_cursors 增强约束

游标键由 `(tenant_id, source_system, source_account_ref, entity_type)` 唯一确定；保存 cursor、最后源时间、最后成功 run、状态和错误。只有完整批次成功后前移游标。

### 撤权传播

授权从 ACTIVE 进入 REVOKED 后：

1. 新查询立即以数据库授权为准拒绝；
2. 对应缓存键和可选索引条目进入删除任务；
3. 未发送 outbox 再次授权检查并取消；
4. 已有不可变事实和审计保留，但不再可通过 Agent 投影读取。

### candidate_documents / candidate_fact_versions

- 文档由 source_ref + sha256 去重；原文存受控对象存储引用，不放 SQLite/日志。
- 质量状态：PENDING/PARSING/READY/OCR_REQUIRED/FAILED/REVOKED。
- 事实版本 immutable；`candidate_fact_v1` 验证通过后才能 READY。
- evidence 逐字段记录 source span/page（可得时）、hash、support 状态。

### match_runs / candidate_job_matches

- run 状态只有 SUCCEEDED 才可读；算法、特征 schema、职位版本固定。
- 候选人实力、职位匹配、硬条件、证据覆盖、风险分别存储。
- shadow 与 production 通过 `publication_status` 区分；切换不改历史。

## State Transitions

```text
Identity: PENDING → ACTIVE → REVOKED
Group scope: ACTIVE → REVOKED
Agent run: RECEIVED → AUTHORIZED → SUCCEEDED
                         ├→ REFUSED
                         └→ FAILED
Integration job: PENDING → RUNNING → SUCCEEDED
                              ├→ FAILED（可按上限重试回 PENDING）
                              └→ CANCELLED
Document: PENDING → PARSING → READY | OCR_REQUIRED | FAILED | REVOKED
Match run: PENDING → RUNNING → SUCCEEDED | FAILED | CANCELLED
```

## Cross-database Consistency

- 不使用跨库事务。
- SQLite run/job 先记录请求，再调用 RDS；结果只保存 RDS 稳定引用和版本。
- 读取时重新校验当前授权，不能仅依赖旧 run 的“当时有权”。
- 重放以 request_id/idempotency_key 返回同一终态引用，不重复通知。

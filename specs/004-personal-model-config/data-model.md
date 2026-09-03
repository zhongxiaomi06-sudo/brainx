# Data Model: 顾问个人模型配置

## `consultant_model_profiles`

BrainX 只保存非敏感审计投影；API Key 不进入本表。

| Field | Type | Rules |
|---|---|---|
| `consultant_id` | TEXT PK | 现有顾问 ID；只由登录 session 决定 |
| `feishu_account_id` | TEXT | 当前机器人账号，如 `mia` |
| `agent_id` | TEXT UNIQUE | OpenClaw binding 对应 Agent；不得由客户端提交 |
| `provider_id` | TEXT | 批准目录之一：openai/anthropic/google/stepfun |
| `model_id` | TEXT | 1—160 字符，严格模型 ID 格式 |
| `profile_id` | TEXT | 固定为该 provider 的 BrainX 用户 profile 名，不含密钥 |
| `status` | TEXT | `PENDING` / `ACTIVE` / `ERROR` / `DISABLED` |
| `consent_version` | TEXT | 当前提示版本 `model-data-consent.v1` |
| `consented_at` | TEXT | 用户明确同意时间；供应商改变必须更新 |
| `configured_at` | TEXT | OpenClaw 配置成功时间 |
| `disabled_at` | TEXT NULL | 停用时间 |
| `last_error_code` | TEXT NULL | 归一化错误码，不存供应商原文 |
| `updated_at` | TEXT | 最后变更时间 |

约束：

- `provider_id` 和 `status` 使用 CHECK；字段非空。
- 一个顾问只有一条当前配置，一个 OpenClaw Agent 只属于一个顾问。
- `ACTIVE` 必须同时存在 `consented_at` 和 `configured_at`。
- 更新状态不证明外部供应商余额或模型长期可用，只证明配置步骤成功。

## OpenClaw personal agent auth store

OpenClaw 自有 `<state-dir>/agents/<agentId>/agent/openclaw-agent.sqlite` 保存 credential profile。BrainX 不读取内部表，只通过官方 CLI 写入、列出元数据和删除。

关系：

```text
feishu_identity_bindings (ACTIVE)
  1 ── 1 consultant_model_profiles
          1 ── 1 OpenClaw agent binding
                  1 ── N provider auth profiles（首版每 provider 最多 1 个 BrainX profile）
```

## State transitions

```text
不存在 ──保存+同意──▶ PENDING ──CLI 全部成功──▶ ACTIVE
                           └──任一步失败──────▶ ERROR
ACTIVE ──替换凭据────────▶ PENDING ──成功────▶ ACTIVE
ACTIVE/ERROR ──停用──────▶ DISABLED
DISABLED ──重新保存+同意─▶ PENDING
```

部分失败纪律：

- API Key 已写入但 Agent model 写失败：立即删除本次 profile；BrainX 记 `ERROR`。
- Agent model 已写入但状态落库失败：恢复变更前 model/profile；若恢复也失败，返回 `ROLLBACK_FAILED` 并禁止声称成功。
- 停用先移除认证 profile，再清除 Agent 显式 model；任一步失败保留 `ERROR`，不得切到他人或全局凭据。

# Data Model: Step 1 飞书事件网关

对应迁移 0029；DDL 细节以[蓝图 §5 Step 1](../../docs/architecture-2026-09-01-full-blueprint.md)为准，本文件是实现契约。SQL 方言：SQLite（node:sqlite）。

## chat_contexts（0029）

```sql
CREATE TABLE IF NOT EXISTS chat_contexts (
  chat_id            TEXT PRIMARY KEY,        -- 飞书群 chat_id（oc_ 开头）
  enabled            INTEGER NOT NULL DEFAULT 1, -- 0/1 布尔（SQLite 无原生 bool）
  bot_mode           TEXT NOT NULL DEFAULT 'MENTION_ONLY', -- MENTION_ONLY | ALL
  default_deny_reason TEXT,                   -- 启停/未登记时的拒绝说明（可选）
  registered_at      TEXT NOT NULL,           -- ISO 8601
  updated_at         TEXT NOT NULL,           -- ISO 8601
  notes              TEXT                     -- 运营备注（非 PII 元数据）
);
```

> 不在事件路径动态注册：`registerChatContext` 由运营脚本/CLI 预填，`processLarkEvent` 只读不写此表。

## 复用 Step 0 表

- **workflow_event_log**：网关写入 `lark.message_received`（通过）/`lark.ignored`（DENY）；idem_key=`lark:message:<message_id>`；evidence_refs=`[{table:'chat_contexts',id:chat_id},{table:'lark_messages',id:message_id}]`。
- 不新建 `lark_event_dedupe`：入站幂等由 `idx_wel_idem` 兜底（FR-003）。
- ~~不新建 `lark_messages` 表~~（**2026-09-02 E1 实施时修订**）：本规格留待「后续规格决定」的消息正文落库，由提炼层 E1 落地——`migrations/0030_lark_messages.sql` 新建该表，`processLarkEvent` 通过事件时以 `persistLarkMessage`（INSERT OR IGNORE）落正文，账本 payload 仍不含正文 PII（FR-006 不变），evidence_refs 引用目标自此真实存在。权威契约见 `docs/2026-09-02-job-facts-extraction-roadmap.md` §4；DENY 事件仍不落正文。

## 信封映射契约（processLarkEvent 写入 workflow_event_log）

| 字段 | 通过（lark.message_received） | DENY（lark.ignored） |
|---|---|---|
| event_id | uuid() | uuid() |
| idem_key | `lark:message:<message_id>` | `lark:ignored:<chat_id>:<message_id>`（去重独立于通过事件） |
| event_type | `lark.message_received` | `lark.ignored` |
| case_id | null | null |
| actor | `user:<open_id>` | `user:<open_id>` |
| occurred_at | 消息 create_time（ISO） | 消息 create_time（ISO） |
| payload | `{message_type, chat_scope, bot_mode}` | `{message_type, chat_scope, reason}` |
| evidence_refs | `[{table:'chat_contexts',id:chat_id},{table:'lark_messages',id:message_id}]` | 同左 |
| schema_version | 1 | 1 |

> DENY 事件 idem_key 独立：同一 message_id 既可能 DENY（未登记）又可能在登记后重投通过，两类事件各自幂等不互相吃掉。

# Data Model: Step 0 事件账本

对应迁移 0023-0027；DDL 细节以[蓝图 §5 Step 0](../../docs/architecture-2026-09-01-full-blueprint.md)为准，本文件是 Codex 的实现契约。SQL 方言：SQLite（node:sqlite）。

## workflow_event_log（0023）

```sql
CREATE TABLE IF NOT EXISTS workflow_event_log (
  event_id       TEXT PRIMARY KEY,            -- uuid
  idem_key       TEXT NOT NULL,               -- 生产者幂等键（业务语义：event_type + 来源实体 + 序号）
  event_type     TEXT NOT NULL,               -- e.g. case.stage_advanced / sourcing.run_finished
  case_id        TEXT,                        -- 双轴实体锚点（可空：非 Case 事件）
  actor          TEXT NOT NULL,               -- 主语：user:<open_id> / agent:<tool> / system:<job>
  occurred_at    TEXT NOT NULL,               -- ISO 8601
  payload        TEXT NOT NULL,               -- JSON（经 envelope 校验）
  evidence_refs  TEXT NOT NULL DEFAULT '[]',  -- JSON 数组：仅引用（表名+主键），禁止 PII 正文
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wel_idem ON workflow_event_log(idem_key);
CREATE INDEX IF NOT EXISTS idx_wel_case ON workflow_event_log(case_id, occurred_at);
-- append-only：不提供 UPDATE/DELETE 路径；修正以补偿事件表达
```

## processed_events（0024）

```sql
CREATE TABLE IF NOT EXISTS processed_events (
  event_id      TEXT PRIMARY KEY,
  consumer_name TEXT NOT NULL,               -- e.g. bridge1-push-person
  processed_at  TEXT NOT NULL,
  UNIQUE(event_id, consumer_name)            -- 不同消费者各自幂等
);
```

## entity_links（0025）

```sql
CREATE TABLE IF NOT EXISTS entity_links (
  case_id       TEXT PRIMARY KEY REFERENCES cases(case_id),
  brainx_id     TEXT,
  talent_pool_id TEXT,
  reloop_id     TEXT,
  lark_open_id  TEXT,
  updated_at    TEXT NOT NULL
);
```

## cases（0026）

```sql
CREATE TABLE IF NOT EXISTS cases (
  case_id       TEXT PRIMARY KEY,            -- uuid（唯一跨系统锚点）
  position_id   TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,               -- 人选引用（不存明文 PII）
  milestone     TEXT NOT NULL DEFAULT 'DISCOVERED',
  outreach_state TEXT NOT NULL DEFAULT 'NOT_CONTACTED',
  version       INTEGER NOT NULL DEFAULT 1,  -- 乐观锁
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(position_id, candidate_ref)
);
```

合法 milestone 迁移表（`case-machine.js` 内常量）：DISCOVERED→QUALIFIED→CONSENTED→SUBMITTED→INTERVIEW→OFFER→PLACED；outreach 轴：NOT_CONTACTED→SENT→DELIVERED→REPLIED。非相邻跳跃一律拒绝并落 `case.transition_rejected` 事件。

## event_dlq（0027）

```sql
CREATE TABLE IF NOT EXISTS event_dlq (
  event_id     TEXT PRIMARY KEY,
  raw_payload  TEXT NOT NULL,
  reason       TEXT NOT NULL,                -- upcast_failed / schema_invalid
  failed_at    TEXT NOT NULL
);
```

## 索引与量级

当前量级（日均千级事件）下以上索引足够；`idx_wel_case` 支撑决策轨迹时间序读取（既有功能复用点）。

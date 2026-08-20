-- Braintex v2 新增表（开发文档 v2.0 §9，2026-08-05 定稿）
-- MySQL 8 语法约束：无 ILIKE / 无 CREATE INDEX IF NOT EXISTS / 无 NULLS LAST /
-- 无 ADD COLUMN IF NOT EXISTS；dict 绑 JSON 列前必须 json.dumps。
-- 所有表带 consultant_id 行级隔离；engagements 是 decision_events 的可重建投影。

CREATE TABLE IF NOT EXISTS decision_events (
  seq BIGINT NOT NULL AUTO_INCREMENT,   -- 插入顺序序号：回放权威排序（DATETIME 秒级精度会并列）
  event_id VARCHAR(40) PRIMARY KEY,
  consultant_id VARCHAR(64) NOT NULL,
  opportunity_id VARCHAR(64) NOT NULL,
  decision_id BIGINT NULL,
  event_type VARCHAR(24) NOT NULL,
  previous_state VARCHAR(16) DEFAULT '',
  next_state VARCHAR(16) DEFAULT '',
  actor VARCHAR(64) NOT NULL,
  reason_code VARCHAR(64) DEFAULT '',
  metadata_json JSON NOT NULL,
  policy_version VARCHAR(40) DEFAULT '',
  occurred_at DATETIME NOT NULL,
  recorded_at DATETIME NOT NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  UNIQUE KEY uq_seq (seq),
  UNIQUE KEY uq_idem (idempotency_key),
  KEY idx_consultant (consultant_id, opportunity_id),
  KEY idx_decision (decision_id)
);

CREATE TABLE IF NOT EXISTS engagements (
  consultant_id VARCHAR(64) NOT NULL,
  opportunity_id VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  state_version INT NOT NULL DEFAULT 0,
  last_event_id VARCHAR(40) NOT NULL,
  last_action_at DATETIME NOT NULL,
  expires_at DATETIME NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (consultant_id, opportunity_id)
);

CREATE TABLE IF NOT EXISTS outcome_observations (
  outcome_id VARCHAR(40) PRIMARY KEY,
  consultant_id VARCHAR(64) NOT NULL,
  opportunity_id VARCHAR(64) NOT NULL,
  scope VARCHAR(24) NOT NULL,           -- consultant_scoped(17) | team_aggregate；文档原稿 16 放不下，已修正
  source VARCHAR(24) NOT NULL,
  stage VARCHAR(24) DEFAULT '',
  value_json JSON NOT NULL,
  recorded_by VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  observed_at DATETIME NOT NULL,
  recorded_at DATETIME NOT NULL,
  UNIQUE KEY uq_outcome_idem (idempotency_key)
);

CREATE TABLE IF NOT EXISTS policy_versions (
  policy_version VARCHAR(40) PRIMARY KEY,
  consultant_id VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  weights_json JSON NOT NULL,
  bounds_json JSON NOT NULL,
  parent_version VARCHAR(40) DEFAULT '',
  metadata_json JSON,
  activated_at DATETIME NULL,
  rollback_reason VARCHAR(255) DEFAULT '',
  created_at DATETIME NOT NULL,
  KEY idx_consultant_kind (consultant_id, kind, status)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  sync_id VARCHAR(40) PRIMARY KEY,
  consultant_id VARCHAR(64) NOT NULL,
  source VARCHAR(24) NOT NULL,
  as_of DATETIME NOT NULL,
  rows_expected INT NULL,
  rows_read INT NOT NULL,
  complete TINYINT NOT NULL,
  errors_json JSON NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  started_at DATETIME NOT NULL,
  completed_at DATETIME NULL
);

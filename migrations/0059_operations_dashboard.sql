-- 0059: 阶段 10 运营/业务/效果/成本事件投影（specs/034）

CREATE TABLE operations_projection_events (
  sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key      TEXT NOT NULL UNIQUE,
  tenant_id      TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK(mode IN ('LIVE','SHADOW','SYSTEM')),
  occurred_at    TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  correction_of  TEXT,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  ingested_at    TEXT NOT NULL
);
CREATE INDEX idx_ope_tenant_sequence ON operations_projection_events(tenant_id, sequence);
CREATE INDEX idx_ope_tenant_source ON operations_projection_events(tenant_id, source_type, source_id);

CREATE TABLE operations_projection_checkpoints (
  tenant_id       TEXT PRIMARY KEY,
  metric_version  TEXT NOT NULL,
  last_sequence   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK(status IN ('READY','BACKLOG','FAILED','EMPTY')),
  error_count     INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE operations_projection_entities (
  tenant_id      TEXT NOT NULL,
  entity_key     TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  event_key      TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  mode           TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  sequence       INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, entity_key)
);
CREATE INDEX idx_ope_entities_source ON operations_projection_entities(tenant_id, source_type);

CREATE TABLE operations_dashboard_snapshots (
  tenant_id      TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  metric_version TEXT NOT NULL,
  checkpoint     INTEGER NOT NULL,
  event_count    INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,
  projected_at   TEXT NOT NULL
);

CREATE TABLE operations_projection_runs (
  projection_run_id TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK(mode IN ('INCREMENTAL','REBUILD')),
  status            TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED')),
  from_sequence     INTEGER NOT NULL,
  to_sequence       INTEGER,
  event_count       INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  error_code        TEXT
);
CREATE INDEX idx_opr_tenant_time ON operations_projection_runs(tenant_id, started_at DESC);

CREATE TABLE operations_backup_evidence (
  backup_id        TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED')),
  size_bytes       INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
  restore_verified INTEGER CHECK(restore_verified IS NULL OR restore_verified IN (0,1)),
  started_at       TEXT NOT NULL,
  completed_at     TEXT,
  recorded_at      TEXT NOT NULL
);
CREATE INDEX idx_obe_tenant_time ON operations_backup_evidence(tenant_id, recorded_at DESC);

-- 后续写入通过窄触发器变成归一事件；payload 只保留聚合所需字段。
CREATE TRIGGER ops_sync_insert AFTER INSERT ON sync_runs BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('sync:'||NEW.sync_id||':'||NEW.complete||':'||COALESCE(NEW.completed_at,NEW.started_at),
    'brainx','sync',NEW.sync_id,
    CASE WHEN NEW.complete=1 THEN 'SYNC_COMPLETED' WHEN NEW.errors!='[]' THEN 'SYNC_FAILED' ELSE 'SYNC_INCOMPLETE' END,
    'SYSTEM',COALESCE(NEW.completed_at,NEW.started_at),COALESCE(NEW.completed_at,NEW.started_at),
    json_object('complete',NEW.complete,'rows_read',NEW.rows_read,'rows_expected',NEW.rows_expected,'errors',NEW.errors),
    COALESCE(NEW.completed_at,NEW.started_at));
END;
CREATE TRIGGER ops_sync_update AFTER UPDATE ON sync_runs BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('sync:'||NEW.sync_id||':'||NEW.complete||':'||COALESCE(NEW.completed_at,NEW.started_at),
    'brainx','sync',NEW.sync_id,
    CASE WHEN NEW.complete=1 THEN 'SYNC_COMPLETED' WHEN NEW.errors!='[]' THEN 'SYNC_FAILED' ELSE 'SYNC_INCOMPLETE' END,
    'SYSTEM',COALESCE(NEW.completed_at,NEW.started_at),COALESCE(NEW.completed_at,NEW.started_at),
    json_object('complete',NEW.complete,'rows_read',NEW.rows_read,'rows_expected',NEW.rows_expected,'errors',NEW.errors),
    COALESCE(NEW.completed_at,NEW.started_at));
END;

CREATE TRIGGER ops_integration_job_insert AFTER INSERT ON integration_jobs BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('job:'||NEW.job_id||':'||NEW.status||':'||NEW.updated_at,NEW.tenant_id,'integration_job',NEW.job_id,
    'JOB_'||NEW.status,'SYSTEM',NEW.updated_at,NEW.updated_at,
    json_object('status',NEW.status,'kind',NEW.kind,'attempts',NEW.attempts,'error_code',NEW.error_code),NEW.updated_at);
END;
CREATE TRIGGER ops_integration_job_update AFTER UPDATE ON integration_jobs BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('job:'||NEW.job_id||':'||NEW.status||':'||NEW.updated_at,NEW.tenant_id,'integration_job',NEW.job_id,
    'JOB_'||NEW.status,'SYSTEM',NEW.updated_at,NEW.updated_at,
    json_object('status',NEW.status,'kind',NEW.kind,'attempts',NEW.attempts,'error_code',NEW.error_code),NEW.updated_at);
END;

CREATE TRIGGER ops_ranking_run_insert AFTER INSERT ON agentic_ranking_runs BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('ranking:'||NEW.run_id||':'||NEW.status||':'||COALESCE(NEW.finished_at,NEW.created_at),
    NEW.tenant_id,'ranking_run',NEW.run_id,'RANKING_'||NEW.status,NEW.run_mode,
    COALESCE(NEW.finished_at,NEW.created_at),COALESCE(NEW.finished_at,NEW.created_at),
    json_object('status',NEW.status,'eligible_count',NEW.eligible_count,'retrieved_count',NEW.retrieved_count,
      'reviewed_count',NEW.reviewed_count,'failure_code',NEW.failure_code),COALESCE(NEW.finished_at,NEW.created_at));
END;
CREATE TRIGGER ops_ranking_run_update AFTER UPDATE ON agentic_ranking_runs BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('ranking:'||NEW.run_id||':'||NEW.status||':'||COALESCE(NEW.finished_at,NEW.created_at),
    NEW.tenant_id,'ranking_run',NEW.run_id,'RANKING_'||NEW.status,NEW.run_mode,
    COALESCE(NEW.finished_at,NEW.created_at),COALESCE(NEW.finished_at,NEW.created_at),
    json_object('status',NEW.status,'eligible_count',NEW.eligible_count,'retrieved_count',NEW.retrieved_count,
      'reviewed_count',NEW.reviewed_count,'failure_code',NEW.failure_code),COALESCE(NEW.finished_at,NEW.created_at));
END;
CREATE TRIGGER ops_ranking_item_insert AFTER INSERT ON agentic_ranking_items BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('ranking-item:'||NEW.decision_id,NEW.tenant_id,'ranking_item',NEW.decision_id,'RANKING_ITEM',
    COALESCE((SELECT run_mode FROM agentic_ranking_runs WHERE run_id=NEW.run_id),'LIVE'),
    NEW.created_at,NEW.created_at,json_object('run_id',NEW.run_id,'rank',NEW.rank,'job_id',NEW.job_id),NEW.created_at);
END;

CREATE TRIGGER ops_usage_insert AFTER INSERT ON agent_usage_calls BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('usage:'||NEW.call_id||':'||NEW.status||':'||COALESCE(NEW.completed_at,NEW.started_at),
    NEW.tenant_id,'usage',NEW.call_id,'USAGE_'||NEW.status,
    COALESCE((SELECT run_mode FROM agentic_ranking_runs WHERE run_id=NEW.run_id),'LIVE'),
    COALESCE(NEW.completed_at,NEW.started_at),COALESCE(NEW.completed_at,NEW.started_at),
    json_object('status',NEW.status,'usage_status',NEW.usage_status,'total_tokens',NEW.total_tokens,
      'estimated_cost_micros',NEW.estimated_cost_micros,'latency_ms',NEW.latency_ms),COALESCE(NEW.completed_at,NEW.started_at));
END;
CREATE TRIGGER ops_usage_update AFTER UPDATE ON agent_usage_calls BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('usage:'||NEW.call_id||':'||NEW.status||':'||COALESCE(NEW.completed_at,NEW.started_at),
    NEW.tenant_id,'usage',NEW.call_id,'USAGE_'||NEW.status,
    COALESCE((SELECT run_mode FROM agentic_ranking_runs WHERE run_id=NEW.run_id),'LIVE'),
    COALESCE(NEW.completed_at,NEW.started_at),COALESCE(NEW.completed_at,NEW.started_at),
    json_object('status',NEW.status,'usage_status',NEW.usage_status,'total_tokens',NEW.total_tokens,
      'estimated_cost_micros',NEW.estimated_cost_micros,'latency_ms',NEW.latency_ms),COALESCE(NEW.completed_at,NEW.started_at));
END;

CREATE TRIGGER ops_exposure_insert AFTER INSERT ON recommendation_exposure_events BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('exposure:'||NEW.exposure_event_id,NEW.tenant_id,'exposure',NEW.exposure_event_id,
    'EXPOSURE_'||NEW.event_type,'LIVE',NEW.occurred_at,NEW.received_at,
    json_object('decision_id',NEW.decision_id,'position',NEW.position,'channel',NEW.channel),NEW.received_at);
END;
CREATE TRIGGER ops_decision_insert AFTER INSERT ON decision_events BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('decision:'||NEW.event_id,'brainx','decision',NEW.event_id,'DECISION_'||NEW.event_type,'LIVE',
    NEW.occurred_at,COALESCE(NEW.received_at,NEW.occurred_at),
    json_object('decision_id',NEW.decision_id,'state',NEW.next_state),COALESCE(NEW.received_at,NEW.occurred_at));
END;
CREATE TRIGGER ops_outcome_insert AFTER INSERT ON business_outcome_events BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,correction_of,payload_json,ingested_at)
  VALUES ('outcome:'||NEW.outcome_event_id,NEW.tenant_id,'business_outcome',NEW.source_event_id,
    'OUTCOME_'||NEW.event_kind,'LIVE',NEW.occurred_at,NEW.received_at,NEW.correction_of,
    json_object('decision_id',NEW.decision_id,'stage',NEW.stage,'attributed',NEW.attributed),NEW.received_at);
END;

CREATE TRIGGER ops_shadow_insert AFTER INSERT ON shadow_evaluation_runs BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('shadow:'||NEW.shadow_run_id||':'||NEW.status||':'||COALESCE(NEW.finished_at,NEW.created_at),
    NEW.tenant_id,'shadow_evaluation',NEW.shadow_run_id,'SHADOW_'||NEW.status,'SHADOW',
    COALESCE(NEW.finished_at,NEW.created_at),COALESCE(NEW.finished_at,NEW.created_at),
    json_object('status',NEW.status,'segment',NEW.segment,'metrics',NEW.metrics_json,
      'hard_violation_count',NEW.hard_violation_count),COALESCE(NEW.finished_at,NEW.created_at));
END;
CREATE TRIGGER ops_shadow_update AFTER UPDATE ON shadow_evaluation_runs BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('shadow:'||NEW.shadow_run_id||':'||NEW.status||':'||COALESCE(NEW.finished_at,NEW.created_at),
    NEW.tenant_id,'shadow_evaluation',NEW.shadow_run_id,'SHADOW_'||NEW.status,'SHADOW',
    COALESCE(NEW.finished_at,NEW.created_at),COALESCE(NEW.finished_at,NEW.created_at),
    json_object('status',NEW.status,'segment',NEW.segment,'metrics',NEW.metrics_json,
      'hard_violation_count',NEW.hard_violation_count),COALESCE(NEW.finished_at,NEW.created_at));
END;
CREATE TRIGGER ops_fact_version_insert AFTER INSERT ON job_fact_versions BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('fact:'||NEW.fact_version,NEW.tenant_id,'job_fact_version',NEW.fact_version,'JOB_FACT_VERSION','SYSTEM',
    NEW.observed_at,NEW.recorded_at,json_object('job_id',NEW.job_id,'version',NEW.version,'source_type',NEW.source_type),NEW.recorded_at);
END;
CREATE TRIGGER ops_push_insert AFTER INSERT ON push_log BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('push:'||NEW.push_id||':'||NEW.status,'brainx','push',NEW.push_id,'PUSH_'||NEW.status,'SYSTEM',
    NEW.created_at,NEW.created_at,json_object('status',NEW.status,'kind',NEW.kind),NEW.created_at);
END;
CREATE TRIGGER ops_backup_insert AFTER INSERT ON operations_backup_evidence BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('backup:'||NEW.backup_id||':'||NEW.status,NEW.tenant_id,'backup',NEW.backup_id,'BACKUP_'||NEW.status,'SYSTEM',
    COALESCE(NEW.completed_at,NEW.started_at),NEW.recorded_at,
    json_object('status',NEW.status,'size_bytes',NEW.size_bytes,'restore_verified',NEW.restore_verified,
      'completed_at',NEW.completed_at),NEW.recorded_at);
END;
CREATE TRIGGER ops_backup_update AFTER UPDATE ON operations_backup_evidence BEGIN
  INSERT OR IGNORE INTO operations_projection_events
  (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
  VALUES ('backup:'||NEW.backup_id||':'||NEW.status,NEW.tenant_id,'backup',NEW.backup_id,'BACKUP_'||NEW.status,'SYSTEM',
    COALESCE(NEW.completed_at,NEW.started_at),NEW.recorded_at,
    json_object('status',NEW.status,'size_bytes',NEW.size_bytes,'restore_verified',NEW.restore_verified,
      'completed_at',NEW.completed_at),NEW.recorded_at);
END;

-- 已有库只把当前稳定事实回填一次；历史状态不反推、不伪造。
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'sync:'||sync_id||':'||complete||':'||COALESCE(completed_at,started_at),'brainx','sync',sync_id,
  CASE WHEN complete=1 THEN 'SYNC_COMPLETED' WHEN errors!='[]' THEN 'SYNC_FAILED' ELSE 'SYNC_INCOMPLETE' END,
  'SYSTEM',COALESCE(completed_at,started_at),COALESCE(completed_at,started_at),
  json_object('complete',complete,'rows_read',rows_read,'rows_expected',rows_expected,'errors',errors),
  COALESCE(completed_at,started_at) FROM sync_runs;
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'ranking:'||run_id||':'||status||':'||COALESCE(finished_at,created_at),tenant_id,'ranking_run',run_id,
  'RANKING_'||status,run_mode,COALESCE(finished_at,created_at),COALESCE(finished_at,created_at),
  json_object('status',status,'eligible_count',eligible_count,'retrieved_count',retrieved_count,
    'reviewed_count',reviewed_count,'failure_code',failure_code),COALESCE(finished_at,created_at)
  FROM agentic_ranking_runs;
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'job:'||job_id||':'||status||':'||updated_at,tenant_id,'integration_job',job_id,'JOB_'||status,'SYSTEM',
  updated_at,updated_at,json_object('status',status,'kind',kind,'attempts',attempts,'error_code',error_code),updated_at
  FROM integration_jobs;
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'ranking-item:'||i.decision_id,i.tenant_id,'ranking_item',i.decision_id,'RANKING_ITEM',r.run_mode,
  i.created_at,i.created_at,json_object('run_id',i.run_id,'rank',i.rank,'job_id',i.job_id),i.created_at
  FROM agentic_ranking_items i JOIN agentic_ranking_runs r USING(run_id);
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'usage:'||u.call_id||':'||u.status||':'||COALESCE(u.completed_at,u.started_at),u.tenant_id,'usage',u.call_id,
  'USAGE_'||u.status,COALESCE(r.run_mode,'LIVE'),COALESCE(u.completed_at,u.started_at),
  COALESCE(u.completed_at,u.started_at),json_object('status',u.status,'usage_status',u.usage_status,
    'total_tokens',u.total_tokens,'estimated_cost_micros',u.estimated_cost_micros,'latency_ms',u.latency_ms),
  COALESCE(u.completed_at,u.started_at) FROM agent_usage_calls u LEFT JOIN agentic_ranking_runs r USING(run_id);
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'exposure:'||exposure_event_id,tenant_id,'exposure',exposure_event_id,'EXPOSURE_'||event_type,'LIVE',
  occurred_at,received_at,json_object('decision_id',decision_id,'position',position,'channel',channel),received_at
  FROM recommendation_exposure_events;
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'decision:'||event_id,'brainx','decision',event_id,'DECISION_'||event_type,'LIVE',occurred_at,
  COALESCE(received_at,occurred_at),json_object('decision_id',decision_id,'state',next_state),
  COALESCE(received_at,occurred_at) FROM decision_events;
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,correction_of,payload_json,ingested_at)
SELECT 'outcome:'||outcome_event_id,tenant_id,'business_outcome',source_event_id,'OUTCOME_'||event_kind,'LIVE',
  occurred_at,received_at,correction_of,json_object('decision_id',decision_id,'stage',stage,'attributed',attributed),received_at
  FROM business_outcome_events;
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'fact:'||fact_version,tenant_id,'job_fact_version',fact_version,'JOB_FACT_VERSION','SYSTEM',observed_at,recorded_at,
  json_object('job_id',job_id,'version',version,'source_type',source_type),recorded_at FROM job_fact_versions;
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'shadow:'||shadow_run_id||':'||status||':'||COALESCE(finished_at,created_at),tenant_id,
  'shadow_evaluation',shadow_run_id,'SHADOW_'||status,'SHADOW',COALESCE(finished_at,created_at),
  COALESCE(finished_at,created_at),json_object('status',status,'segment',segment,'metrics',metrics_json,
    'hard_violation_count',hard_violation_count),COALESCE(finished_at,created_at) FROM shadow_evaluation_runs;
INSERT OR IGNORE INTO operations_projection_events
(event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,payload_json,ingested_at)
SELECT 'push:'||push_id||':'||status,'brainx','push',push_id,'PUSH_'||status,'SYSTEM',created_at,created_at,
  json_object('status',status,'kind',kind),created_at FROM push_log;

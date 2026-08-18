CREATE TABLE IF NOT EXISTS recommendations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  rec_date DATE NOT NULL,
  consultant VARCHAR(64) NOT NULL DEFAULT '',
  job_signal_fingerprint VARCHAR(64) NOT NULL,
  job_title VARCHAR(255) DEFAULT '',
  company VARCHAR(255) DEFAULT '',
  signal_type VARCHAR(32) DEFAULT '',
  jd_text_snapshot TEXT,
  total_score DOUBLE NOT NULL,
  reasons_json JSON NOT NULL,
  trial_candidates_json JSON NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  ignore_reason VARCHAR(255) DEFAULT '',
  weight_version INT NOT NULL DEFAULT 1,
  action VARCHAR(24) NOT NULL DEFAULT '',
  confidence_band VARCHAR(8) NOT NULL DEFAULT '',
  evidence_coverage DOUBLE NOT NULL DEFAULT 0,
  policy_version VARCHAR(40) NOT NULL DEFAULT '',
  sent_at DATETIME NULL,
  send_attempts INT NOT NULL DEFAULT 0,
  last_send_error VARCHAR(255) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rec (rec_date, consultant, job_signal_fingerprint)
);

CREATE TABLE IF NOT EXISTS weight_config (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  version INT NOT NULL,
  weights_json JSON NOT NULL,
  change_source VARCHAR(16) NOT NULL DEFAULT 'slider',
  change_note VARCHAR(255) DEFAULT '',
  changed_by VARCHAR(64) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_version (version)
);

CREATE TABLE IF NOT EXISTS adoption_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  recommendation_id BIGINT NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(16) NOT NULL,
  actor VARCHAR(64) DEFAULT '',
  detail_json JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_request (request_id),
  KEY idx_rec (recommendation_id)
);

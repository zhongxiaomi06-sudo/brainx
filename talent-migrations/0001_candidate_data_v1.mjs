/** Additive RDS schema for versioned candidate facts, authorization and matching. */
export const statements = [
  `CREATE TABLE IF NOT EXISTS \`talent_access_grants\` (
    \`grant_id\` varchar(64) NOT NULL,
    \`tenant_id\` varchar(64) NOT NULL,
    \`talent_id\` bigint(20) NOT NULL,
    \`source_system\` varchar(40) NOT NULL,
    \`source_account_ref\` varchar(160) NOT NULL,
    \`grantor_consultant_id\` varchar(64) NOT NULL,
    \`grantee_type\` enum('consultant','project','team_service') NOT NULL,
    \`grantee_ref\` varchar(160) NOT NULL,
    \`scope\` enum('metadata','resume_facts','contact','private_notes') NOT NULL,
    \`purpose\` varchar(80) NOT NULL,
    \`status\` enum('ACTIVE','REVOKED','EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    \`granted_at\` datetime(3) NOT NULL,
    \`expires_at\` datetime(3) DEFAULT NULL,
    \`revoked_at\` datetime(3) DEFAULT NULL,
    \`source_proof_ref\` varchar(255) DEFAULT NULL,
    PRIMARY KEY (\`grant_id\`),
    KEY \`idx_grant_lookup\` (\`tenant_id\`, \`talent_id\`, \`grantee_type\`, \`grantee_ref\`, \`status\`),
    CONSTRAINT \`fk_access_grant_talent\` FOREIGN KEY (\`talent_id\`) REFERENCES \`talent\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='人才访问授权账本'`,

  `CREATE TABLE IF NOT EXISTS \`candidate_documents\` (
    \`document_id\` varchar(64) NOT NULL,
    \`talent_id\` bigint(20) NOT NULL,
    \`source_system\` varchar(40) NOT NULL,
    \`source_document_ref\` varchar(160) NOT NULL,
    \`source_format\` enum('pdf','docx','text','legacy_text') NOT NULL,
    \`content_hash\` char(64) NOT NULL,
    \`parser_version\` varchar(120) NOT NULL,
    \`quality_status\` enum('PENDING','READY','NEEDS_REVIEW','OCR_REQUIRED','REJECTED') NOT NULL,
    \`ingested_at\` datetime(3) NOT NULL,
    \`processed_at\` datetime(3) DEFAULT NULL,
    PRIMARY KEY (\`document_id\`),
    UNIQUE KEY \`uk_candidate_document_hash\` (\`talent_id\`, \`content_hash\`),
    CONSTRAINT \`fk_candidate_document_talent\` FOREIGN KEY (\`talent_id\`) REFERENCES \`talent\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='候选人文档版本与处理状态'`,

  `CREATE TABLE IF NOT EXISTS \`candidate_fact_versions\` (
    \`fact_version_id\` varchar(64) NOT NULL,
    \`tenant_id\` varchar(64) NOT NULL,
    \`talent_id\` bigint(20) NOT NULL,
    \`candidate_ref\` varchar(160) NOT NULL,
    \`document_id\` varchar(64) NOT NULL,
    \`schema_version\` varchar(40) NOT NULL,
    \`facts_json\` json NOT NULL,
    \`evidence_coverage\` decimal(5,4) NOT NULL,
    \`quality_status\` enum('READY','NEEDS_REVIEW','OCR_REQUIRED','REJECTED') NOT NULL,
    \`created_at\` datetime(3) NOT NULL,
    PRIMARY KEY (\`fact_version_id\`),
    KEY \`idx_fact_candidate\` (\`tenant_id\`, \`candidate_ref\`, \`created_at\`),
    KEY \`idx_fact_talent\` (\`talent_id\`, \`created_at\`),
    CONSTRAINT \`fk_fact_talent\` FOREIGN KEY (\`talent_id\`) REFERENCES \`talent\` (\`id\`) ON DELETE CASCADE,
    CONSTRAINT \`fk_fact_document\` FOREIGN KEY (\`document_id\`) REFERENCES \`candidate_documents\` (\`document_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='candidate_fact_v1 不可变版本'`,

  `CREATE TABLE IF NOT EXISTS \`candidate_fact_evidence\` (
    \`evidence_id\` varchar(64) NOT NULL,
    \`fact_version_id\` varchar(64) NOT NULL,
    \`field_path\` varchar(240) NOT NULL,
    \`source_ref\` varchar(160) NOT NULL,
    \`page_number\` int DEFAULT NULL,
    \`section_name\` varchar(200) DEFAULT NULL,
    \`char_start\` int DEFAULT NULL,
    \`char_end\` int DEFAULT NULL,
    \`excerpt_hash\` char(64) NOT NULL,
    \`created_at\` datetime(3) NOT NULL,
    PRIMARY KEY (\`evidence_id\`),
    KEY \`idx_evidence_fact\` (\`fact_version_id\`, \`field_path\`),
    CONSTRAINT \`fk_evidence_fact\` FOREIGN KEY (\`fact_version_id\`) REFERENCES \`candidate_fact_versions\` (\`fact_version_id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='候选人事实证据锚点，不存原文'`,

  `CREATE TABLE IF NOT EXISTS \`job_criteria_versions\` (
    \`job_version_id\` varchar(64) NOT NULL,
    \`tenant_id\` varchar(64) NOT NULL,
    \`external_job_ref\` varchar(160) NOT NULL,
    \`position_id\` bigint(20) DEFAULT NULL,
    \`schema_version\` varchar(40) NOT NULL,
    \`criteria_json\` json NOT NULL,
    \`source_hash\` char(64) NOT NULL,
    \`created_at\` datetime(3) NOT NULL,
    PRIMARY KEY (\`job_version_id\`),
    KEY \`idx_job_criteria_ref\` (\`tenant_id\`, \`external_job_ref\`, \`created_at\`),
    CONSTRAINT \`fk_job_criteria_position\` FOREIGN KEY (\`position_id\`) REFERENCES \`position\` (\`id\`) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='职位条件不可变版本'`,

  `CREATE TABLE IF NOT EXISTS \`match_runs\` (
    \`match_run_id\` varchar(64) NOT NULL,
    \`tenant_id\` varchar(64) NOT NULL,
    \`job_version_id\` varchar(64) NOT NULL,
    \`algorithm_version\` varchar(120) NOT NULL,
    \`feature_schema_version\` varchar(120) NOT NULL,
    \`status\` enum('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED') NOT NULL,
    \`candidate_count\` int NOT NULL DEFAULT 0,
    \`started_at\` datetime(3) NOT NULL,
    \`completed_at\` datetime(3) DEFAULT NULL,
    \`error_code\` varchar(80) DEFAULT NULL,
    PRIMARY KEY (\`match_run_id\`),
    KEY \`idx_match_run_job\` (\`tenant_id\`, \`job_version_id\`, \`status\`, \`completed_at\`),
    CONSTRAINT \`fk_match_run_job\` FOREIGN KEY (\`job_version_id\`) REFERENCES \`job_criteria_versions\` (\`job_version_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='职位匹配运行版本'`,

  `CREATE TABLE IF NOT EXISTS \`candidate_job_matches\` (
    \`match_run_id\` varchar(64) NOT NULL,
    \`talent_id\` bigint(20) NOT NULL,
    \`fact_version_id\` varchar(64) NOT NULL,
    \`rank\` int NOT NULL,
    \`strength_score\` decimal(5,2) NOT NULL,
    \`job_fit_score\` decimal(5,2) NOT NULL,
    \`hard_filter_result\` enum('PASS','FAIL','UNKNOWN') NOT NULL,
    \`payload_json\` json NOT NULL,
    \`created_at\` datetime(3) NOT NULL,
    PRIMARY KEY (\`match_run_id\`, \`talent_id\`),
    UNIQUE KEY \`uk_match_run_rank\` (\`match_run_id\`, \`rank\`),
    CONSTRAINT \`fk_candidate_match_run\` FOREIGN KEY (\`match_run_id\`) REFERENCES \`match_runs\` (\`match_run_id\`) ON DELETE CASCADE,
    CONSTRAINT \`fk_candidate_match_talent\` FOREIGN KEY (\`talent_id\`) REFERENCES \`talent\` (\`id\`) ON DELETE CASCADE,
    CONSTRAINT \`fk_candidate_match_fact\` FOREIGN KEY (\`fact_version_id\`) REFERENCES \`candidate_fact_versions\` (\`fact_version_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='candidate_match_bundle_v1 排名明细'`,

  `CREATE TABLE IF NOT EXISTS \`source_sync_cursors\` (
    \`tenant_id\` varchar(64) NOT NULL,
    \`source_system\` varchar(40) NOT NULL,
    \`source_account_ref\` varchar(160) NOT NULL,
    \`cursor_kind\` varchar(40) NOT NULL,
    \`cursor_value\` varchar(500) NOT NULL,
    \`updated_at\` datetime(3) NOT NULL,
    PRIMARY KEY (\`tenant_id\`, \`source_system\`, \`source_account_ref\`, \`cursor_kind\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='外部人才源增量同步游标'`,
];

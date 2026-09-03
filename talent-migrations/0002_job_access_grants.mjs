/** Additive authorization ledger for candidate shortlist jobs. */
export const statements = [
  `CREATE TABLE IF NOT EXISTS \`candidate_source_links\` (
    \`tenant_id\` varchar(64) NOT NULL,
    \`source_system\` varchar(40) NOT NULL,
    \`source_candidate_ref\` varchar(160) NOT NULL,
    \`talent_id\` bigint(20) NOT NULL,
    \`created_at\` datetime(3) NOT NULL,
    PRIMARY KEY (\`tenant_id\`, \`source_system\`, \`source_candidate_ref\`),
    UNIQUE KEY \`uk_candidate_source_talent\` (\`tenant_id\`, \`source_system\`, \`talent_id\`),
    CONSTRAINT \`fk_candidate_source_talent\` FOREIGN KEY (\`talent_id\`) REFERENCES \`talent\` (\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='外部候选人与内部影子人才稳定映射'`,

  `CREATE TABLE IF NOT EXISTS \`job_access_grants\` (
    \`grant_id\` varchar(64) NOT NULL,
    \`tenant_id\` varchar(64) NOT NULL,
    \`external_job_ref\` varchar(160) NOT NULL,
    \`source_system\` varchar(40) NOT NULL,
    \`source_account_ref\` varchar(160) NOT NULL,
    \`grantor_consultant_id\` varchar(64) NOT NULL,
    \`grantee_type\` enum('consultant','team_service') NOT NULL,
    \`grantee_ref\` varchar(160) NOT NULL,
    \`purpose\` varchar(80) NOT NULL,
    \`status\` enum('ACTIVE','REVOKED','EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    \`granted_at\` datetime(3) NOT NULL,
    \`expires_at\` datetime(3) DEFAULT NULL,
    \`revoked_at\` datetime(3) DEFAULT NULL,
    \`source_proof_ref\` varchar(255) DEFAULT NULL,
    PRIMARY KEY (\`grant_id\`),
    KEY \`idx_job_grant_lookup\` (\`tenant_id\`, \`external_job_ref\`, \`grantee_type\`, \`grantee_ref\`, \`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='候选推荐职位访问授权账本'`,
];

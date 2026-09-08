-- 0043: TTC 凭证仍只保存一份；经明确授权后可用于指定顾问的 OpenMai 寻访。
CREATE TABLE ttc_credential_grants (
  grant_id                  TEXT PRIMARY KEY,
  source_consultant_id      TEXT NOT NULL REFERENCES consultants(consultant_id),
  grantee_consultant_id     TEXT NOT NULL REFERENCES consultants(consultant_id),
  purpose                   TEXT NOT NULL CHECK(purpose IN ('OPENMAI')),
  grant_status              TEXT NOT NULL CHECK(grant_status IN ('ACTIVE','REVOKED')),
  granted_by                TEXT NOT NULL,
  reason                    TEXT NOT NULL,
  granted_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  revoked_at                TEXT,
  CHECK(source_consultant_id <> grantee_consultant_id)
);

CREATE UNIQUE INDEX idx_ttc_grants_active_grantee_purpose
  ON ttc_credential_grants(grantee_consultant_id, purpose)
  WHERE grant_status='ACTIVE';

CREATE INDEX idx_ttc_grants_source
  ON ttc_credential_grants(source_consultant_id, grant_status);

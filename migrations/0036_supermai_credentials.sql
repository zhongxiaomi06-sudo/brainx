-- SuperMai 云端 sourcing API 凭证表（2026-09-03）。
-- 与 ttc_tokens 同安全纪律：AES-GCM 加密存储，永不进日志/响应。
CREATE TABLE IF NOT EXISTS supermai_credentials (
  consultant_id      TEXT PRIMARY KEY REFERENCES consultants(consultant_id),
  cloud_base_url_enc TEXT NOT NULL,               -- AES-GCM 加密的 SuperMai 云端 baseUrl
  token_enc          TEXT NOT NULL,               -- AES-GCM 加密的 Bearer token
  needs_reauth       INTEGER NOT NULL DEFAULT 0,  -- 401/403 时置 1，前端提示重连
  updated_at         TEXT NOT NULL
);

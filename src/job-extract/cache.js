/** cache.js — 按租户、授权范围和内容版本隔离的职位提炼缓存（specs/028）。 */
import { now } from '../db.js';
import { sha256 } from '../job-source-contract.js';

export async function extractWithCache(db, {
  tenantId,
  scopeId,
  text,
  extractorVersion,
  modelId,
  promptVersion,
  extractor,
}) {
  if (typeof extractor !== 'function') throw new TypeError('extractor 必须是函数');
  const tenant = String(tenantId || '').trim();
  const scope = String(scopeId || '').trim();
  if (!tenant || !scope) throw new TypeError('tenantId/scopeId 必填');
  const scopeHash = sha256(scope);
  const contentHash = sha256(String(text ?? '').trim());
  const key = sha256({ tenant, scopeHash, contentHash, extractorVersion, modelId, promptVersion });
  const cached = db.prepare('SELECT result_json FROM job_extraction_cache WHERE cache_key=?').get(key);
  if (cached) {
    db.prepare(`UPDATE job_extraction_cache SET last_used_at=?, hit_count=hit_count+1
      WHERE cache_key=?`).run(now(), key);
    return { ...JSON.parse(cached.result_json), cached: true, cache_key: key };
  }
  const result = await extractor();
  const ts = now();
  db.prepare(`INSERT INTO job_extraction_cache
    (cache_key, tenant_id, scope_hash, content_hash, extractor_version, model_id,
     prompt_version, result_json, layer, created_at, last_used_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    key, tenant, scopeHash, contentHash, extractorVersion, modelId, promptVersion,
    JSON.stringify(result), result?.layer || 'unknown', ts, ts,
  );
  return { ...result, cached: false, cache_key: key };
}

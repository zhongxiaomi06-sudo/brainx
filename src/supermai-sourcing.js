/** supermai-sourcing.js — SuperMai 云端 sourcing API 集成（多源候选人搜索）。
 *
 * 数据来源：领英（LinkedIn）、GitHub、学术论文（paper）——通过 SuperMai 云端
 * sourcing API 搜索，补充 OpenMai 的 BOSS/脉脉/猎聘渠道，实现"搜索来源越多越好"。
 *
 * 认证：SuperMai harness 通过 TTC 登录获取 cloud_base_url + token；BrainX 复用
 * 同一 TTC 认证体系，凭证存入 supermai_credentials 表（AES-GCM 加密，同 ttc_tokens
 * 安全纪律）。如果 BRAINX_SUPERMAI_CLOUD_BASE_URL 环境变量已配置，直接使用固定
 * 云端地址，无需动态获取。
 *
 * 核心接口（逆向自 SuperMai harness v0.3.6）：
 *   POST /search/scout/match
 *     { criteria: string, sources?: ["linkedin"|"github"|"paper"], limit?: number }
 *     → { scanned: { linkedin: n, github: n, paper: n },
 *         top: [{ source, ref_id, name, headline, url, score, reason, detail }] }
 *   GET  /search/jobs → [{ id, name, cities, salary, ... }]
 */
import { now } from './db.js';
import { enc, dec } from './feishu.js';
import { getValidTtcJwt } from './ttcsdk/auth.js';

// SuperMai 云端 sourcing API 地址。token=JWT（2026-09-04 确认：凭证鉴权即顾问本人
// 登录的 TTC JWT），因此默认复用 OpenMai 同一 TTC gateway；若 SuperMai 有独立云端
// 地址，用 BRAINX_SUPERMAI_CLOUD_BASE_URL 覆盖。
const DEFAULT_CLOUD_BASE_URL = process.env.BRAINX_SUPERMAI_CLOUD_BASE_URL || 'https://gateway.ttcadvisory.com';
const TIMEOUT_MS = 5 * 60_000;

const SCOUT_SOURCES = ['linkedin', 'github', 'paper'];
const SOURCE_CN = { linkedin: '领英', github: 'GitHub', paper: '论文' };

/** 获取 SuperMai 凭证（cloud_base_url + token），优先级：
 *  1. 独立 SuperMai 凭证表（顾问级 cloud_base_url + token，若曾单独保存）；
 *  2. 复用顾问本人有效 TTC JWT 作为 Bearer token（token=JWT），cloud_base_url 用
 *     环境变量或默认 TTC gateway。
 * 2026-09-04 账号隔离加固：移除 BRAINX_SUPERMAI_TOKEN 共享环境变量回退——
 * 那会让所有顾问共用同一个账号搜索；现在强制人人用本人 TTC JWT（未绑定=不可用）。 */
export function getSupermaiCredentials(db, consultantId) {
  const r = db.prepare(
    'SELECT cloud_base_url_enc, token_enc, needs_reauth FROM supermai_credentials WHERE consultant_id=?',
  ).get(consultantId);
  if (r && !r.needs_reauth) {
    try { return { cloudBaseUrl: dec(r.cloud_base_url_enc), token: dec(r.token_enc) }; } catch { /* 回退 JWT 复用 */ }
  }
  const token = getValidTtcJwt(db, consultantId);
  if (token) return { cloudBaseUrl: DEFAULT_CLOUD_BASE_URL, token };
  return null;
}

/** 托管/更新某顾问的 SuperMai 凭证。 */
export function saveSupermaiCredentials(db, consultantId, cloudBaseUrl, token) {
  db.prepare(`INSERT INTO supermai_credentials (consultant_id, cloud_base_url_enc, token_enc, needs_reauth, updated_at)
    VALUES (?,?,?,0,?)
    ON CONFLICT(consultant_id) DO UPDATE SET cloud_base_url_enc=excluded.cloud_base_url_enc,
      token_enc=excluded.token_enc, needs_reauth=0, updated_at=excluded.updated_at`)
    .run(consultantId, enc(cloudBaseUrl), enc(token), now());
}

/** 凭证失效标记。 */
export const markSupermaiReauth = (db, consultantId) =>
  db.prepare('UPDATE supermai_credentials SET needs_reauth=1, updated_at=? WHERE consultant_id=?').run(now(), consultantId);

/** 前端状态（安全视图：绝不输出 token 本体）。 */
export function supermaiAuthStatus(db, consultantId) {
  const r = db.prepare('SELECT needs_reauth, updated_at FROM supermai_credentials WHERE consultant_id=?').get(consultantId);
  if (!r) return { connected: false };
  return { connected: !r.needs_reauth, needs_reauth: !!r.needs_reauth, updated_at: r.updated_at };
}

function sourceUnavailable() {
  const error = new Error('SuperMai sourcing is unavailable');
  error.code = 'SOURCE_UNAVAILABLE';
  return error;
}

function validateCriteria(criteria) {
  const text = String(criteria || '').trim();
  if (text.length < 5) throw Object.assign(new Error('criteria too short'), { code: 'INVALID_ARGUMENT' });
  return text;
}

function validateSources(sources) {
  if (!sources || !Array.isArray(sources) || sources.length === 0) return SCOUT_SOURCES;
  const valid = sources.filter((s) => SCOUT_SOURCES.includes(s));
  return valid.length > 0 ? valid : SCOUT_SOURCES;
}

/** 调用 SuperMai 云端 sourcing API 搜索候选人（多源匹配）。 */
export async function supermaiScoutMatch(rawInput, dependencies = {}) {
  const input = typeof rawInput === 'string' ? { criteria: rawInput } : rawInput;
  const criteria = validateCriteria(input.criteria);
  const sources = validateSources(input.sources);
  const limit = Math.min(Number(input.limit) || 20, 50);

  const creds = input._credentials || dependencies.credentials;
  if (!creds?.cloudBaseUrl || !creds?.token) throw sourceUnavailable();

  const base = creds.cloudBaseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (dependencies.signal) dependencies.signal.addEventListener('abort', () => controller.abort(), { once: true });

  let resp;
  try {
    resp = await fetch(`${base}/search/scout/match`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ criteria, sources, limit }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('scout match timeout'), { code: 'TIMEOUT' });
    throw sourceUnavailable();
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error('SuperMai credentials expired'), { code: 'AUTH_EXPIRED' });
  }
  if (!resp.ok) throw sourceUnavailable();

  let data;
  try { data = await resp.json(); } catch { throw sourceUnavailable(); }

  return normalizeScoutResult(data, sources);
}

function normalizeScoutResult(data, requestedSources) {
  const scanned = data.scanned || {};
  const top = Array.isArray(data.top) ? data.top.map((item) => ({
    source: item.source || 'unknown',
    source_cn: SOURCE_CN[item.source] || item.source || '未知',
    ref_id: String(item.ref_id || ''),
    name: String(item.name || ''),
    headline: item.headline || null,
    url: item.url || null,
    score: Number(item.score) || 0,
    reason: String(item.reason || ''),
    detail: item.detail || null,
  })) : [];

  return {
    schema_version: 'supermai_scout_match_v1',
    sources_searched: requestedSources.map((s) => ({ source: s, source_cn: SOURCE_CN[s] || s, scanned: scanned[s] || 0 })),
    total_scanned: Object.values(scanned).reduce((a, b) => a + (Number(b) || 0), 0),
    top_candidates: top,
    generated_at: new Date().toISOString(),
    ...(top.length ? {} : { empty_reason: 'NO_MATCHES_FOUND' }),
  };
}

/** 获取 SuperMai 云端职位列表（辅助功能，帮助顾问了解可用职位）。 */
export async function supermaiListJobs(dependencies = {}) {
  const creds = dependencies.credentials;
  if (!creds?.cloudBaseUrl || !creds?.token) throw sourceUnavailable();

  const base = creds.cloudBaseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  let resp;
  try {
    resp = await fetch(`${base}/search/jobs`, {
      headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    throw sourceUnavailable();
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error('SuperMai credentials expired'), { code: 'AUTH_EXPIRED' });
  }
  if (!resp.ok) throw sourceUnavailable();

  const data = await resp.json().catch(() => []);
  return Array.isArray(data) ? data : (data.items || []);
}

export { SCOUT_SOURCES, SOURCE_CN };

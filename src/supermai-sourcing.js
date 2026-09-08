/** supermai-sourcing.js — SuperMai 外网 sourcing 集成（领英/Bonjour/论文/GitHub 多源找人）。
 *
 * 2026-09-07 按真实 web 契约重写（逆向自 app.ttcadvisory.com/app/sourcing 前端 chunk）：
 * 旧实现猜的 gateway.ttcadvisory.com/search/scout/match 从未存在（503），真实契约 =
 *   1) 认证：TTC JWT → POST {API}/auth/login {ttc_token} → 兑换 sourcing_token（短 JWT），
 *      之后一律 Bearer <sourcing_token>。同一次探测中 auth 服务与检索服务独立部署。
 *   2) Bonjour/论文/GitHub：POST {API}/chat/sql_query {question, scope, source} → data.candidates（单次同步）。
 *   3) 领英：POST /chat/quick_db_search（库内检索，同步）→ 可选外部管线
 *      /chat/quick_search_urls → /chat/start_background_parse → 轮询 /chat/task_status/{session_id}。
 *   4) 会话：POST /sessions {} → data.id（外部解析管线必须）。
 * 响应统一信封 {code:0, data}；code!==0 视为业务失败。
 *
 * 凭证策略（2026-09-04 账号隔离加固沿用）：人人用本人 TTC JWT 兑换自己的 sourcing 身份，
 * 无共享环境变量回退；未绑定本人 JWT = 不可用（fail-closed）。
 */
import { now } from './db.js';
import { enc, dec } from './feishu.js';
import { getValidTtcJwt } from './ttcsdk/auth.js';

/** sourcing web API 前缀（同源挂在 app.ttcadvisory.com 网关下）。 */
const SOURCING_API_BASE = process.env.BRAINX_SUPERMAI_CLOUD_BASE_URL
  || 'https://app.ttcadvisory.com/app/sourcing/api/sourcing/v1';
/** 领英外部解析轮询上限：Quick_search_urls 90s + 解析任务轮询，整体封顶。 */
const LINKEDIN_EXTERNAL_TIMEOUT_MS = 150_000;
const POLL_INTERVAL_MS = 3_000;
const HTTP_TIMEOUT_MS = 90_000;

const SCOUT_SOURCES = ['linkedin', 'bonjour', 'paper', 'github'];
const SOURCE_CN = { linkedin: '领英', bonjour: 'Bonjour', paper: '论文', github: 'GitHub' };
const SQL_QUERY_SOURCES = ['bonjour', 'paper', 'github'];

/** 获取 SuperMai 凭证（优先级：①独立凭证表（曾单独保存的 sourcing_token）；
 * ②顾问本人有效 TTC JWT（标记 need_exchange，由 supermaiScoutMatch 调用时兑换）。
 * 无任何凭证 → null（fail-closed，不抛异常）。 */
export function getSupermaiCredentials(db, consultantId) {
  const r = db.prepare(
    'SELECT cloud_base_url_enc, token_enc, needs_reauth FROM supermai_credentials WHERE consultant_id=?',
  ).get(consultantId);
  if (r && !r.needs_reauth) {
    try { return { cloudBaseUrl: dec(r.cloud_base_url_enc), token: dec(r.token_enc) }; } catch { /* 回退 JWT 兑换 */ }
  }
  const jwt = getValidTtcJwt(db, consultantId);
  if (jwt) return { cloudBaseUrl: SOURCING_API_BASE, token: jwt, ttc_jwt: true };
  return null;
}

/** 托管/更新某顾问的 SuperMai 独立凭证（绕过 JWT 兑换，一般无需手工用）。 */
export function saveSupermaiCredentials(db, consultant_id, cloudBaseUrl, token) {
  db.prepare(`INSERT INTO supermai_credentials (consultant_id, cloud_base_url_enc, token_enc, needs_reauth, updated_at)
    VALUES (?,?,?,0,?)
    ON CONFLICT(consultant_id) DO UPDATE SET cloud_base_url_enc=excluded.cloud_base_url_enc,
      token_enc=excluded.token_enc, needs_reauth=0, updated_at=excluded.updated_at`)
    .run(consultant_id, enc(cloudBaseUrl), enc(token), now());
}

/** 凭证失效标记。 */
export const markSupermaiReauth = (db, consultant_id) =>
  db.prepare('UPDATE supermai_credentials SET needs_reauth=1, updated_at=? WHERE consultant_id=?').run(now(), consultant_id);

/** 前端状态（安全视图：绝不输出 token 本体）。 */
export function supermaiAuthStatus(db, consultantId) {
  const r = db.prepare('SELECT needs_reauth, updated_at FROM supermai_credentials WHERE consultant_id=?').get(consultantId);
  if (!r) return { connected: false };
  return { connected: !r.needs_reauth, needs_reauth: !!r.needs_reauth, updated_at: r.updated_at };
}

function sourceUnavailable(message) {
  // 专用码而非通用 SOURCE_UNAVAILABLE：SuperMai（领英/Bonjour/论文/GitHub）是独立外部源，
  // 与 OpenMai 找人、内部推荐池、RDS shortlist 无关——通用码会让模型把
  // 「SuperMai 挂了」臆断成「OpenMai/整个数据源都挂了」（2026-09-04 wendy 案例）。
  const error = new Error(message || 'SuperMai sourcing is unavailable');
  error.code = 'SUPERMAI_UNAVAILABLE';
  return error;
}

const authExpired = () => Object.assign(new Error('SuperMai credentials expired'), { code: 'AUTH_EXPIRED' });

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

/** 统一信封解析：{code:0,data}；HTTP 401/403 → AUTH_EXPIRED；其他非 2xx/解析失败 → SUPERMAI_UNAVAILABLE。 */
async function callApi(base, path, { token, method = 'GET', body, formData, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!formData && body !== undefined) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method, headers, body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw Object.assign(new Error(`sourcing ${path} timeout`), { code: 'TIMEOUT' });
    }
    throw sourceUnavailable();
  }
  if (resp.status === 401 || resp.status === 403) throw authExpired();
  let payload;
  try { payload = await resp.json(); } catch { throw sourceUnavailable(); }
  if (payload.code !== 0) throw sourceUnavailable(payload.message || `sourcing ${path} failed`);
  return payload.data ?? {};
}

/** TTC JWT → sourcing_token 兑换（每次调用现兑，换取无状态；TTC 登录接口很快）。 */
async function exchangeSourcingToken(ttcJwt, base) {
  const data = await callApi(base, '/auth/login', {
    method: 'POST', body: { ttc_token: ttcJwt }, timeoutMs: 30_000,
  });
  if (!data?.token) throw sourceUnavailable('sourcing auth/login 未返回 token');
  return data.token;
}

/** 防御式候选归一：检索端点字段命名有 snake/camel 双轨，逐字段兜底取值。 */
function normalizeCandidate(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (...keys) => { for (const k of keys) { const v = raw[k]; if (v !== undefined && v !== null && v !== '') return v; } return null; };
  const name = pick('name', 'candidate_name', 'nickname', 'title');
  const detail = pick('reason', 'summary', 'description', 'match_reason');
  return {
    source,
    source_cn: SOURCE_CN[source] || source,
    ref_id: String(pick('ref_id', 'id', 'user_id', 'candidate_id', 'profile_id') ?? ''),
    name: String(name ?? ''),
    headline: pick('headline', 'current_title', 'title', 'position', 'currentTitle'),
    url: pick('url', 'linkedin_url', 'profile_url', 'github_url', 'linkedinUrl', 'source_url'),
    score: Number(pick('score', 'match_score', 'relevance') ?? 0) || 0,
    reason: String(detail ?? ''),
    detail: {
      company: pick('current_company', 'company', 'currentCompany'),
      school: pick('education_school', 'school', 'educationSchool'),
      degree: pick('education_highest', 'degree', 'educationHighest'),
      experience: pick('total_experience', 'experience', 'totalExperience'),
      city: pick('city', 'location', 'work_city'),
    },
  };
}

function mergeCandidates(groups, requestedSources) {
  const seen = new Set();
  const top = [];
  for (const group of groups) {
    for (const raw of group.candidates || []) {
      const c = normalizeCandidate(raw, group.source);
      if (!c?.name) continue;
      const key = c.ref_id || `${c.name}|${c.headline || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      top.push(c);
    }
  }
  return {
    schema_version: 'supermai_scout_match_v2',
    sources_searched: requestedSources.map((s) => ({ source: s, source_cn: SOURCE_CN[s] || s })),
    total_scanned: top.length,
    top_candidates: top,
    generated_at: new Date().toISOString(),
    ...(top.length ? {} : { empty_reason: 'NO_MATCHES_FOUND' }),
  };
}

/** 领英：库内检索（同步）+ 外部解析管线（best-effort，失败降级为仅库内结果）。 */
async function searchLinkedin({ base, token, criteria, limit, sessionId, unknowns }) {
  const dbSearch = await callApi(base, '/chat/quick_db_search', {
    method: 'POST', token,
    body: { queries: [criteria], session_id: sessionId, soft_filters: [], limit },
  }).catch((error) => {
    if (error.code === 'AUTH_EXPIRED') throw error;
    unknowns.push(`领英库内检索失败：${error.message}`);
    return {};
  });
  const candidates = [...(dbSearch.candidates || [])];

  if (!sessionId) return candidates;
  try {
    const ext = await callApi(base, '/chat/quick_search_urls', {
      method: 'POST', token, timeoutMs: 90_000,
      body: { queries: [criteria], num: Math.min(limit, 10) },
    });
    const exaResults = ext.exa_results || [];
    const sources = ext.sources || [];
    if (exaResults.length || sources.length) {
      await callApi(base, '/chat/start_background_parse', {
        method: 'POST', token,
        body: { session_id: sessionId, exa_results: exaResults, sources,
          queries: [criteria], soft_filters: [], db_existing_urls: [], result_limit: Math.min(limit, 10) },
      });
      const deadline = Date.now() + LINKEDIN_EXTERNAL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const st = await callApi(base, `/chat/task_status/${encodeURIComponent(sessionId)}`, { token });
        if (['completed', 'error', 'cancelled'].includes(st.status)) {
          if (st.status === 'error' && !(st.candidates || []).length) {
            unknowns.push(`领英外部解析失败：${st.message || 'unknown'}`);
          } else {
            candidates.push(...(st.candidates || []));
          }
          break;
        }
      }
    }
  } catch (error) {
    unknowns.push(`领英外部检索未完成（库内结果不受影响）：${error.message}`);
  }
  return candidates;
}

/** 调用 SuperMai web sourcing API 多源搜索候选人。
 * 兼容旧调用形态：input 可为字符串或 {criteria, sources, limit}；_credentials/dependencies.credentials
 * 可注入（独立 token 或本人 TTC JWT——ttc_jwt 标记时先兑换）。 */
export async function supermaiScoutMatch(rawInput, dependencies = {}) {
  const input = typeof rawInput === 'string' ? { criteria: rawInput } : rawInput;
  const criteria = validateCriteria(input.criteria);
  const sources = validateSources(input.sources);
  const limit = Math.min(Number(input.limit) || 20, 50);
  const unknowns = [];

  const creds = input._credentials || dependencies.credentials;
  if (!creds?.token) throw sourceUnavailable();
  const base = creds.cloudBaseUrl || SOURCING_API_BASE;
  // 独立凭证表里的 token 已是 sourcing_token，直接用；TTC JWT 需先兑换。
  const token = creds.ttc_jwt ? await exchangeSourcingToken(creds.token, base) : creds.token;

  // 会话：领英外部解析管线必须；其他渠道 best-effort（但凭证失效要穿透，调用方据此标记重登）。
  const session = await callApi(base, '/sessions', { method: 'POST', token, body: {}, timeoutMs: 30_000 })
    .catch((error) => {
      if (error.code === 'AUTH_EXPIRED') throw error;
      return null;
    });
  const sessionId = session?.id ?? null;
  if (!sessionId) unknowns.push('sourcing 会话创建失败，领英外部解析不可用（库内/单渠道检索不受影响）');

  const groups = [];
  for (const source of sources.filter((s) => SQL_QUERY_SOURCES.includes(s))) {
    try {
      const data = await callApi(base, '/chat/sql_query', {
        method: 'POST', token,
        body: { question: criteria, scope: 'all', source },
      });
      groups.push({ source, candidates: data.candidates || [] });
    } catch (error) {
      if (error.code === 'AUTH_EXPIRED') throw error;
      unknowns.push(`${SOURCE_CN[source] || source} 渠道检索失败：${error.message}`);
    }
  }
  if (sources.includes('linkedin')) {
    const candidates = await searchLinkedin({ base, token, criteria, limit, sessionId, unknowns });
    groups.push({ source: 'linkedin', candidates });
  }
  if (!groups.some((g) => (g.candidates || []).length) && unknowns.length >= sources.length) {
    // 所有渠道都失败且无任何结果 → 视为源不可用（保留首因错误码语义：TIMEOUT/AUTH 透传已在上面抛出）
    throw sourceUnavailable(unknowns[0]);
  }
  const result = mergeCandidates(groups, sources);
  result.unknowns = unknowns;
  return result;
}

export { SCOUT_SOURCES, SOURCE_CN };

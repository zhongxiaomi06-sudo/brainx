/** specs/036：搜索结果拆行落库（append-only）+ 群内检索的数据地基。
 *  列宽不设限；拆行时超长字段显式抛错，不做静默截断（禁止无声丢数据）。 */
import { now } from './db.js';
import { extractOpenmaiCandidates } from './openmai-result.js';

// 防御上限：OpenMai 正常字段最长 300 字符，超出视为引擎异常输出，落库时报错而非截断。
const MAX_FIELD = 2000;
const CAREER_STATUS = new Set(['recommended', 'screened', 'in_pool', 'rejected', 'restored']);

function field(value, label) {
  const text = String(value || '').trim();
  if (text.length > MAX_FIELD) {
    throw new Error(`SOURCING_FIELD_TOO_LONG:${label}:${text.length}`);
  }
  return text || null;
}

/** role 形如「吉利控股集团 / AI产品经理」：首段为公司，其余为职位。无分隔符时整段当职位。 */
export function splitCandidateRole(role) {
  const text = String(role || '').trim();
  if (!text) return { company: null, title: null };
  const at = text.indexOf(' / ');
  if (at < 0) return { company: null, title: field(text, 'title') };
  return { company: field(text.slice(0, at), 'company'), title: field(text.slice(at + 3), 'title') };
}

/** 匹配度字符串（"92%" / "92" / "—"）→ 数值；无法解析返回 null，不猜。 */
export function parseScoreNum(score) {
  const match = String(score || '').match(/^(\d{1,3}(?:\.\d+)?)\s*%?$/);
  return match ? Number(match[1]) : null;
}

function checkSchema(db) {
  try {
    db.prepare('SELECT 1 FROM sourcing_candidates LIMIT 1').get();
  } catch {
    throw new Error('SOURCING_CANDIDATES_SCHEMA_MISSING');
  }
}

/** 从一条 done 结果拆行落库（幂等：主键冲突更新快照字段、保留 career_status 的动作语义，
 *  但已进入终态（screened/in_pool/rejected/restored）的行不被新一轮落回 recommended）。
 *  返回写入行数。 */
export function storeSourcingCandidates(db, { projectId, consultantId, taskId }) {
  checkSchema(db);
  const row = db.prepare(`SELECT search_round, result_text FROM openmai_results
    WHERE project_id=? AND consultant_id=? AND task_id=?`).get(projectId, consultantId, taskId);
  if (!row?.result_text) return 0;
  const candidates = extractOpenmaiCandidates(row.result_text);
  if (!candidates.length) return 0;
  const round = Number(row.search_round || 1);
  const at = now();
  const insert = db.prepare(`INSERT INTO sourcing_candidates
    (search_key, consultant_id, search_round, candidate_ref, name, company, title, city,
     experience, education, evaluation, score_raw, score_num, talent_url, resume_url, profile_url,
     career_status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(search_key, consultant_id, search_round, candidate_ref) DO UPDATE SET
      name=excluded.name, company=excluded.company, title=excluded.title, city=excluded.city,
      experience=excluded.experience, education=excluded.education, evaluation=excluded.evaluation,
      score_raw=excluded.score_raw, score_num=excluded.score_num, talent_url=excluded.talent_url,
      resume_url=excluded.resume_url, profile_url=excluded.profile_url, updated_at=excluded.updated_at`);
  let count = 0;
  for (const c of candidates) {
    if (c.candidateRefValid !== true) continue;
    const { company, title } = splitCandidateRole(c.role);
    insert.run(projectId, consultantId, round, c.candidateRef,
      field(c.name, 'name'), company, title, field(c.city, 'city'),
      field(c.experience, 'experience'), field(c.education, 'education'),
      field(c.evaluation, 'evaluation'), field(c.score, 'score'), parseScoreNum(c.score),
      field(c.talentUrl, 'talent_url'), field(c.resumeUrl, 'resume_url'), field(c.profileUrl, 'profile_url'),
      'recommended', at, at);
    count += 1;
  }
  return count;
}

/** 四动作 / 入库动作回写生涯状态。单写方向：动作→状态；只推进不回退（RESTORE 除外）。 */
export function updateSourcingCareerStatus(db, { searchKey, consultantId, candidateRef, status }) {
  if (!CAREER_STATUS.has(status)) throw new Error(`SOURCING_CAREER_STATUS_INVALID:${status}`);
  return db.prepare(`UPDATE sourcing_candidates SET career_status=?, updated_at=?
    WHERE search_key=? AND consultant_id=? AND candidate_ref=?`)
    .run(status, now(), searchKey, consultantId, candidateRef).changes;
}

const escapeLike = (value) => String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** specs/036：给结果卡渲染用的 {candidate_ref → career_status} 映射（含全部轮次）。 */
export function careerStatusMap(db, { searchKey, consultantId }) {
  checkSchema(db);
  const rows = db.prepare(`SELECT candidate_ref, career_status FROM sourcing_candidates
    WHERE search_key=? AND consultant_id=?`).all(searchKey, consultantId);
  return Object.fromEntries(rows.map((r) => [r.candidate_ref, r.career_status]));
}

/** specs/036 群内检索（brainx_sourcing_recall 数据面）：只读本人行，无关键词匹配全部。
 *  filter 语义：词之间 AND；「|」（或全角「｜」）分隔的是 OR 组——组内 AND、组间 OR。
 *  例：「小红书|字节」＝有小红书或字节背景（2026-10-13 群测实证：「A 或 B」按纯 AND 必然零命中）。 */
export function parseFilterGroups(filter) {
  return String(filter || '').split(/[|｜]/)
    .map((group) => group.split(/[\s,，、;；]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6))
    .filter((terms) => terms.length > 0)
    .slice(0, 4);
}

export function recallSourcingCandidates(db, {
  consultantId, searchKey = null, filter = null, city = null,
  orderBy = 'score', limit = 10,
}) {
  checkSchema(db);
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 20);
  const where = ['sc.consultant_id = ?'];
  const params = [consultantId];
  if (searchKey) { where.push('sc.search_key = ?'); params.push(String(searchKey).slice(0, 200)); }
  if (city) { where.push('sc.city LIKE ? ESCAPE \'\\\''); params.push(`%${escapeLike(city)}%`); }
  const groups = parseFilterGroups(filter);
  const termSql = () => `(sc.company LIKE ? ESCAPE '\\' OR sc.title LIKE ? ESCAPE '\\'
      OR sc.evaluation LIKE ? ESCAPE '\\' OR sc.name LIKE ? ESCAPE '\\')`;
  if (groups.length === 1) {
    for (const term of groups[0]) {
      where.push(termSql());
      const like = `%${escapeLike(term)}%`;
      params.push(like, like, like, like);
    }
  } else if (groups.length > 1) {
    const groupClauses = groups.map((terms) => terms.map((term) => {
      const like = `%${escapeLike(term)}%`;
      params.push(like, like, like, like);
      return termSql();
    }).join(' AND '));
    where.push(`(${groupClauses.join(' OR ')})`);
  }
  const order = orderBy === 'time' ? 'sc.updated_at DESC' : 'sc.score_num DESC, sc.updated_at DESC';
  return db.prepare(`SELECT sc.candidate_ref, sc.name, sc.company, sc.title, sc.city,
      sc.experience, sc.education, sc.evaluation, sc.score_raw, sc.score_num,
      sc.career_status, sc.search_key, sc.search_round, sc.updated_at, sc.talent_url
    FROM sourcing_candidates sc
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}
    LIMIT ?`).all(...params, safeLimit);
}

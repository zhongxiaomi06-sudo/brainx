/** profile-init.js — 顾问画像首初始化（冷启动画像，specs/023 data-baseline §4 的病）。
 *
 * 用途：profile_keywords 为空的顾问，用既有数据合成第一批动态画像——
 * 证据 = 其所在群关联职位（公司/职位/方向频次）+ 本人 memberships/owner 职位 + 近期群消息采样，
 * 由 LLM（agent 算法）评估产出建议关键词；人确认或 --write 落库（updateProfile 合并保留既有键）。
 * 纪律：宁缺勿错——无证据不生成；dry-run 默认；写库只补空白（--force 才覆盖）。
 */
import { postToPlainText } from './fact-agent-extract.js';

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, c]) => ({ name: k, count: c }));

/** 汇总顾问的画像证据（纯查询，可单测）。 */
export function gatherProfileEvidence(db, consultantId) {
  const chats = db.prepare('SELECT chat_id FROM consultant_chats WHERE consultant_id=?')
    .all(consultantId).map((r) => r.chat_id);
  const consultant = db.prepare('SELECT display_name FROM consultants WHERE consultant_id=?')
    .get(consultantId);
  const companies = new Map();
  const roles = new Map();
  const directions = new Map();
  const tally = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };

  // 群关联职位（其业务环境的主信号）
  const chatJobs = chats.length ? db.prepare(
    `SELECT j.company, j.role, c.primary_direction FROM job_facts j
     LEFT JOIN job_classifications c ON c.project_id = j.project_id
     WHERE j.chat_id IN (${chats.map(() => '?').join(',')})`).all(...chats) : [];
  for (const j of chatJobs) {
    tally(companies, j.company); tally(roles, j.role); tally(directions, j.primary_direction);
  }
  // 本人策展/主做职位（最强信号，权重×3 计入频次）
  const ownJobs = db.prepare(
    `SELECT DISTINCT j.company, j.role, c.primary_direction FROM job_facts j
     LEFT JOIN job_classifications c ON c.project_id = j.project_id
     WHERE j.project_id IN (SELECT project_id FROM job_memberships WHERE consultant_id=? AND valid_to IS NULL)
        OR j.owner_name = ?`).all(consultantId, consultant?.display_name || '');
  for (const j of ownJobs) {
    for (let i = 0; i < 3; i++) {
      tally(companies, j.company); tally(roles, j.role); tally(directions, j.primary_direction);
    }
  }
  // 近期群消息采样（最新 40 条有内容的，供 LLM 感知业务语境；不做人肉归因——lark_messages 无 sender 列）
  const sampleMessages = chats.length ? db.prepare(
    `SELECT text FROM lark_messages
     WHERE chat_id IN (${chats.map(() => '?').join(',')}) AND length(text) > 10
     ORDER BY create_time DESC LIMIT 40`).all(...chats)
    .map((r) => postToPlainText(r.text).slice(0, 120)).filter((t) => t.length > 10) : [];

  return {
    consultant_id: consultantId,
    chat_count: chats.length,
    job_count: chatJobs.length,
    own_job_count: ownJobs.length,
    top_companies: top(companies, 8),
    top_roles: top(roles, 10),
    top_directions: top(directions, 8),
    sample_messages: sampleMessages,
  };
}

/** 证据 → LLM prompt（只输出 JSON；证据不足时允许输出空数组）。 */
export function buildProfilePrompt(ev) {
  const system = `你是猎头团队的顾问画像分析器。根据顾问的业务证据推断其专业方向关键词。只输出 JSON。
规则：关键词 5-10 个，每个 2-10 字，必须是证据中实际出现或可严格归纳的业务方向词（如「海外增长」「AI产品」）；
禁止编造证据中没有的方向；证据不足时 keywords 输出空数组；note 一句话（≤60字）概括其业务域。`;
  const user = `顾问：${ev.consultant_id}
所在客户群 ${ev.chat_count} 个，关联职位 ${ev.job_count} 个，本人策展/主做 ${ev.own_job_count} 个。
高频职位方向：${JSON.stringify(ev.top_directions)}
高频职位：${JSON.stringify(ev.top_roles)}
高频客户公司：${JSON.stringify(ev.top_companies)}
近期群消息采样：
${ev.sample_messages.slice(0, 20).join('\n') || '（无）'}
输出 JSON：{"keywords":["…"],"note":"…"}`;
  return { system, user };
}

/** LLM 输出 → 画像提案。raw 接受对象（chatJson 已解析）或字符串（防御重解析）。
 * 轻校验：坏 JSON/空关键词/超量/超长一律拒绝，宁缺勿错。 */
export function parseProfileProposal(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { return { ok: false, error: 'invalid_json' }; }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'invalid_json' };
  const kws = [...new Set((Array.isArray(data.keywords) ? data.keywords : [])
    .map((k) => String(k).trim()).filter((k) => k.length >= 2 && k.length <= 10))];
  if (!kws.length) return { ok: false, error: 'empty_keywords' };
  if (kws.length > 20) return { ok: false, error: 'too_many_keywords' };
  return { ok: true, profile_keywords: kws.slice(0, 10),
           profile_note: String(data.note || '').slice(0, 60) };
}

/** 评估：提案关键词对其业务证据的覆盖率（命中职位数/关联职位总数）。 */
export function evaluateProposal(db, consultantId, keywords) {
  const ev = gatherProfileEvidence(db, consultantId);
  if (!ev.job_count) return { coverage: null, reason: 'no_jobs' };
  const chats = db.prepare('SELECT chat_id FROM consultant_chats WHERE consultant_id=?')
    .all(consultantId).map((r) => r.chat_id);
  const jobs = db.prepare(`SELECT company, role FROM job_facts
    WHERE chat_id IN (${chats.map(() => '?').join(',')})`).all(...chats);
  const hit = jobs.filter((j) => keywords.some((k) =>
    `${j.company} ${j.role}`.toLowerCase().includes(k.toLowerCase()))).length;
  return { coverage: hit / jobs.length, hit, total: jobs.length };
}

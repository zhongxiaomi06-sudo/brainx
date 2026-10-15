import { createHash } from 'node:crypto';
import { configuredFeishuAppKeyHash } from '../feishu-bot.js';
import { loadAuthorizedCandidateContact } from './tools-talent.js';
import { withMysql } from '../db.js';
import { getValidTtcJwt } from '../ttcsdk/auth.js';
import { readTtcResumeContact } from '../candidate-contact-resume.js';
import { readCandidateContactCache, saveCandidateContactCache } from '../candidate-contact-cache.js';

/** specs/036 三态：区分「已入库待撞库」与「未入库无数据」，不再一律 not_authorized。
 *  口径与 defaultAddTalent 幂等标记一致：talent.summary LIKE '[ref:candidateRef]%'。 */
async function defaultPoolCheck(candidateRef) {
  try {
    const id = await withMysql(async (conn) => {
      const [rows] = await conn.execute(
        'SELECT id FROM talent WHERE summary LIKE ? LIMIT 1', [`[ref:${candidateRef}]%`]);
      return rows[0]?.id ?? null;
    });
    return id ?? null;
  } catch { return null; } // RDS 不可达时按「无法确认入库」处理，不阻断主链路
}

/** 联系方式只进可信发起人的私聊，工具结果不含号码，禁止模型代为转述。 */
export async function sendCandidatePrivateContact(db, principal, candidateRef, deps) {
  // 字段名禁用 contact 前缀：群聊结果经 assertSafeAgentProjection 时 GROUP_FORBIDDEN_KEY
  // 会拦截任何 contact* key（2026-10-13 群内点查实证报 INTERNAL）。
  const envelope = (status, note) => ({ data: { candidate_ref: candidateRef, delivery_status: status },
    facts: [], inferences: [], recommendations: [{ action: 'status_only', note }],
    unknowns: [], evidence_refs: [`candidate_contact:${candidateRef}`] });
  const binding = db.prepare(`SELECT feishu_app_key_hash FROM feishu_identity_bindings
    WHERE tenant_id=? AND consultant_id=? AND channel_account_id=? AND open_id=?
    AND binding_status='ACTIVE'`).get(principal.tenantId, principal.consultantId,
    principal.accountId || '', principal.senderId || '');
  // 指纹与 binding 同源：sha256(应用密钥)，不是 appId（2026-10-13 群测实证 appId 恒不匹配）。
  const appKeyHash = deps.appKeyHash ?? configuredFeishuAppKeyHash();
  if (!binding || !appKeyHash || binding.feishu_app_key_hash !== appKeyHash) {
    return envelope('fetch_failed', '拉取失败：当前本人身份未验证，未读取、未私发。请重新绑定后再点。');
  }
  const ownJwt = (deps.getTtcJwtFn || getValidTtcJwt)(db, principal.consultantId);
  if (!ownJwt) return envelope('credential_expired', '凭证失效：请重新粘贴你本人的 TTC 凭证，再点查联系方式。');
  const cached = (deps.readCacheFn || readCandidateContactCache)(db, principal, candidateRef);
  if (cached) return deliver(cached, '30 天内授权简历快照');
  let authorizedContact = null;
  try {
    authorizedContact = await (deps.loadCandidateContactFn || loadAuthorizedCandidateContact)({
      tenantId: principal.tenantId, consultantId: principal.consultantId, candidateRef });
  } catch (error) {
    if (error?.code !== 'NOT_FOUND_OR_FORBIDDEN') {
      return envelope('fetch_failed', '拉取失败：授权数据暂时不可用，稍后重试。');
    }
  }
  if (authorizedContact?.phone || authorizedContact?.email) return deliver(authorizedContact, '已有授权人才库');
  if (!/^PL\d{10,}$/.test(candidateRef)) return envelope('no_resume',
    '无简历：此人没有可读取的 TTC 简历；请点卡片上的姓名到来源页面查看。');
  let found;
  try { found = await (deps.readResumeFn || readTtcResumeContact)(candidateRef, ownJwt, deps); }
  catch (error) { return error?.authInvalid || error?.status === 401 || error?.status === 403
    ? envelope('credential_expired', '凭证失效：请重新粘贴你本人的 TTC 凭证后再点。')
    : envelope('fetch_failed', '拉取失败：稍后重试，或点卡片上的姓名到 TTC 页面查看。'); }
  if (found.status === 'found' && (found.phone || found.email)) {
    try { (deps.saveCacheFn || saveCandidateContactCache)(db, principal, candidateRef, found); }
    catch { /* 加密快照写入失败不妨碍当次私发，且不得把明文写进日志。 */ }
    return deliver(found, '本人 TTC 简历');
  }
  if (found.status === 'fetch_failed') return envelope('fetch_failed',
    '拉取失败：部分简历未能完整检查；稍后重试，或点卡片上的姓名到 TTC 页面查看。');
  if (found.status === 'no_resume') {
    const talentId = await (deps.poolCheckFn || defaultPoolCheck)(candidateRef);
    if (talentId) return envelope('in_pool_pending_match',
      '已入库待撞库：目前没有可读取的 TTC 简历；请点卡片姓名查看，或等授权补齐。');
    return envelope('no_resume', '无简历：TTC 没有此人的可读取简历；请点卡片上的姓名到 TTC 页面查看。');
  }
  return envelope('no_contact', '简历中无联系方式：已检查可读取简历，请点卡片上的姓名到 TTC 页面查看。');

  async function deliver(value, source) {
    try {
      await deps.sendTextMessageFn({ target: principal.senderId,
        text: `候选人 ${candidateRef}\n${value.phone ? `电话：${value.phone}\n` : ''}${value.email ? `邮箱：${value.email}` : ''}\n来源：${source}`,
        idempotencyKey: createHash('sha256').update(`${principal.accountId}|${principal.senderId}|${candidateRef}|${JSON.stringify(value)}|${new Date().toISOString().slice(0, 10)}`).digest('hex').slice(0, 32) });
      return envelope('sent', '已私发给你，群内不展示联系方式。');
    } catch { return envelope('fetch_failed', '拉取失败：私信发送未成功，群内未展示联系方式；请稍后重试。'); }
  }
}

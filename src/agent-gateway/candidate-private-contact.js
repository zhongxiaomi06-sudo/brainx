import { createHash } from 'node:crypto';
import { configuredFeishuAppKeyHash } from '../feishu-bot.js';
import { loadAuthorizedCandidateContact } from './tools-talent.js';
import { withMysql } from '../db.js';

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
    return envelope('unavailable', '当前应用或本人身份未验证，未读取、未发送联系方式。');
  }
  let contact;
  try {
    contact = await (deps.loadCandidateContactFn || loadAuthorizedCandidateContact)({
      tenantId: principal.tenantId, consultantId: principal.consultantId, candidateRef });
  } catch (error) {
    // specs/036：授权查询失败先分三态——已入库待撞库与未入库的话术不同，都不再笼统回「未授权」。
    if (error?.code !== 'NOT_FOUND_OR_FORBIDDEN') {
      return envelope('unavailable', '授权来源暂时不可用；未读取、未发送，稍后重试。');
    }
    const poolCheck = deps.poolCheckFn || defaultPoolCheck;
    const talentId = await poolCheck(candidateRef);
    return talentId
      ? envelope('in_pool_pending_match', `候选人已入库（talent #${talentId}）、联系方式待撞库——`
          + '现在可直接打开卡片上的 TTC 链接查看，或等 Reloop 授权流程补齐数据；不要回复「未授权」。')
      : envelope('no_contact_data', '该候选人尚未入库、BrainX 内暂无其联系方式数据；'
          + '可先执行「加入reloop」入库，或直接打开卡片上的 TTC 链接查看。不要回复「未授权」。');
  }
  if (!contact?.phone && !contact?.email) return envelope('pending', '暂无可用联系方式，待撞库；本次没有自动启动撞库任务。');
  try {
    await deps.sendTextMessageFn({ target: principal.senderId,
      text: `候选人 ${candidateRef}\n${contact.phone ? `电话：${contact.phone}\n` : ''}${contact.email ? `邮箱：${contact.email}` : ''}`,
      idempotencyKey: createHash('sha256').update(`${principal.accountId}|${principal.senderId}|${candidateRef}|${JSON.stringify(contact)}|${new Date().toISOString().slice(0, 10)}`).digest('hex').slice(0, 32) });
    return envelope('sent', '联系方式已私发给你，群内不展示号码。');
  } catch { return envelope('failed', '私信发送失败，未在群内展示联系方式，请稍后重试。'); }
}

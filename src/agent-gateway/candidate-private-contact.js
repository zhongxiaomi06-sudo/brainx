import { createHash } from 'node:crypto';
import { configuredFeishuAppKeyHash } from '../feishu-bot.js';
import { loadAuthorizedCandidateContact } from './tools-talent.js';

/** 联系方式只进可信发起人的私聊，工具结果不含号码，禁止模型代为转述。 */
export async function sendCandidatePrivateContact(db, principal, candidateRef, deps) {
  const envelope = (status, note) => ({ data: { candidate_ref: candidateRef, contact_delivery: status },
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
    return envelope(error?.code === 'NOT_FOUND_OR_FORBIDDEN' ? 'not_authorized' : 'unavailable',
      '尚未获得此候选人的联系方式授权，或授权来源不可用；未读取、未发送，不能宣称已撞库。');
  }
  if (!contact?.phone && !contact?.email) return envelope('pending', '暂无可用联系方式，待撞库；本次没有自动启动撞库任务。');
  try {
    await deps.sendTextMessageFn({ target: principal.senderId,
      text: `候选人 ${candidateRef}\n${contact.phone ? `电话：${contact.phone}\n` : ''}${contact.email ? `邮箱：${contact.email}` : ''}`,
      idempotencyKey: createHash('sha256').update(`${principal.accountId}|${principal.senderId}|${candidateRef}|${JSON.stringify(contact)}|${new Date().toISOString().slice(0, 10)}`).digest('hex').slice(0, 32) });
    return envelope('sent', '联系方式已私发给你，群内不展示号码。');
  } catch { return envelope('failed', '私信发送失败，未在群内展示联系方式，请稍后重试。'); }
}

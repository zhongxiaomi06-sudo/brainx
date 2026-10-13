/** 自由搜索的四动作：只操作本人的原群结果，不借用或伪造职位授权。 */
import { now, uuid } from '../db.js';
import { extractOpenmaiCandidates } from '../openmai-result.js';
import { defaultAddTalent } from './tools-candidate-actions.js';
import { sendCandidatePrivateContact } from './candidate-private-contact.js';
import { sendTextMessage } from '../feishu-bot.js';
import { updateSourcingCareerStatus } from '../sourcing-candidates.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const safe = value => String(value || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱隐藏]')
  .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, '[电话隐藏]').slice(0, 400);

function authorizedCandidate(db, p, args) {
  if (!/^supermai:[a-f0-9]{12}$/.test(args.search_key || '')) fail('INVALID_ARGUMENT');
  // 永远从持久原群快照证明来源；只知道 search_key/candidate_ref 不能取得授权。
  const rows = db.prepare(`SELECT d.task_id,d.result_text FROM sourcing_group_deliveries d
    JOIN feishu_identity_bindings b ON b.binding_id=d.binding_id
    JOIN agent_group_scopes s ON s.group_scope_id=d.group_scope_id
    WHERE d.search_key=? AND d.consultant_id=? AND b.consultant_id=d.consultant_id
      AND b.tenant_id=? AND b.channel_account_id=? AND b.open_id=? AND b.binding_status='ACTIVE'
      AND s.tenant_id=b.tenant_id AND s.channel_account_id=b.channel_account_id AND s.scope_status='ACTIVE'
      AND (?='p2p' OR s.chat_id=?) AND d.result_status='done'
      AND d.delivery_status!='CANCELLED'
    ORDER BY d.created_at DESC`).all(args.search_key, p.consultantId, p.tenantId, p.accountId,
    p.senderId, p.chatType, p.chatId);
  for (const row of rows) {
    const candidate = extractOpenmaiCandidates(row.result_text)
      .find(c => c.candidateRefValid !== false && c.candidateRef === args.candidate_ref);
    if (candidate) return { candidate, taskId: row.task_id };
  }
  fail('NOT_FOUND_OR_FORBIDDEN');
}

export function createFreeformCandidateHandlers({ db, addTalentFn = defaultAddTalent,
  loadCandidateContactFn, sendTextMessageFn = sendTextMessage } = {}) {
  return { brainx_freeform_candidate_action: async (args, { principal: p }) => {
    if (args.confirm !== true) fail('INVALID_ARGUMENT');
    const { candidate, taskId } = authorizedCandidate(db, p, args);
    if (args.action === 'CONTACT') return sendCandidatePrivateContact(db, p, args.candidate_ref,
      { loadCandidateContactFn, sendTextMessageFn });
    if (args.action === 'ADD_TO_RELOOP') {
      try {
        const result = await addTalentFn({ name: safe(candidate.name).slice(0, 80),
          summary: `[ref:${args.candidate_ref}] 来源:SuperMai自由找人｜${safe(candidate.role)}｜${safe(candidate.evaluation)}`,
          sourceRef: args.candidate_ref });
        markCareer(db, p, args, 'in_pool');
        return envelope({ status: result.already ? 'already_exists' : 'added', talent_id: result.id }, args);
      } catch { return envelope({ status: 'failed', sync_pending: false }, args,
        ['人才库写入失败，没有排队，不得回复已加入或同步中。']); }
    }
    const status = { SCREEN: 'SCREENED', REJECT: 'REJECTED', RESTORE: 'RESTORED' }[args.action];
    if (!status) fail('INVALID_ARGUMENT');
    markCareer(db, p, args, { SCREEN: 'screened', REJECT: 'rejected', RESTORE: 'restored' }[args.action]);
    const keys = [p.tenantId, p.consultantId, args.search_key, args.candidate_ref];
    const existing = db.prepare(`SELECT status FROM freeform_candidate_decisions
      WHERE tenant_id=? AND consultant_id=? AND search_key=? AND candidate_ref=?`).get(...keys);
    if (existing?.status !== status) {
      const at = now();
      db.exec('SAVEPOINT freeform_decision');
      try {
        db.prepare(`INSERT INTO freeform_candidate_decisions VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id,consultant_id,search_key,candidate_ref)
          DO UPDATE SET status=excluded.status,source_task_id=excluded.source_task_id,updated_at=excluded.updated_at`)
          .run(...keys, status, taskId, at);
        db.prepare('INSERT INTO freeform_candidate_events VALUES (?,?,?,?,?,?,?,?)')
          .run(uuid(), ...keys, status, taskId, at);
        db.exec('RELEASE freeform_decision');
      } catch (error) { db.exec('ROLLBACK TO freeform_decision; RELEASE freeform_decision'); throw error; }
    }
    return envelope({ status, already: existing?.status === status }, args,
      status === 'SCREENED' ? ['已初筛通过并记入本次搜索的重点人选；尚未关联职位，不得声称加入了项目重点名单或已发 TTC 链接。'] : []);
  } };
}

function envelope(data, args, unknowns = []) {
  return { data: { candidate_ref: args.candidate_ref, search_key: args.search_key, ...data },
    facts: [], inferences: [], recommendations: [], unknowns,
    evidence_refs: [`search_candidate:${args.search_key}:${args.candidate_ref}`] };
}

/** specs/036：四动作回写快照行生涯状态（sourcing_candidates 缺表/缺行静默跳过，不影响主链路）。 */
function markCareer(db, p, args, careerStatus) {
  try {
    updateSourcingCareerStatus(db, { searchKey: args.search_key,
      consultantId: p.consultantId, candidateRef: args.candidate_ref, status: careerStatus });
  } catch { /* 表未迁移或该行不存在：不阻断决策落库 */ }
}

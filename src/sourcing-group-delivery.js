/** 自由条件搜索的原群可靠交付：冻结每轮结果、重启恢复、投递前重新鉴权。 */
import { createHash, randomUUID } from 'node:crypto';
import { now } from './db.js';
import { configuredFeishuAppId, sendInteractiveCard } from './feishu-bot.js';
import { buildOpenmaiDeliveryCard } from './sourcing-result-card.js';

function allowsReview(raw) {
  try { const purposes = JSON.parse(raw); return Array.isArray(purposes) && purposes.includes('candidate_review'); }
  catch { return false; }
}

export function registerFreeformDelivery(db, principal, searchKey) {
  if (principal.chatType !== 'group' || !principal.accountId || !principal.senderId) return false;
  const binding = db.prepare(`SELECT binding_id FROM feishu_identity_bindings
    WHERE tenant_id=? AND consultant_id=? AND channel_account_id=? AND open_id=?
      AND binding_status='ACTIVE'`).get(principal.tenantId, principal.consultantId,
    principal.accountId, principal.senderId);
  const scope = db.prepare(`SELECT group_scope_id,allowed_purposes_json FROM agent_group_scopes
    WHERE tenant_id=? AND channel_account_id=? AND chat_id=? AND scope_status='ACTIVE'`)
    .get(principal.tenantId, principal.accountId, principal.chatId);
  const row = db.prepare(`SELECT * FROM openmai_results WHERE project_id=? AND consultant_id=?`)
    .get(searchKey, principal.consultantId);
  if (!binding || !scope || !allowsReview(scope.allowed_purposes_json) || !row?.task_id) return false;
  const at = now();
  db.prepare(`INSERT INTO sourcing_group_deliveries
    (delivery_id,task_id,search_key,consultant_id,binding_id,group_scope_id,
     search_brief,search_round,excluded_candidate_refs_json,next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,group_scope_id) DO NOTHING`).run(
    randomUUID(), row.task_id, searchKey, principal.consultantId, binding.binding_id, scope.group_scope_id,
    row.search_brief, row.search_round || 1, row.excluded_candidate_refs_json || '[]', at, at, at);
  snapshotFreeformResult(db, row.task_id, principal.consultantId);
  return true;
}

export function snapshotFreeformResult(db, taskId, consultantId) {
  const row = db.prepare(`SELECT status,result_text,error FROM openmai_results
    WHERE task_id=? AND consultant_id=?`).get(taskId, consultantId);
  if (!row || !['done', 'needs_input', 'failed'].includes(row.status)) return;
  db.prepare(`UPDATE sourcing_group_deliveries SET result_status=?,result_text=?,error=?,
    delivery_status='PENDING',updated_at=? WHERE task_id=? AND consultant_id=?
    AND delivery_status='WAITING'`).run(row.status, row.result_text, row.error, now(), taskId, consultantId);
}

export async function deliverFreeformResultsOnce(db, deps = {}) {
  const at = deps.at || now();
  const stale = new Date(Date.parse(at) - 60 * 60_000).toISOString();
  const sendingStale = new Date(Date.parse(at) - 10 * 60_000).toISOString();
  // 进程中断后读取同一任务，不读取下一轮覆盖的结果。没有结果则诚实标中断，不重跑搜索。
  for (const row of db.prepare(`SELECT task_id,consultant_id FROM sourcing_group_deliveries
    WHERE delivery_status='WAITING' AND EXISTS (SELECT 1 FROM openmai_results r
      WHERE r.task_id=sourcing_group_deliveries.task_id
      AND r.consultant_id=sourcing_group_deliveries.consultant_id
      AND r.status IN ('done','needs_input','failed')) LIMIT 100`).all()) {
    snapshotFreeformResult(db, row.task_id, row.consultant_id);
  }
  db.prepare(`UPDATE sourcing_group_deliveries SET result_status='failed',
    error='任务中断或超时，未自动重跑；请明确确认后重新搜索。',delivery_status='PENDING',updated_at=?
    WHERE delivery_status='WAITING' AND created_at<=?`).run(at, stale);
  db.prepare(`UPDATE sourcing_group_deliveries SET delivery_status='FAILED',
    last_error='DELIVERY_INTERRUPTED',updated_at=? WHERE delivery_status='SENDING' AND updated_at<=?`)
    .run(at, sendingStale);
  const rows = db.prepare(`SELECT d.*,b.tenant_id,b.channel_account_id,b.feishu_app_key_hash,
    b.binding_status,c.active,s.chat_id,s.tenant_id scope_tenant,s.channel_account_id scope_account,
    s.scope_status,s.allowed_purposes_json FROM sourcing_group_deliveries d
    JOIN feishu_identity_bindings b ON b.binding_id=d.binding_id AND b.consultant_id=d.consultant_id
    JOIN consultants c ON c.consultant_id=d.consultant_id
    JOIN agent_group_scopes s ON s.group_scope_id=d.group_scope_id
    WHERE d.delivery_status IN ('PENDING','FAILED') AND d.attempts<5 AND d.next_attempt_at<=?
    ORDER BY d.created_at LIMIT 10`).all(at);
  const appId = deps.appId ?? configuredFeishuAppId();
  const appHash = appId ? createHash('sha256').update(appId).digest('hex') : null;
  const send = deps.sendInteractiveCard || sendInteractiveCard;
  const counts = { sent: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    if (row.binding_status !== 'ACTIVE' || !row.active || row.scope_status !== 'ACTIVE'
        || row.tenant_id !== row.scope_tenant || row.channel_account_id !== row.scope_account
        || !allowsReview(row.allowed_purposes_json)) {
      db.prepare(`UPDATE sourcing_group_deliveries SET delivery_status='CANCELLED',
        last_error='ACCESS_REVOKED',updated_at=? WHERE delivery_id=?`).run(at, row.delivery_id);
      counts.cancelled += 1;
      continue;
    }
    const claimed = db.prepare(`UPDATE sourcing_group_deliveries SET delivery_status='SENDING',
      attempts=attempts+1,updated_at=? WHERE delivery_id=? AND delivery_status IN ('PENDING','FAILED')`)
      .run(at, row.delivery_id).changes;
    if (!claimed) continue;
    try {
      if (!appHash || row.feishu_app_key_hash !== appHash) throw new Error('DELIVERY_APP_MISMATCH');
      const out = await send({ target: row.chat_id, idempotencyKey: row.delivery_id,
        card: buildOpenmaiDeliveryCard({ job: { ...row, freeform: true, criteria: row.search_brief },
          source: 'supermai', status: row.result_status, resultText: row.result_text,
          error: row.error, publicBaseUrl: deps.publicBaseUrl }) });
      db.prepare(`UPDATE sourcing_group_deliveries SET delivery_status='SENT',message_id=?,
        last_error=NULL,updated_at=? WHERE delivery_id=?`).run(out?.message_id || null, at, row.delivery_id);
      counts.sent += 1;
    } catch (error) {
      const next = new Date(Date.parse(at) + Math.min(300, 5 * 2 ** row.attempts) * 1000).toISOString();
      db.prepare(`UPDATE sourcing_group_deliveries SET delivery_status='FAILED',
        next_attempt_at=?,last_error=?,updated_at=? WHERE delivery_id=?`).run(next,
        error?.message === 'DELIVERY_APP_MISMATCH' ? error.message : 'DELIVERY_FAILED', at, row.delivery_id);
      counts.failed += 1;
    }
  }
  return counts;
}

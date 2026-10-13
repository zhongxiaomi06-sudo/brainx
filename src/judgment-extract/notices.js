/** 复用 judgment 草稿发原群需求线索，不重新调用 AI，不自动确认或找人。 */
import { createHash } from 'node:crypto';
import { now } from '../db.js';
import { configuredFeishuAppId, sendInteractiveCard } from '../feishu-bot.js';
const safe = value => String(value || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱隐藏]')
  .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, '[电话隐藏]').slice(0, 200);
export function buildJudgmentNoticeCard(row) {
  const criteria = `${safe(row.subject_ref)}：${safe(row.statement)}`;
  return { config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '需求线索 · 待确认' } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: `听到你们在聊：${criteria}` } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `来源：本群消息 ${row.message_id}；尚未写入权威条件或启动搜索。` }] },
      { tag: 'action', actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '按此找人' },
          confirm: { title: { tag: 'plain_text', content: '确认启动找人？' },
            text: { tag: 'plain_text', content: '将按卡上条件发起一次 SuperMai 搜索，可能产生费用。' } },
          value: { text: `[BRAINTEX_FREEFORM_START] ${JSON.stringify({ criteria, continue_search: false })}` } },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '记下来' },
          value: { text: `调用 brainx_review_judgment，draft_id=${row.draft_id}、action=confirm、confirm=true；只记录这条需求判断，不找人。` } },
      ] },
    ] };
}
export async function deliverJudgmentNoticesOnce(db, deps = {}) {
  if (!(deps.enabled ?? process.env.BRAINX_DEMAND_NOTICES_ENABLED === '1')) return { sent: 0, failed: 0 };
  const at = deps.at || now();
  const cutoff = new Date(Date.parse(at) - 24 * 3600_000).toISOString();
  const appId = deps.appId ?? configuredFeishuAppId();
  if (!appId) return { sent: 0, failed: 0 };
  const appHash = createHash('sha256').update(appId).digest('hex');
  const rows = db.prepare(`SELECT d.*,s.group_scope_id,s.allowed_purposes_json,n.status notice_status,
      n.attempts,n.next_attempt_at,n.updated_at notice_updated_at FROM judgment_drafts d
    JOIN chat_contexts c ON c.chat_id=d.chat_id AND c.enabled=1 AND c.bot_mode='ALL'
    JOIN agent_group_scopes s ON s.chat_id=d.chat_id AND s.scope_status='ACTIVE'
    LEFT JOIN judgment_notice_deliveries n ON n.draft_id=d.draft_id AND n.group_scope_id=s.group_scope_id
    WHERE d.status='pending' AND d.confidence='high' AND d.kind IN ('PREFERENCE','CONSTRAINT')
      AND d.subject_type IN ('PROJECT','CLIENT_COMPANY') AND d.extracted_at>=?
      AND d.statement_evidence IS NOT NULL AND (n.status IS NULL OR n.status!='SENT')
      AND EXISTS (SELECT 1 FROM feishu_identity_bindings b
        JOIN consultant_chats cc ON cc.consultant_id=b.consultant_id AND cc.chat_id=d.chat_id
        JOIN consultants u ON u.consultant_id=b.consultant_id AND u.active=1
        WHERE b.tenant_id=s.tenant_id AND b.channel_account_id=s.channel_account_id
          AND b.binding_status='ACTIVE' AND b.feishu_app_key_hash=?)
    ORDER BY d.extracted_at LIMIT 20`).all(cutoff, appHash);
  const counts = { sent: 0, failed: 0 };
  for (const row of rows) {
    let purposes;
    try { purposes = JSON.parse(row.allowed_purposes_json); } catch { continue; }
    if (!Array.isArray(purposes) || !['candidate_review', 'job_fact_review'].every(p => purposes.includes(p))) continue;
    if (row.attempts >= 3 || (row.next_attempt_at && row.next_attempt_at > at)) continue;
    if (row.notice_status === 'SENDING' && Date.parse(at) - Date.parse(row.notice_updated_at) < 600_000) continue;
    const claim = db.prepare(`INSERT INTO judgment_notice_deliveries VALUES (?,?,'SENDING',1,?,?)
      ON CONFLICT(draft_id,group_scope_id) DO UPDATE SET status='SENDING',attempts=attempts+1,updated_at=excluded.updated_at
      WHERE judgment_notice_deliveries.status='FAILED' OR judgment_notice_deliveries.updated_at<=?`)
      .run(row.draft_id, row.group_scope_id, at, at, new Date(Date.parse(at) - 600_000).toISOString());
    if (!claim.changes) continue;
    try {
      await (deps.sendCardFn || sendInteractiveCard)({ target: row.chat_id,
        idempotencyKey: `demand:${row.draft_id}:${row.group_scope_id}`, card: buildJudgmentNoticeCard(row) });
      db.prepare("UPDATE judgment_notice_deliveries SET status='SENT',updated_at=? WHERE draft_id=? AND group_scope_id=?")
        .run(at, row.draft_id, row.group_scope_id);
      counts.sent++;
    } catch {
      db.prepare("UPDATE judgment_notice_deliveries SET status='FAILED',next_attempt_at=?,updated_at=? WHERE draft_id=? AND group_scope_id=?")
        .run(new Date(Date.parse(at) + 60_000).toISOString(), at, row.draft_id, row.group_scope_id);
      counts.failed++;
    }
  }
  return counts;
}

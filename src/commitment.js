/** commitment.js — 承接行动闭环事务编排。
 * engagement.js 仍只负责事件状态机；本模块原子协调目标、行动、结果和状态。
 */
import { now, uuid } from './db.js';
import { engage, currentState, legalActions } from './engagement.js';
import { effectiveJob } from './facts.js';
import { clearOpportunityIgnore } from './opportunity-ignore.js';

export const RELEASE_REASONS = ['资源不足', '优先级调整', '转交其他顾问', '客户/职位变化', '当前无法投入', '其他'];
export const CLOSE_REASONS = ['职位关闭', 'HC 已满', '客户暂停', '需求取消', '其他'];
export const TERMINAL_STAGES = ['入职', '关闭'];
const PROGRESS_KINDS = ['PROGRESS', 'STAGE', 'BLOCKED'];

function fail(status, error) { return { ok: false, status, error }; }
function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); } catch { return fallback; }
}

function transact(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    if (!out?.ok) { db.exec('ROLLBACK'); return out; }
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error?.message).includes('idx_commitment_actions_current') ||
        String(error?.message).includes('commitment_actions.consultant_id, commitment_actions.project_id')) {
      return fail(409, '该职位已有一条当前行动');
    }
    throw error;
  }
}

function validDueAt(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '截止时间无效';
  const delta = timestamp - Date.now();
  if (delta <= 0) return '截止时间必须晚于现在';
  if (delta > 90 * 86400000) return '截止时间必须在未来 90 天内';
  return null;
}

function dueAt18(days) {
  const local = new Date(Date.now() + 8 * 3600000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, 10, 0, 0)).toISOString();
}

function activeAction(db, consultant_id, project_id) {
  return db.prepare(`SELECT action_id, consultant_id, project_id, title, due_at, status,
      source, created_at, updated_at, completed_at, completion_note
    FROM commitment_actions
    WHERE consultant_id=? AND project_id=? AND status IN ('OPEN','BLOCKED')
    ORDER BY created_at DESC LIMIT 1`).get(consultant_id, project_id) || null;
}

function actionById(db, consultant_id, project_id, action_id) {
  return db.prepare(`SELECT * FROM commitment_actions
    WHERE consultant_id=? AND project_id=? AND action_id=?`).get(consultant_id, project_id, action_id);
}

function latestAcceptedGoal(db, consultant_id, project_id) {
  const row = db.prepare(`SELECT payload_json FROM decision_events
    WHERE actor=? AND project_id=? AND event_type='ACCEPTED'
    ORDER BY id DESC LIMIT 1`).get(consultant_id, project_id);
  const eventGoal = clean(parseJson(row?.payload_json).goal, 240);
  if (eventGoal) return eventGoal;
  return clean(db.prepare(`SELECT goal FROM commitment_actions
    WHERE consultant_id=? AND project_id=? AND goal IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`).get(consultant_id, project_id)?.goal, 240) || null;
}

function terminalOutcome(db, consultant_id, project_id) {
  return db.prepare(`SELECT id, stage, value_json, observed_at FROM job_outcomes
    WHERE consultant_id=? AND project_id=? AND stage IN ('入职','关闭')
    ORDER BY observed_at DESC, id DESC LIMIT 1`).get(consultant_id, project_id) || null;
}

export function suggestedAction(db, consultant_id, project_id, { kind = 'STAGE', stage = '' } = {}) {
  const real = clean(effectiveJob(db, consultant_id, project_id)?.next_action, 240);
  if (real) return { title: real, due_at: dueAt18(1), source: 'MANUAL', rule: 'CURRENT_FACT_NEXT_ACTION' };
  if (kind === 'BLOCKED') return { title: '解除阻塞并更新处理结果', due_at: dueAt18(1), source: 'RULE', rule: 'BLOCKED_NEXT_DAY' };
  const rules = {
    '推荐采纳': ['跟进客户反馈并确认面试转化', 2, 'RECOMMENDED_FOLLOW_UP'],
    '面试': ['确认面试反馈和下一轮安排', 2, 'INTERVIEW_FOLLOW_UP'],
    'Offer': ['确认 Offer 接受结果和入职计划', 1, 'OFFER_FOLLOW_UP'],
  };
  const [title, days, rule] = rules[stage] || ['确认下一步负责人、目标和反馈时间', 1, 'DEFAULT_NEXT_ACTION'];
  return { title, due_at: dueAt18(days), source: 'RULE', rule };
}

export function commitmentDetails(db, consultant_id, project_id) {
  const state = currentState(db, consultant_id, project_id).state;
  const actions = db.prepare(`SELECT action_id, consultant_id, project_id, title, due_at,
      status, source, created_at, updated_at, completed_at, completion_note
    FROM commitment_actions WHERE consultant_id=? AND project_id=?
    ORDER BY created_at DESC`).all(consultant_id, project_id);
  const terminal = terminalOutcome(db, consultant_id, project_id);
  return {
    commitment_goal: latestAcceptedGoal(db, consultant_id, project_id),
    active_action: actions.find((item) => ['OPEN', 'BLOCKED'].includes(item.status)) || null,
    action_history: actions.filter((item) => ['DONE', 'CANCELLED'].includes(item.status)),
    suggested_action: state === 'ACCEPTED' ? suggestedAction(db, consultant_id, project_id) : null,
    terminal_result_missing: state === 'COMPLETED' && !terminal,
  };
}

function insertAction(db, consultant_id, project_id, { title, goal = null, due_at, source = 'MANUAL', idempotency_key, status = 'OPEN' }) {
  const action_id = uuid();
  const at = now();
  db.prepare(`INSERT INTO commitment_actions
    (action_id, consultant_id, project_id, title, goal, due_at, status, source,
     created_at, updated_at, idempotency_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(action_id, consultant_id, project_id, title, goal, due_at, status, source, at, at, idempotency_key);
  return activeAction(db, consultant_id, project_id);
}

export function acceptCommitment(db, consultant_id, project_id, input = {}) {
  const goal = clean(input.goal, 240);
  const title = clean(input.action_title || input.next_action?.title, 240);
  const due_at = input.due_at || input.next_action?.due_at;
  if (!input.idempotency_key) return fail(400, '缺 idempotency_key');
  const duplicate = db.prepare(`SELECT event_id, next_state FROM decision_events WHERE idempotency_key=?`).get(input.idempotency_key);
  if (duplicate) return { ok: true, already: true, event_id: duplicate.event_id, state: duplicate.next_state,
    active_action: activeAction(db, consultant_id, project_id), legal_actions: legalActions(db, consultant_id, project_id) };
  if (!goal || !title || !due_at) return fail(422, '接单必须确认本轮目标、第一条行动和截止时间');
  const dueError = validDueAt(due_at);
  if (dueError) return fail(422, dueError);
  const state = currentState(db, consultant_id, project_id).state;
  if (state === 'ACCEPTED') {
    const existing = activeAction(db, consultant_id, project_id);
    if (existing) return fail(409, '该职位已有当前行动');
    const duplicateAction = db.prepare(`SELECT action_id FROM commitment_actions WHERE idempotency_key=?`)
      .get(`${input.idempotency_key}:action`);
    if (duplicateAction) return { ok: true, already: true, repaired: true, state,
      active_action: actionById(db, consultant_id, project_id, duplicateAction.action_id) };
    return transact(db, () => ({ ok: true, repaired: true, state,
      active_action: insertAction(db, consultant_id, project_id, { title, goal,
        due_at: new Date(due_at).toISOString(), source: 'MANUAL', idempotency_key: `${input.idempotency_key}:action` }) }));
  }
  return transact(db, () => {
    clearOpportunityIgnore(db, consultant_id, project_id);
    const event = engage(db, consultant_id, project_id, 'ACCEPT', {
      confirm: true, idempotency_key: input.idempotency_key, payload: { goal },
    });
    if (!event.ok) return event;
    const action = insertAction(db, consultant_id, project_id, {
      title, goal, due_at: new Date(due_at).toISOString(), source: 'MANUAL', idempotency_key: `${input.idempotency_key}:action`,
    });
    return { ...event, active_action: action, commitment_goal: goal };
  });
}

function insertOutcome(db, consultant_id, project_id, {
  stage, summary, rating, kind, action_id = null, close_reason = null, decision_id = null, idempotency_key,
}) {
  const value = { summary, note: summary, rating: Number.isFinite(Number(rating)) ? Number(rating) : null };
  if (close_reason) value.close_reason = close_reason;
  db.prepare(`INSERT INTO job_outcomes
    (project_id, consultant_id, stage, value_json, decision_id, idempotency_key,
     observed_at, action_id, kind)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(project_id, consultant_id, stage || '进展', JSON.stringify(value), decision_id,
      idempotency_key, now(), action_id, kind);
}

export function recordProgress(db, consultant_id, project_id, input = {}) {
  const kind = clean(input.kind || 'PROGRESS', 20).toUpperCase();
  const stage = clean(input.stage, 40);
  const summary = clean(input.summary, 1000);
  const nextTitle = clean(input.next_action?.title, 240);
  const nextDue = input.next_action?.due_at;
  if (!input.idempotency_key) return fail(400, '缺 idempotency_key');
  if (db.prepare('SELECT 1 FROM job_outcomes WHERE idempotency_key=?').get(input.idempotency_key)) {
    return { ok: true, already: true, active_action: activeAction(db, consultant_id, project_id) };
  }
  if (currentState(db, consultant_id, project_id).state !== 'ACCEPTED') return fail(409, '只有已接单职位可以回写进展');
  if (!PROGRESS_KINDS.includes(kind)) return fail(422, '进展类型无效');
  if (!summary || !nextTitle || !nextDue) return fail(422, '进展必须包含本次结果和下一行动');
  if (TERMINAL_STAGES.includes(stage)) return fail(422, '入职或关闭请使用终局结果接口');
  const dueError = validDueAt(nextDue);
  if (dueError) return fail(422, dueError);
  const current = actionById(db, consultant_id, project_id, input.action_id);
  if (!current || !['OPEN', 'BLOCKED'].includes(current.status)) return fail(409, '当前行动已变化，请刷新后重试');
  return transact(db, () => {
    const at = now();
    db.prepare(`UPDATE commitment_actions SET status='DONE', updated_at=?, completed_at=?, completion_note=?
      WHERE action_id=?`).run(at, at, summary, current.action_id);
    insertOutcome(db, consultant_id, project_id, { stage, summary, rating: input.rating,
      kind, action_id: current.action_id, decision_id: input.decision_id, idempotency_key: input.idempotency_key });
    const action = insertAction(db, consultant_id, project_id, {
      title: nextTitle, due_at: new Date(nextDue).toISOString(),
      source: input.next_action?.source === 'RULE' ? 'RULE' : 'MANUAL',
      status: kind === 'BLOCKED' ? 'BLOCKED' : 'OPEN', idempotency_key: `${input.idempotency_key}:action`,
    });
    return { ok: true, active_action: action, incorporated_into_next_decision: true };
  });
}

export function recordTerminalResult(db, consultant_id, project_id, input = {}) {
  const stage = clean(input.stage, 40);
  const summary = clean(input.summary, 1000);
  const closeReason = clean(input.close_reason, 80);
  if (!input.idempotency_key) return fail(400, '缺 idempotency_key');
  if (!TERMINAL_STAGES.includes(stage)) return fail(422, '终局结果只允许入职或关闭');
  if (!summary) return fail(422, '终局结果必须填写摘要');
  if (stage === '关闭' && !CLOSE_REASONS.includes(closeReason)) return fail(422, '关闭必须选择合法原因');
  if (db.prepare('SELECT 1 FROM job_outcomes WHERE idempotency_key=?').get(input.idempotency_key)) {
    return { ok: true, already: true, state: currentState(db, consultant_id, project_id).state };
  }
  const state = currentState(db, consultant_id, project_id).state;
  const backfill = state === 'COMPLETED' && !terminalOutcome(db, consultant_id, project_id);
  if (state !== 'ACCEPTED' && !backfill) return fail(409, '当前承接不能写入终局结果');
  return transact(db, () => {
    const current = activeAction(db, consultant_id, project_id);
    if (current) {
      const at = now();
      db.prepare(`UPDATE commitment_actions SET status='DONE', updated_at=?, completed_at=?, completion_note=?
        WHERE action_id=?`).run(at, at, summary, current.action_id);
    }
    insertOutcome(db, consultant_id, project_id, { stage, summary, rating: input.rating,
      kind: 'TERMINAL', action_id: current?.action_id || null, close_reason: closeReason || null,
      decision_id: input.decision_id, idempotency_key: input.idempotency_key });
    if (backfill) return { ok: true, state: 'COMPLETED', backfilled: true };
    const completed = engage(db, consultant_id, project_id, 'COMPLETE', {
      idempotency_key: `${input.idempotency_key}:state`, reason: stage,
      payload: { stage, summary, close_reason: closeReason || null },
    });
    return completed.ok ? { ...completed, backfilled: false } : completed;
  });
}

export function releaseCommitment(db, consultant_id, project_id, input = {}) {
  const reason = clean(input.reason, 80);
  const summary = clean(input.summary, 1000);
  if (!input.idempotency_key) return fail(400, '缺 idempotency_key');
  if (!RELEASE_REASONS.includes(reason) || !summary) return fail(422, '释放必须选择合法原因并填写说明');
  const duplicate = db.prepare(`SELECT event_id, next_state FROM decision_events WHERE idempotency_key=?`).get(input.idempotency_key);
  if (duplicate) return { ok: true, already: true, event_id: duplicate.event_id, state: duplicate.next_state };
  if (currentState(db, consultant_id, project_id).state !== 'ACCEPTED') return fail(409, '只有已接单职位可以释放');
  return transact(db, () => {
    const current = activeAction(db, consultant_id, project_id);
    if (current) {
      const at = now();
      db.prepare(`UPDATE commitment_actions SET status='CANCELLED', updated_at=?, completed_at=?, completion_note=?
        WHERE action_id=?`).run(at, at, `${reason}：${summary}`, current.action_id);
    }
    return engage(db, consultant_id, project_id, 'RELEASE', {
      idempotency_key: input.idempotency_key, reason: `${reason}：${summary}`,
      payload: { reason, summary },
    });
  });
}

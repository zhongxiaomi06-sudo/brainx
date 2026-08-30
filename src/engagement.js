/** engagement.js — 职位查看与跟进状态机（PRD §7）。
 *
 * 正式状态机：NEW/RECOMMENDED/VIEWED→ACCEPTED→RELEASED/COMPLETED。
 * WATCHED/DISMISSED/EXPIRED 只作为历史账本兼容输入，对外统一折叠为待开始；
 * 新的忽略语义由 opportunity_ignores 独立记录，不再生成承接状态事件。
 * 单一承接事实源 = decision_events 账本（current_engagement 视图推导）。
 */
import { now, uuid } from './db.js';
import { relationOf } from './relations.js';

/** 正式动作表；旧关注/暂不考虑动作不再接受写入。 */
const TRANSITIONS = {
  VIEW:    { from: ['NEW', 'RECOMMENDED', 'VIEWED', 'WATCHED', 'DISMISSED', 'RELEASED', 'EXPIRED'], to: 'VIEWED', event: 'VIEWED' },
  ACCEPT:  { from: ['NEW', 'WATCHED', 'VIEWED', 'RECOMMENDED', 'DISMISSED', 'RELEASED', 'EXPIRED'], to: 'ACCEPTED', event: 'ACCEPTED', confirm: true },
  RELEASE: { from: ['ACCEPTED'], to: 'RELEASED', event: 'RELEASED' },
  COMPLETE:{ from: ['ACCEPTED'], to: 'COMPLETED', event: 'COMPLETED' },
};

export function publicEngagementState(state) {
  return ['WATCHED', 'DISMISSED', 'EXPIRED'].includes(state) ? 'VIEWED' : state;
}

export function currentState(db, consultant_id, project_id) {
  const row = db.prepare(`SELECT state, state_since FROM current_engagement
    WHERE consultant_id=? AND project_id=?`).get(consultant_id, project_id);
  if (row) return { ...row, state: publicEngagementState(row.state) };
  const rec = db.prepare(`SELECT 1 FROM recommendations
    WHERE consultant_id=? AND project_id=? LIMIT 1`).get(consultant_id, project_id)
    || db.prepare(`SELECT 1 FROM decision_events
      WHERE actor=? AND project_id=? AND event_type='RECOMMENDED' LIMIT 1`).get(consultant_id, project_id);
  return { state: rec ? 'RECOMMENDED' : 'NEW', state_since: null };
}

/**
 * 批量读取顾问的职位状态。雷达/客户列表必须使用这一入口，避免为每个职位
 * 分别查询 current_engagement 与 decision_events，导致大职位池把主线程堵死。
 */
export function currentStateMap(db, consultant_id) {
  // current_engagement 是面向单职位读取的兼容视图；对整个职位池查询会触发
  // 相关子查询。批量路径直接在该顾问事件上做一次窗口归并。
  const states = new Map(db.prepare(`SELECT project_id, state, state_since FROM (
    SELECT project_id, next_state AS state, occurred_at AS state_since,
      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY occurred_at DESC, id DESC) AS position
    FROM decision_events
    WHERE actor=? AND event_type IN
      ('VIEWED','WATCHED','ACCEPTED','DISMISSED','RELEASED','EXPIRED','COMPLETED')
  ) WHERE position=1`).all(consultant_id)
    .map((row) => [row.project_id, {
      state: publicEngagementState(row.state), state_since: row.state_since,
    }]));
  const recommended = db.prepare(`SELECT DISTINCT project_id FROM recommendations
    WHERE consultant_id=?
    UNION SELECT DISTINCT project_id FROM decision_events
    WHERE actor=? AND event_type='RECOMMENDED'`).all(consultant_id, consultant_id);
  for (const row of recommended) {
    if (!states.has(row.project_id)) {
      states.set(row.project_id, { state: 'RECOMMENDED', state_since: null });
    }
  }
  return states;
}

/**
 * 执行承接动作。返回 { ok, state, event_id, already, legal_actions } 或 { ok:false, status, error }。
 * 幂等：同 idempotency_key 直接返回首次结果（already=true）。
 */
export function engage(db, consultant_id, project_id, action,
                       { reason = '', confirm = false, idempotency_key = '', payload = {} } = {}) {
  if (!idempotency_key) return { ok: false, status: 400, error: '缺 idempotency_key' };
  const dup = db.prepare(`SELECT event_id, next_state FROM decision_events
    WHERE idempotency_key=?`).get(idempotency_key);
  if (dup) {
    return { ok: true, already: true, event_id: dup.event_id, state: dup.next_state,
             legal_actions: legalActions(db, consultant_id, project_id) };
  }

  const t = TRANSITIONS[action];
  if (!t) return { ok: false, status: 400, error: `未知动作 ${action}` };
  const job = db.prepare(`SELECT * FROM job_facts WHERE project_id=?`).get(project_id);
  if (!job) return { ok: false, status: 404, error: '职位不存在' };

  const cur = currentState(db, consultant_id, project_id);
  if (!t.from.includes(cur.state)) {
    return { ok: false, status: 409, error: `状态冲突：当前 ${cur.state}，不允许 ${action}`,
             state: cur.state, legal_actions: legalActions(db, consultant_id, project_id) };
  }
  if (t.confirm && !confirm) return { ok: false, status: 409, error: '接单必须二次确认（confirm=true）' };
  const event_id = uuid();
  const next = typeof t.to === 'function' ? t.to(cur.state) : t.to;
  db.prepare(`INSERT INTO decision_events
    (event_id, event_type, actor, occurred_at, project_id, decision_id, policy_version,
     idempotency_key, prev_state, next_state, reason, payload_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(event_id, t.event, consultant_id, now(), project_id, null, null,
         idempotency_key, cur.state, next, t.note || reason || null, JSON.stringify(payload || {}));
  return { ok: true, already: false, event_id, state: next,
           legal_actions: legalActions(db, consultant_id, project_id) };
}

export function legalActions(db, consultant_id, project_id) {
  const { state } = currentState(db, consultant_id, project_id);
  return legalActionsForState(state);
}

/** 已批量取得状态时复用，避免列表逐职位重复查询状态视图。 */
export function legalActionsForState(state) {
  return Object.entries(TRANSITIONS)
    .filter(([action, t]) => action !== 'VIEW' && t.from.includes(state)).map(([k]) => k);
}

/** 承接摘要（首屏底部）：跟进中/需要处理；关注计数仅保留零值兼容字段。 */
export function commitmentSummary(db, consultant_id) {
  const rows = db.prepare(`SELECT project_id, state, state_since FROM current_engagement
    WHERE consultant_id=? AND state='ACCEPTED'`).all(consultant_id);
  const jobs = db.prepare('SELECT project_id, company, role, active_state FROM job_facts').all();
  const jm = Object.fromEntries(jobs.map((j) => [j.project_id, j]));
  const items = rows.map((r) => ({
    ...r, company: jm[r.project_id]?.company, role: jm[r.project_id]?.role,
    active_state: jm[r.project_id]?.active_state,
    next_action: '推进交付或记录结果',
  }));
  const accepted = rows.filter((r) => r.state === 'ACCEPTED');
  // 需要处理：跟进行动逾期、阻塞或缺失。
  const need = items.filter((r) => {
    if (r.state === 'ACCEPTED') {
      const action = db.prepare(`SELECT status, due_at FROM commitment_actions
        WHERE project_id=? AND consultant_id=? AND status IN ('OPEN','BLOCKED')
        ORDER BY created_at DESC LIMIT 1`).get(r.project_id, consultant_id);
      return !action || action.status === 'BLOCKED' || Date.parse(action.due_at) < Date.parse(now());
    }
    return false;
  });
  return {
    accepted_count: accepted.length, watched_count: 0,
    watched_limit: 0, need_action_count: need.length,
    items: items.sort((a, b) => (a.state > b.state ? -1 : 1)),
  };
}

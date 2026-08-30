/** engagement.js — 职位状态机 + 幂等 + 关注上限 + 冷却期（PRD §7）。
 *
 * 状态机：NEW→RECOMMENDED→VIEWED→WATCHED→ACCEPTED→RELEASED/COMPLETED
 *   DISMISSED 冷却 30 天（冷却后可重新关注）；WATCHED 90 天无动作 → EXPIRED；关注 ≤10。
 * 单一事实源 = decision_events 账本（current_engagement 视图推导）。
 *
 * 2026-08-14 前后端对齐修正：
 *   - WATCH.from 补 RELEASED/DISMISSED、DISMISS.from 补 RELEASED——与前端交付契约
 *     （「已释放→重新关注/暂不考虑」「暂不考虑→重新关注」）一致；
 *     修正前冷却期守卫（inCooldown）对 DISMISSED 职位永远不可达（状态冲突先拦断）。
 *
 * 2026-08-10 框架修正：
 *   - VIEW 是审计事件不是降级动作：查看 WATCHED 职位 next_state 保持 WATCHED
 *     （修正前会写成 VIEWED，关注被静默冲掉）；
 *   - current_engagement 视图（0006 起）把 VIEWED 纳入推导，VIEWED 状态真正可达；
 *   - UNWATCH 的 note『关注回滚』落进 reason 列（修正前定义了却从不持久化）。
 */
import { now, uuid } from './db.js';
import { relationOf } from './relations.js';

const WATCH_LIMIT = 10;
const COOLDOWN_DAYS = 30;
const EXPIRE_DAYS = 90;

/** 合法迁移表。to 为函数时按当前态求 next_state（VIEW 不降级 WATCHED）。 */
const TRANSITIONS = {
  VIEW:    { from: ['NEW', 'RECOMMENDED', 'VIEWED', 'WATCHED', 'EXPIRED'], to: (s) => (s === 'WATCHED' ? 'WATCHED' : 'VIEWED'), event: 'VIEWED' },
  WATCH:   { from: ['NEW', 'RECOMMENDED', 'VIEWED', 'RELEASED', 'DISMISSED', 'EXPIRED'], to: 'WATCHED', event: 'WATCHED' },
  UNWATCH: { from: ['WATCHED'], to: 'VIEWED', event: 'RELEASED', note: '关注回滚' },
  // 2026-08-24 修复：EXPIRED/NEW 可直接接单——90 天过期曾无出口（永远 409），
  // 未被推荐触碰过的职位（NEW）也不应强制先关注再接单；ACCEPT 自带 confirm 门槛。
  ACCEPT:  { from: ['NEW', 'WATCHED', 'VIEWED', 'RECOMMENDED', 'EXPIRED'], to: 'ACCEPTED', event: 'ACCEPTED', confirm: true },
  DISMISS: { from: ['NEW', 'RECOMMENDED', 'VIEWED', 'WATCHED', 'RELEASED', 'EXPIRED'], to: 'DISMISSED', event: 'DISMISSED', reason: true },
  RELEASE: { from: ['ACCEPTED'], to: 'RELEASED', event: 'RELEASED' },
  COMPLETE:{ from: ['ACCEPTED'], to: 'COMPLETED', event: 'COMPLETED' },
};

export const DISMISS_REASONS = ['无资源', '不符合方向', '客户/职位质量不足', '当前没精力', '已有其他顾问推进', '信息不完整', '其他'];

export function currentState(db, consultant_id, project_id) {
  const row = db.prepare(`SELECT state, state_since FROM current_engagement
    WHERE consultant_id=? AND project_id=?`).get(consultant_id, project_id);
  if (row) return row;
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
    .map((row) => [row.project_id, { state: row.state, state_since: row.state_since }]));
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

/** 冷却中的职位（DISMISSED 未超 30 天）。 */
export function inCooldown(db, consultant_id, project_id, at = now()) {
  const d = db.prepare(`SELECT occurred_at FROM decision_events
    WHERE actor=? AND project_id=? AND event_type='DISMISSED'
    ORDER BY occurred_at DESC LIMIT 1`).get(consultant_id, project_id);
  if (!d) return null;
  const until = new Date(Date.parse(d.occurred_at) + COOLDOWN_DAYS * 86400000).toISOString();
  return until > at ? until : null;
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
  if (t.reason && !reason) return { ok: false, status: 422, error: '暂不考虑必须选择原因' };
  if (t.reason && !DISMISS_REASONS.includes(reason)) return { ok: false, status: 422, error: '原因不在枚举内' };

  if (action === 'WATCH') {
    const cd = inCooldown(db, consultant_id, project_id);
    if (cd) return { ok: false, status: 409, error: `冷却期至 ${cd.slice(0, 10)}，暂不可关注` };
    const n = db.prepare(`SELECT COUNT(*) n FROM current_engagement
      WHERE consultant_id=? AND state='WATCHED'`).get(consultant_id).n;
    if (n >= WATCH_LIMIT) return { ok: false, status: 409, error: `关注榜已满（${WATCH_LIMIT}/${WATCH_LIMIT}），请先释放一个职位` };
  }

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
  let acts = legalActionsForState(state);
  // 与 engage() 同一判定：冷却期/关注榜满时不 advertise 必失败的 WATCH（防死循环引导按钮）
  if (acts.includes('WATCH')) {
    const full = db.prepare(`SELECT COUNT(*) n FROM current_engagement
      WHERE consultant_id=? AND state='WATCHED'`).get(consultant_id).n >= WATCH_LIMIT;
    if (full || inCooldown(db, consultant_id, project_id)) acts = acts.filter((a) => a !== 'WATCH');
  }
  return acts;
}

/** 已批量取得状态时复用，避免列表逐职位重复查询状态视图。 */
export function legalActionsForState(state) {
  return Object.entries(TRANSITIONS)
    .filter(([, t]) => t.from.includes(state)).map(([k]) => k);
}

/** 承接摘要（首屏底部）：接单中/关注中/需要处理。 */
export function commitmentSummary(db, consultant_id) {
  const rows = db.prepare(`SELECT project_id, state, state_since FROM current_engagement
    WHERE consultant_id=? AND state IN ('WATCHED','ACCEPTED','DISMISSED')`).all(consultant_id);
  const jobs = db.prepare('SELECT project_id, company, role, active_state FROM job_facts').all();
  const jm = Object.fromEntries(jobs.map((j) => [j.project_id, j]));
  const items = rows.map((r) => ({
    ...r, company: jm[r.project_id]?.company, role: jm[r.project_id]?.role,
    active_state: jm[r.project_id]?.active_state,
    next_action: r.state === 'ACCEPTED' ? '推进交付或记录结果'
               : r.state === 'WATCHED' ? '评估后接单或取消关注'
               : `冷却中（${COOLDOWN_DAYS} 天）`,
  }));
  const accepted = rows.filter((r) => r.state === 'ACCEPTED');
  const watched = rows.filter((r) => r.state === 'WATCHED');
  // 需要处理：关注超过 7 天，或接单行动逾期/阻塞/缺失。
  const need = items.filter((r) => {
    if (r.state === 'WATCHED' && r.state_since &&
        Date.parse(now()) - Date.parse(r.state_since) > 7 * 86400000) return true;
    if (r.state === 'ACCEPTED') {
      const action = db.prepare(`SELECT status, due_at FROM commitment_actions
        WHERE project_id=? AND consultant_id=? AND status IN ('OPEN','BLOCKED')
        ORDER BY created_at DESC LIMIT 1`).get(r.project_id, consultant_id);
      return !action || action.status === 'BLOCKED' || Date.parse(action.due_at) < Date.parse(now());
    }
    return false;
  });
  return {
    accepted_count: accepted.length, watched_count: watched.length,
    watched_limit: WATCH_LIMIT, need_action_count: need.length,
    items: items.sort((a, b) => {
      if (a.state === b.state) return 0;
      return a.state > b.state ? -1 : 1;
    }),
  };
}

/** 90 天无动作关注 → EXPIRED（CLI/定时任务调用）。 */
export function expireStaleWatches(db, consultant_id) {
  const stale = db.prepare(`SELECT project_id, state_since FROM current_engagement
    WHERE consultant_id=? AND state='WATCHED'`).all(consultant_id)
    .filter((r) => Date.parse(now()) - Date.parse(r.state_since) > EXPIRE_DAYS * 86400000);
  for (const s of stale) {
    db.prepare(`INSERT INTO decision_events
      (event_id, event_type, actor, occurred_at, project_id, idempotency_key, prev_state, next_state, payload_json)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), 'EXPIRED', consultant_id, now(), s.project_id,
           `expire:${s.project_id}:${s.state_since}`, 'WATCHED', 'EXPIRED', '{}');
  }
  return stale.length;
}

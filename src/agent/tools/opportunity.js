/** 单职位全量(事实/关系/承接状态/合法操作/事件/结果/最近推荐;visibility fail-closed)。 */
import { currentState, legalActions } from '../../engagement.js';
import { commitmentDetails } from '../../commitment.js';
import { relationOf } from '../../relations.js';
import { jobVisibleTo } from '../../visibility.js';

export default {
  name: 'brainx_opportunity',
  description: '单个职位全量:基本事实/与当前顾问的关系/承接状态/合法操作/事件流水/结果观察/最近一次推荐评分与理由。project_id 形如 P-FIX-xxxxxxxx。不可见返回 NOT_FOUND。',
  parameters: { type: 'object', required: ['project_id'], properties: {
    project_id: { type: 'string', description: '职位 ID(P-FIX- 开头)' } } },
  run: ({ project_id: pid }, ctx) => {
    const { db, cid } = ctx;
    const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(pid);
    // 与 HTTP 同一可见性规则(visibility.js 单一权威):无关系 = NOT_FOUND
    if (!job || !jobVisibleTo(db, cid, pid)) return { error: 'NOT_FOUND', project_id: pid };
    const rel = relationOf(db, cid, pid);
    const eng = currentState(db, cid, pid);
    const events = db.prepare(`SELECT event_type, occurred_at, actor, reason FROM decision_events
      WHERE project_id=? AND actor=? ORDER BY occurred_at, id`).all(pid, cid);
    const rec = db.prepare(`SELECT * FROM recommendations WHERE project_id=? AND consultant_id=?
      ORDER BY created_at DESC LIMIT 1`).get(pid, cid);
    const outs = db.prepare(`SELECT stage, value_json, observed_at, action_id, kind FROM job_outcomes
      WHERE project_id=? AND consultant_id=? ORDER BY observed_at`).all(pid, cid);
    return {
      job: { ...job, raw_json: undefined, relation: rel }, relation: rel,
      engagement_state: eng.state, legal_actions: legalActions(db, cid, pid).filter((a) => a !== 'COMPLETE'),
      events, outcomes: outs.map((o) => ({ ...o, value: JSON.parse(o.value_json) })),
      ...commitmentDetails(db, cid, pid),
      latest_recommendation: rec ? { decision_id: rec.decision_id, score: rec.score,
        action: rec.action, confidence_band: rec.confidence_band,
        evidence_coverage: rec.evidence_coverage,
        reasons: JSON.parse(rec.reasons_json), risks: JSON.parse(rec.risks_json),
        breakdown: JSON.parse(rec.breakdown_json) } : null,
    };
  },
};

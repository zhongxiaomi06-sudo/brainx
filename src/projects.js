/** projects.js — “我的项目”真实摘要；membership 是项目归属的唯一入口。 */
import { now } from './db.js';
import { legalActions, publicEngagementState } from './engagement.js';

function projectStatus(state, action) {
  if (state === 'COMPLETED') return 'COMPLETED';
  if (state === 'RELEASED') return 'RELEASED';
  if (state !== 'ACCEPTED') return 'PENDING_START';
  if (!action || action.status === 'BLOCKED' || Date.parse(action.due_at) < Date.parse(now())) {
    return 'NEEDS_ACTION';
  }
  return 'IN_PROGRESS';
}

export function listProjects(db, consultant_id, { projectId = null } = {}) {
  const projectFilter = projectId ? ' AND m.project_id=?' : '';
  const rows = db.prepare(`SELECT
      m.project_id, m.relation, m.source AS membership_source, m.valid_from AS joined_at,
      j.company, j.role, j.city, j.active_state, j.hc, j.pipeline,
      c.current_stage, c.pipeline_snapshot, c.next_action, j.owner_name, j.captured_at,
      e.state AS engagement_state, e.state_since,
      a.action_id, a.title AS action_title, a.goal, a.due_at, a.status AS action_status,
      a.source AS action_source, a.updated_at AS action_updated_at
    FROM job_memberships m
    JOIN job_facts j ON j.project_id=m.project_id
    LEFT JOIN cockpit_facts c ON c.project_id=m.project_id
    LEFT JOIN current_engagement e
      ON e.project_id=m.project_id AND e.consultant_id=m.consultant_id
    LEFT JOIN commitment_actions a
      ON a.project_id=m.project_id AND a.consultant_id=m.consultant_id
      AND a.status IN ('OPEN','BLOCKED')
    WHERE m.consultant_id=? AND m.valid_to IS NULL
      AND m.relation IN ('MY_JOB','TEAM_SHARED')
      AND NOT EXISTS (SELECT 1 FROM opportunity_ignores i
        WHERE i.consultant_id=m.consultant_id AND i.project_id=m.project_id)
      ${projectFilter}
    ORDER BY m.valid_from DESC, m.project_id`).all(...(projectId ? [consultant_id, projectId] : [consultant_id]));

  return rows.map((row) => {
    const action = row.action_id ? {
      action_id: row.action_id,
      title: row.action_title,
      goal: row.goal || null,
      due_at: row.due_at,
      status: row.action_status,
      source: row.action_source,
      updated_at: row.action_updated_at,
    } : null;
    const state = publicEngagementState(row.engagement_state || 'NEW');
    return {
      project_id: row.project_id,
      relation: row.relation,
      membership_source: row.membership_source,
      joined_at: row.joined_at,
      company: row.company,
      role: row.role,
      city: row.city || null,
      active_state: row.active_state || null,
      hc: row.hc ?? null,
      pipeline: row.pipeline || null,
      current_stage: row.current_stage || null,
      pipeline_snapshot: row.pipeline_snapshot || null,
      next_action: row.next_action || null,
      owner_name: row.owner_name || null,
      captured_at: row.captured_at || null,
      engagement_state: state,
      state_since: row.state_since || null,
      project_status: projectStatus(state, action),
      active_action: action,
      legal_actions: legalActions(db, consultant_id, row.project_id),
    };
  });
}

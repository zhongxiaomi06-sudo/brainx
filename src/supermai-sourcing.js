/** SuperMai 找人入口：创建云端任务，由顾问自己的桌面连接器出站领取并执行。 */
import { createHash } from 'node:crypto';
import { now, uuid } from './db.js';
import { normalizeExcludedCandidateRefs } from './search-rounds.js';
import { supermaiDeviceStatus } from './supermai-relay.js';

/** 同一自由判据得到稳定项目键，项目群模式继续使用真实 project_id。 */
export function supermaiCriteriaKey(criteria) {
  const text = String(criteria || '').trim();
  return `supermai:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

/** 旧投递表按 (project_id, consultant_id) 唯一；使用来源命名空间避免复用 OpenMai 结果。 */
export function supermaiResultKey(projectId) {
  return `supermai-result:${String(projectId || '').trim()}`;
}

/** 保留为可读判据构造器；真正搜索由桌面 SuperMai 完成，不再发送给 OpenMai。 */
export function buildScoutPrompt(criteria, excludedCandidateRefs = []) {
  const exclusions = normalizeExcludedCandidateRefs(excludedCandidateRefs);
  return [
    String(criteria || '').trim(),
    exclusions.length ? `排除已推荐候选人：${exclusions.join('、')}` : '',
  ].filter(Boolean).join('\n');
}

function taskStatus(db, taskId) {
  if (!taskId) return null;
  return db.prepare(`SELECT task_id,status,device_id,created_at,started_at,finished_at,error_code,error_message
    FROM sourcing_tasks WHERE task_id=? AND provider='supermai'`).get(taskId) || null;
}

export function getSupermaiTask(db, consultantId, projectId) {
  return db.prepare(`SELECT * FROM sourcing_tasks WHERE consultant_id=? AND project_id=?
    AND provider='supermai' ORDER BY created_at DESC LIMIT 1`).get(consultantId, projectId) || null;
}

export function getSupermaiResult(db, consultantId, projectId) {
  return db.prepare(`SELECT status,result_text,error,task_id,started_at,finished_at,
    search_brief,search_round,excluded_candidate_refs_json FROM openmai_results
    WHERE project_id=? AND consultant_id=?`).get(supermaiResultKey(projectId), consultantId) || null;
}

function mappedStatus(task) {
  if (!task) return 'running';
  if (task.status === 'completed') return 'done';
  if (['failed', 'cancelled'].includes(task.status)) return 'failed';
  return task.status;
}

/** 创建可恢复、可幂等的 SuperMai 桌面任务；不读取 TTC 凭证，不调用 OpenMai。 */
export function startSupermaiScoutTask(db, bus, consultantId, criteria, {
  force = false, projectId = null, excludeCandidateRefs = [],
} = {}) {
  const cleanCriteria = String(criteria || '').trim().slice(0, 2000);
  const projectKey = String(projectId || '').trim() || supermaiCriteriaKey(cleanCriteria);
  const resultKey = supermaiResultKey(projectKey);
  const exclusions = normalizeExcludedCandidateRefs(excludeCandidateRefs);
  const existing = db.prepare(`SELECT status,task_id,started_at,finished_at,search_round
    FROM openmai_results WHERE project_id=? AND consultant_id=?`).get(resultKey, consultantId);
  const currentTask = taskStatus(db, existing?.task_id);
  if (!force && existing?.status === 'done') {
    return { status: 'already_done', task_status: 'completed', task_id: existing.task_id,
      finished_at: existing.finished_at };
  }
  if (!force && existing?.status === 'running' && currentTask
      && !['failed', 'cancelled', 'completed', 'partial'].includes(currentTask.status)) {
    return { status: 'running', task_status: currentTask.status, task_id: currentTask.task_id,
      started_at: existing.started_at };
  }
  if (!force && existing?.status === 'failed'
      && Date.now() - Date.parse(existing.started_at || 0) < 60_000) {
    return { status: 'error', task_status: 'failed', task_id: existing.task_id,
      message: '最近一次失败未超过 1 分钟，请处理连接问题后再试' };
  }

  const projectRound = Number(db.prepare(`SELECT COALESCE(MAX(search_round),0) value
    FROM openmai_results WHERE project_id=?`).get(resultKey).value);
  const searchRound = force ? Math.max(1, projectRound + 1) : Number(existing?.search_round || 1);
  const taskId = `sm_${uuid()}`;
  const startedAt = now();
  const device = supermaiDeviceStatus(db, consultantId).active;
  const queuedStatus = device ? 'queued' : 'waiting_for_device';
  const idempotencyKey = createHash('sha256').update([
    consultantId, projectKey, String(searchRound), cleanCriteria, exclusions.join(','),
  ].join('\n')).digest('hex');
  const effectiveCriteria = buildScoutPrompt(cleanCriteria, exclusions);

  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO sourcing_tasks
      (task_id,consultant_id,project_id,provider,criteria,platforms_json,status,
       idempotency_key,created_at,updated_at)
      VALUES (?,?,?,'supermai',?,?,?, ?,?,?)`).run(
      taskId, consultantId, projectKey, effectiveCriteria,
      JSON.stringify(['boss', 'maimai', 'liepin']), queuedStatus,
      idempotencyKey, startedAt, startedAt,
    );
    db.prepare(`INSERT INTO sourcing_task_events
      (task_id,event_type,payload_json,created_at) VALUES (?,?,?,?)`).run(
      taskId, 'created', JSON.stringify({ status: queuedStatus }), startedAt,
    );
    db.prepare(`INSERT INTO openmai_results
      (project_id,consultant_id,status,task_id,started_at,search_brief,search_round,
       excluded_candidate_refs_json)
      VALUES (?,?,'running',?,?,?,?,?)
      ON CONFLICT(project_id,consultant_id) DO UPDATE SET status='running',error=NULL,result_text=NULL,
        task_id=excluded.task_id,started_at=excluded.started_at,finished_at=NULL,
        search_brief=excluded.search_brief,search_round=excluded.search_round,
        excluded_candidate_refs_json=excluded.excluded_candidate_refs_json`).run(
      resultKey, consultantId, taskId, startedAt, cleanCriteria || null,
      searchRound, JSON.stringify(exclusions),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error.message).includes('UNIQUE constraint failed: sourcing_tasks.idempotency_key')) {
      const duplicate = db.prepare(`SELECT task_id,status,started_at,finished_at
        FROM sourcing_tasks WHERE idempotency_key=?`).get(idempotencyKey);
      return { ...duplicate, status: 'running', task_status: mappedStatus(duplicate) };
    }
    throw error;
  }
  bus?.emit?.({ type: 'supermai_task', consultant_id: consultantId,
    project_id: projectKey, task_id: taskId, status: queuedStatus });
  return { status: 'triggered', task_status: queuedStatus, task_id: taskId,
    started_at: startedAt, device_id: device?.device_id || null };
}

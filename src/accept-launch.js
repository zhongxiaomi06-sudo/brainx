/** accept-launch.js — web 接单成功后的副作用编排（specs/011）：触发找人 + 接单直接拉群。 */
import { startOpenmaiTask } from './openmai-task.js';
import { launchProject } from './project-launch.js';

/**
 * 接单（action=ACCEPT 且 state=ACCEPTED）成功后执行：
 * 1. 自动触发 OpenMai 找人（防重/费用控制在任务模块内）；
 * 2. best-effort 创建飞书项目群（launchProject：群主=顾问、成员=项目协作者、机器人管理员），
 *    幂等键 web-accept-launch:<cid>:<job_id>；失败不阻塞接单返回，错误随 project_launch 透出。
 */
export async function postAcceptSideEffects(db, bus, deps, consultantId, projectId, input, out) {
  if (!(out.ok && out.state === 'ACCEPTED' && input?.action === 'ACCEPT')) return out;
  try { out.openmai = startOpenmaiTask(db, bus, consultantId, projectId); }
  catch (e) { out.openmai = { status: 'error', message: String(e.message).slice(0, 200) }; }
  try {
    out.project_launch = await launchProject(db, consultantId, projectId,
      { idempotency_key: `web-accept-launch:${consultantId}:${projectId}` },
      { ...(deps.projectLaunch || {}) });
  } catch (e) {
    out.project_launch = { ok: false, code: e.code || 'PROJECT_LAUNCH_FAILED',
      message: String(e.message).slice(0, 200) };
  }
  return out;
}

/** accept-launch.js — web 接单成功后的副作用编排：接单后直接拉群，找人渠道在群内选择。 */
import { launchRecruitingWorkflow } from './project-launch.js';

/**
 * 接单（action=ACCEPT 且 state=ACCEPTED）成功后执行：
 * best-effort 创建飞书项目群（群主=顾问、成员=项目协作者、机器人管理员），
 *    幂等键 web-accept-launch:<cid>:<job_id>；失败不阻塞接单返回，错误随 project_launch 透出。
 * 找人不在接单时自动触发，避免未选择渠道就消耗付费能力。
 */
export async function postAcceptSideEffects(db, bus, deps, consultantId, projectId, input, out) {
  if (!(out.ok && out.state === 'ACCEPTED' && input?.action === 'ACCEPT')) return out;
  try {
    out.project_launch = await launchRecruitingWorkflow(db, bus, consultantId, projectId,
      { confirm: true, idempotency_key: `web-accept-launch:${consultantId}:${projectId}` },
      { ...(deps.projectLaunch || {}) });
  } catch (e) {
    out.project_launch = { ok: false, code: e.code || 'PROJECT_LAUNCH_FAILED',
      message: String(e.message).slice(0, 200) };
  }
  return out;
}

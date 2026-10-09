/** accept-launch.js — web 接单成功后的副作用编排：建项目群并等待顾问选择找人渠道。 */
import { launchProject } from './project-launch.js';

/**
 * 接单（action=ACCEPT 且 state=ACCEPTED）成功后执行：
 * 1. 标记为等待顾问明确选择 OpenMai 或 SuperMai，不暗中触发付费找人；
 * 2. best-effort 创建飞书项目群（launchProject：群主=顾问、成员=项目协作者、机器人管理员），
 *    幂等键 web-accept-launch:<cid>:<job_id>；失败不阻塞接单返回，错误随 project_launch 透出。
 */
export async function postAcceptSideEffects(db, bus, deps, consultantId, projectId, input, out) {
  if (!(out.ok && out.state === 'ACCEPTED' && input?.action === 'ACCEPT')) return out;
  out.search = {
    status: 'awaiting_method',
    message: '项目群就绪后，请在群内选择 OpenMai 或 SuperMai 开始找人',
  };
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

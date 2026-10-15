/** accept-launch.js — web 接单成功后的副作用编排：建项目群并按 JD 自动触发第一轮找人。
 *
 * 2026-10-15 specs/037：咪指令「建群之后按照 JD 就开始第一轮的找人 不要用户说开始找人
 * 后续能一直长期招人」+「除了 mia 之外的群都实现自动触发」。
 * 建群成功后立即调用 autoSearchOnLaunch 触发按 JD 自动找人；凭证失效自动跳过 + agent 私聊提醒。 */
import { launchProject } from './project-launch.js';
import { autoSearchOnLaunch } from './auto-search.js';

/**
 * 接单（action=ACCEPT 且 state=ACCEPTED）成功后执行：
 * 1. best-effort 创建飞书项目群（launchProject：群主=顾问、成员=项目协作者、机器人管理员），
 *    幂等键 web-accept-launch:<cid>:<job_id>；失败不阻塞接单返回，错误随 project_launch 透出；
 * 2. 建群成功后立即按 JD 自动触发第一轮找人（specs/037 autoSearchOnLaunch）：
 *    跳过 mia 群 + 跳过凭证失效 + 跳过已 done + 失败不阻塞接单返回。
 */
export async function postAcceptSideEffects(db, bus, deps, consultantId, projectId, input, out) {
  if (!(out.ok && out.state === 'ACCEPTED' && input?.action === 'ACCEPT')) return out;
  try {
    out.project_launch = await launchProject(db, consultantId, projectId,
      { idempotency_key: `web-accept-launch:${consultantId}:${projectId}` },
      { ...(deps.projectLaunch || {}) });
  } catch (e) {
    out.project_launch = { ok: false, code: e.code || 'PROJECT_LAUNCH_FAILED',
      message: String(e.message).slice(0, 200) };
    return out;  // 建群失败直接返回，不触发自动找人
  }

  // 建群成功 → 按 JD 自动触发第一轮找人（specs/037）
  if (out.project_launch?.ok !== false && out.project_launch?.chat_id) {
    try {
      out.auto_search = await autoSearchOnLaunch(db, bus, deps, consultantId, projectId, out.project_launch);
    } catch (e) {
      out.auto_search = { ok: false, code: e.code || 'AUTO_SEARCH_FAILED',
        message: String(e.message).slice(0, 200) };
      // 自动触发失败不阻塞接单返回，错误随 out 透出
    }
  }

  return out;
}

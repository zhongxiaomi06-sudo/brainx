/** 飞书推荐卡一键动作：签名链接代替工作台会话，执行忽略或接单建群。 */
import { now } from './db.js';
import { confirmMembership } from './membership.js';
import { launchRecruitingWorkflow } from './project-launch.js';
import { QUICK_ACTIONS, quickResultPage, verifyQuick } from './quickfb.js';
import { recordOpportunityIgnore } from './opportunity-ignore.js';

function sendPage(res, ok, text, status) {
  res.writeHead(ok ? 200 : (status || 400), { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(quickResultPage(ok, text));
}

async function launchFromCard(db, bus, params, dependencies) {
  const membership = confirmMembership(db, params.consultant, params.project, {
    relation: 'MY_JOB',
    idempotency_key: `quick-launch:${params.consultant}:${params.project}:${params.day}:membership`,
  });
  if (!membership.ok) {
    return { ok: false, status: membership.status, text: membership.error || '加入项目失败' };
  }
  try {
    const result = await launchRecruitingWorkflow(db, bus, params.consultant, params.project, {
      confirm: true,
      idempotency_key: `quick-launch:${params.consultant}:${params.project}:${params.day}`,
    }, dependencies);
    return {
      ok: true,
      text: '已接单，项目群已就绪，请返回飞书选择找人方式',
    };
  } catch (error) {
    return { ok: false, status: error.status || 502, text: error.message || '接单建群失败，请稍后重试' };
  }
}

export function quickActionRoute(db, bus, dependencies = {}) {
  return async (req, res, cid, query) => {
    const params = Object.fromEntries(query);
    const verified = verifyQuick(params, now());
    if (!verified.ok) return sendPage(res, false, verified.error, verified.status);
    if (!db.prepare('SELECT 1 FROM job_facts WHERE project_id=?').get(params.project)) {
      return sendPage(res, false, '职位不存在', 404);
    }
    if (params.action === 'launch') {
      const result = await launchFromCard(db, bus, params, dependencies);
      return sendPage(res, result.ok, result.text, result.status);
    }
    const result = recordOpportunityIgnore(db, params.consultant, params.project,
      `quick-ignore:${params.consultant}:${params.project}:${params.day}`);
    if (!result.ok) return sendPage(res, false, result.error || result.message || '操作失败');
    return sendPage(res, true,
      `已记录：${QUICK_ACTIONS[params.action]}${result.already ? '（此前已记录）' : ''}`);
  };
}

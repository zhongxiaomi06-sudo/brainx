/** visibility.js — 职位/消息可见性的唯一权威（server.js 与 mcp/server.mjs 共用，
 * 防止两处过滤逻辑分叉）。
 *
 * 规则（fail-closed）：顾问只能看「与自己有过关系」的职位——
 *   有过 job_memberships 行（含已到期）、或被推荐过、或自己操作过（事件 actor）、
 *   或职位挂载的群 ∈ 顾问所在群（consultant_chats）。
 *   群来源（2026-09-07 接单入口修复）：顾问在项目群/驾驶舱群亲眼见过的职位，
 *   本来就是他已知的事实，允许接单不构成新增泄露面——
 *   否则推荐池只覆盖 1,315/14,494 职位，群里看到的真实岗位接不了（felix 9-06 连续 25 次被拒）。
 * 其余一律 404（不泄露职位存在性）。
 * job_facts 保持全团队单表不动（三向外键 + 回放依赖），过滤只发生在读取层。
 */

export function jobVisibleTo(db, consultant_id, project_id) {
  return !!db.prepare('SELECT 1 FROM job_memberships WHERE consultant_id=? AND project_id=? LIMIT 1')
    .get(consultant_id, project_id)
    || !!db.prepare('SELECT 1 FROM recommendations WHERE consultant_id=? AND project_id=? LIMIT 1')
    .get(consultant_id, project_id)
    || !!db.prepare('SELECT 1 FROM decision_events WHERE actor=? AND project_id=? LIMIT 1')
    .get(consultant_id, project_id)
    // 职位挂载群 ∈ 顾问所在群：先按 project_id 主键定位 chat_id，再查群成员
    || !!db.prepare(`SELECT 1 FROM job_facts jf
        JOIN consultant_chats cc ON cc.chat_id = jf.chat_id
        WHERE jf.project_id = ? AND cc.consultant_id = ? LIMIT 1`)
      .get(project_id, consultant_id);
}

/**
 * 群上下文放行（2026-09-15 用户决策）：调用发生在职位当前绑定的群里时，群成员不另做
 * 职位成员关系校验——飞书事件投递本身已证明发送人在群内，群即信任边界。
 * 仅 agent-gateway 的群内工具调用使用；web/私聊仍走 jobVisibleTo fail-closed。
 */
export function jobAccessibleFromGroup(db, principal, projectId) {
  if (!principal || principal.chatType !== 'group' || !principal.chatId) return false;
  return !!db.prepare('SELECT 1 FROM job_facts WHERE project_id=? AND chat_id=? LIMIT 1')
    .get(projectId, principal.chatId)
    || !!db.prepare(`SELECT 1 FROM project_launches
        WHERE project_id=? AND chat_id=? AND status='READY' LIMIT 1`)
      .get(projectId, principal.chatId);
}

/** 该顾问可见的消息 id 集合（他自己的令牌+群成员身份拉到的）。 */
export function visibleMessageIds(db, consultant_id) {
  return new Set(db.prepare('SELECT message_id FROM job_message_visibility WHERE consultant_id=?')
    .all(consultant_id).map((r) => r.message_id));
}

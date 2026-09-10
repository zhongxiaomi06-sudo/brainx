/** openclaw-group-status.js — 项目群 OpenClaw 准入的状态记账（specs/013）。
 *
 * 准入从「发卡硬前置」降级为 best-effort：失败只把 project_launches 标成
 * PENDING，由 src/openclaw-group-retry.js 后台重放，不再废掉整条拉群链路。
 */
import { now } from './db.js';

const MAX_DETAIL = 240;

/** 把 PersonalModelError 的 cause（OPENCLAW_TIMEOUT / OPENCLAW_COMMAND_FAILED 等）摊平成可落库的一行。 */
export function describeAccessError(error) {
  const code = String(error?.code || error?.name || 'UNKNOWN').slice(0, 80);
  const cause = error?.options?.cause || error?.cause || null;
  const parts = [];
  if (cause?.code) parts.push(String(cause.code));
  if (cause?.exitCode != null) parts.push(`exit=${cause.exitCode}`);
  if (cause?.stderr) {
    const lines = String(cause.stderr).split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length) parts.push(lines[lines.length - 1].slice(0, 120));
  } else if (typeof cause === 'string' && cause) parts.push(cause.slice(0, 120));
  const detail = [code, parts.join(' ')].filter(Boolean).join(': ');
  return detail.slice(0, MAX_DETAIL);
}

/** 执行准入并把结果归一成 { status:'OK'|'PENDING', error }；不抛错。 */
export async function ensureAccessWithStatus(access, chatId, senders) {
  try {
    await access(chatId, senders);
    return { status: 'OK', error: null };
  } catch (error) {
    return { status: 'PENDING', error: describeAccessError(error) };
  }
}

/** 写入准入状态；bumpAttempts 用于补偿重试计数。 */
export function markOpenclawStatus(db, launchId, { status, error = null, bumpAttempts = false }) {
  db.prepare(`UPDATE project_launches SET openclaw_status=?, openclaw_error=?,
    openclaw_attempts=openclaw_attempts+?, openclaw_updated_at=? WHERE launch_id=?`)
    .run(status, error, bumpAttempts ? 1 : 0, now(), launchId);
}

/** 待补偿的行：群已建、链路已 READY、准入未完成。 */
export function pendingOpenclawLaunches(db, limit = 5) {
  return db.prepare(`SELECT launch_id, project_id, chat_id FROM project_launches
    WHERE chat_id IS NOT NULL AND chat_id<>'' AND status='READY' AND openclaw_status='PENDING'
    ORDER BY updated_at LIMIT ?`).all(limit);
}

/** 重放准入所需的成员 open_id：优先复用已登记的群范围，避免重新推导协作者。 */
export function launchSenders(db, chatId) {
  const row = db.prepare(`SELECT allowed_senders_json FROM agent_group_scopes
    WHERE chat_id=? AND scope_status='ACTIVE' ORDER BY updated_at DESC LIMIT 1`).get(chatId);
  try {
    const list = JSON.parse(row?.allowed_senders_json || '[]');
    if (Array.isArray(list)) return list.filter((id) => /^ou_[A-Za-z0-9_-]+$/.test(String(id)));
  } catch { /* 解析失败按空成员处理，准入仍会把群写进白名单 */ }
  return [];
}

/** entity-links.js — Step 0 跨系统身份链接（linkEntities / resolveEntity）。
 *
 * 权威契约: specs/001-step0-event-ledger/spec.md FR-004；
 * case_id 为唯一锚点；任一非空别名被绑定到不同 case 时拒绝（already_linked），
 * 同一 case 的重复链接按 upsert 刷新别名。
 */
import { now } from '../db.js';

const ALIAS_COLS = ['brainx_id', 'talent_pool_id', 'reloop_id', 'lark_open_id'];
const RESOLVE_SQL = `SELECT * FROM entity_links
  WHERE case_id = ? OR brainx_id = ? OR talent_pool_id = ? OR reloop_id = ? OR lark_open_id = ?`;

/** 按 id（任意一侧）解析全链；返回链接行或 null。 */
export function resolveEntity(db, id) {
  return db.prepare(RESOLVE_SQL).get(id, id, id, id, id) ?? null;
}

/** 写入/刷新一组链接。返回 {ok:true} 或 {ok:false, reason:'case_not_found'|'already_linked'}。 */
export function linkEntities(db, { case_id, ...aliases }) {
  const exists = db.prepare('SELECT 1 AS ok FROM cases WHERE case_id = ?').get(case_id);
  if (!exists) return { ok: false, reason: 'case_not_found' };
  for (const col of ALIAS_COLS) {
    const val = aliases[col];
    if (!val) continue;
    const bound = db.prepare(`SELECT case_id FROM entity_links WHERE ${col} = ?`).get(val);
    if (bound && bound.case_id !== case_id) return { ok: false, reason: 'already_linked', column: col };
  }
  db.prepare(`
    INSERT INTO entity_links (case_id, brainx_id, talent_pool_id, reloop_id, lark_open_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_id) DO UPDATE SET
      brainx_id = excluded.brainx_id, talent_pool_id = excluded.talent_pool_id,
      reloop_id = excluded.reloop_id, lark_open_id = excluded.lark_open_id,
      updated_at = excluded.updated_at
  `).run(case_id, aliases.brainx_id ?? null, aliases.talent_pool_id ?? null,
    aliases.reloop_id ?? null, aliases.lark_open_id ?? null, now());
  return { ok: true };
}

/** worker-relay.js — 跨进程 SSE 接力（2026-08-28 进程拆分 A 方案）。
 *
 * 问题：bridge/scheduler 挪到独立 worker 进程后，它们的 bus.emit（sync/recommend/
 * sync_error/openmai_result）到不了 API 进程里的浏览器 SSE 客户端。
 * 方案：worker 把事件写成 worker_events 表行（SQLite 同库即 IPC，WAL 多进程安全），
 * API 进程起一个轻量泵（3s 一次 `WHERE id > ?`）复读给 server.bus。
 * 表只进不出会膨胀：泵每轮顺手删 1h 前的行。
 */
import { now } from './db.js';

export function ensureRelayTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    consultant_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL)`);
}

/** worker 侧：与 server.bus 同形的 emit，写库即广播。 */
export function relayBus(db) {
  ensureRelayTable(db);
  const ins = db.prepare(`INSERT INTO worker_events (type, consultant_id, payload_json, created_at)
    VALUES (?,?,?,?)`);
  return { emit(obj) {
    try {
      ins.run(String(obj?.type || 'unknown'), obj?.consultant_id || null, JSON.stringify(obj || {}), now());
    } catch { /* relay 失败不拖垮批处理 */ }
  } };
}

/** API 侧：把 worker 写入的事件泵进本进程 bus。返回 { stop }。 */
export function startRelayPump(db, bus, { intervalMs = 3000 } = {}) {
  ensureRelayTable(db);
  const page = db.prepare(`SELECT id, type, consultant_id, payload_json FROM worker_events
    WHERE id > ? ORDER BY id LIMIT 200`);
  // 与 now() 的 ISO(T) 格式对齐：datetime() 出空格分隔，'T'>' ' 会让删除永远匹配 0 行（实测）
  const gc = db.prepare(`DELETE FROM worker_events
    WHERE created_at < strftime('%Y-%m-%dT%H:%M:%S', 'now', '-1 hour')`);
  let lastId = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM worker_events').get().m;
  // 启动时不回放历史（只播新事件），避免重启后轰炸浏览器
  const tick = () => {
    try {
      for (const row of page.all(lastId)) {
        lastId = row.id;
        try { bus?.emit({ ...JSON.parse(row.payload_json), type: row.type,
                        consultant_id: row.consultant_id || undefined }); }
        catch { /* 单行坏载荷不阻塞后续 */ }
      }
      gc.run();
    } catch { /* DB 瞬时下轮再试 */ }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}

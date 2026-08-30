/** snapshot.js — 职位快照接口（供外部系统消费，替代直打 CRM job/search）。
 *
 * 设计意图：York AI 团队的 9 个 worker 每 3 小时打 3163 次 CRM job/search，
 * 每次触发小麦 N+1 跨云调用。本模块暴露 BrainX 已同步的职位快照——数据来自
 * bridge 每 3 分钟合并去重后的结果，外部系统读快照即可，零跨云开销。
 *
 * 安全：API Key 鉴权（BRAINX_SNAPSHOT_API_KEY），不走 session cookie。
 * key 惰性读取（每次请求时）——启动后再配 env 也生效，测试注入也不受 import 时序影响；
 * 未配置时 verifySnapshotKey 恒为 false（fail-closed，一律 401）。
 * 数据范围：全量 job_facts（脱敏后），不含关系/承接/推荐等内部运营数据。
 */
import { now } from './db.js';

const apiKey = () => process.env.BRAINX_SNAPSHOT_API_KEY || '';

export function verifySnapshotKey(req) {
  const key = apiKey();
  if (!key) return false;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return bearer === key;
}

/** 快照查询。
 * updated_after / updated_before 过滤 captured_at（= 事实最后变化时间，见 sync.js
 * 的 upsert CASE——只有事实字段变化才前进，不是"最后同步时间"）；
 * status 过滤 active_state；limit 只截返回行数。
 * total_count = 匹配过滤条件的全量条数（limit 不影响计数），调用方据此判断
 * 是否拉完 / 是否需要增量——与 CRM export 提案的 total_count 语义一致。 */
export function jobSnapshot(db, { updated_after, updated_before, status, limit } = {}) {
  const where = [];
  const params = [];
  if (updated_after) { where.push('captured_at >= ?'); params.push(updated_after); }
  if (updated_before) { where.push('captured_at <= ?'); params.push(updated_before); }
  if (status) { where.push('active_state = ?'); params.push(status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const cols = `project_id, company, role, city, pipeline, hc,
    active_state, priority, company_type, source_url, captured_at, owner_name`;
  const lim = limit && Number(limit) > 0 ? ` LIMIT ${Number(limit)}` : '';
  const jobs = db.prepare(`SELECT ${cols} FROM job_facts${w} ORDER BY captured_at DESC${lim}`).all(...params);
  const total_count = db.prepare(`SELECT COUNT(*) AS c FROM job_facts${w}`).get(...params)?.c || 0;
  const meta = db.prepare('SELECT MAX(captured_at) as last_sync FROM job_facts').get();

  return {
    total: jobs.length,
    total_count,
    last_sync_at: meta?.last_sync || null,
    served_at: now(),
    jobs,
  };
}

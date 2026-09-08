/** supermai-sourcing.js — SuperMai 找人入口（按判据自由找人，猎聘/脉脉渠道）。
 *
 * 2026-09-08 纠正（用户拍板）：SuperMai 找人的真实形态 = 在猎聘、脉脉上找人，
 * 不在 TTC。09-07 按前端 chunk 接的 app.ttcadvisory.com/app/sourcing/api/sourcing/v1
 * web 检索后端是错误对象（实测 /auth/* 200 在线、/sessions 与 /chat/* 持续 404），
 * 全部移除（specs/007）。
 *
 * 两入口统一走 OpenMai 引擎（specs/007-dual-sourcing-entries）：
 *   入口 1 brainx_openmai_search（按职位，openmai-task.js，带 CRM job_id）
 *   入口 2 brainx_supermai_scout（按判据，本模块，completions 无 job_id 模式——
 *          2026-09-08 18:12 最小付费实测 200 可用）
 *
 * 任务落库复用 openmai_results（project_id = supermai:<sha256(criteria) 前 12 位>）。
 * 合成 key 匹配不到 project_launches → enqueueOpenmaiDeliveries 的 JOIN 天然不命中，
 * 不会触发项目群投递副作用。防重纪律与 job 模式一致：running 集合 + DB 主键防并发
 * 重入；done 复用（already_done）；失败 60s 冷却；无凭证快速失败。
 */
import { createHash } from 'node:crypto';
import { now, uuid } from './db.js';
import { getValidTtcJwt } from './ttcsdk/auth.js';
import { callOpenmaiContent, settleOpenmaiTask as settleSupermaiTask } from './openmai-task.js';

const running = new Set(); // `${key}|${consultant_id}`

/** 判据 → openmai_results 合成主键（同判据复用结果，改判据即新任务）。 */
export function supermaiCriteriaKey(criteria) {
  const text = String(criteria || '').trim();
  return `supermai:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

/** criteria 模式提示词：与 job 模式（openmai-task.js#buildPrompt）同一产物格式，
 * 渠道表述为猎聘、脉脉（SuperMai 找人的真实承载）。 */
export function buildScoutPrompt(criteria) {
  return [
    '请使用 SuperMai 找人能力在猎聘、脉脉等候选人渠道，搜索以下判据的 6-10 名匹配候选人：',
    `[找人判据] ${String(criteria || '').trim()}`,
    '每人必须给出姓名、当前公司/职位、匹配判断、推荐理由、风险或待核实项；没有证据的字段写“待核实”。',
    '如果系统能取得候选人的真实 PDF，请提供可直接下载的 HTTPS 地址；不能取得时 resume_url 必须为 null，不得编造链接。',
    '在面向人的结果末尾追加下面格式的机器块，JSON 必须合法，且不要把电话或邮箱放入机器块：',
    '<!-- BRAINX_CANDIDATES_V1',
    '{"candidates":[{"candidate_ref":"稳定候选编号","name":"姓名","evaluation":"一句话评估","resume_url":"https://受信地址/真实简历.pdf或null"}]}',
    '-->',
  ].join('\n');
}

/** 启动 SuperMai 按判据找人任务（触发/读取两段式的触发侧）。
 * 返回 { status: triggered|running|already_done|error, ... }，语义与 startOpenmaiTask 一致。 */
export function startSupermaiScoutTask(db, bus, consultant_id, criteria, { force = false } = {}) {
  const project_id = supermaiCriteriaKey(criteria);
  const key = `${project_id}|${consultant_id}`;
  const existing = db.prepare('SELECT status, started_at, finished_at FROM openmai_results WHERE project_id=? AND consultant_id=?')
    .get(project_id, consultant_id);
  if (running.has(key)) return { status: 'running', started_at: existing?.started_at };
  if (!force && existing?.status === 'done')
    return { status: 'already_done', finished_at: existing.finished_at };
  if (!force && existing?.status === 'failed' && Date.now() - Date.parse(existing.started_at || 0) < 60_000)
    return { status: 'error', message: '最近一次失败未超过 1 分钟，稍后再试或调整判据重试' };

  const jwt = getValidTtcJwt(db, consultant_id);
  if (!jwt) {
    const t = now();
    db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, error, started_at, finished_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(project_id, consultant_id) DO UPDATE SET status='failed', error=excluded.error,
        started_at=excluded.started_at, finished_at=excluded.finished_at`)
      .run(project_id, consultant_id, 'failed', '没有有效 TTC 凭证——请用浏览器扩展扫码同步', t, t);
    bus?.emit?.({ type: 'supermai_result', consultant_id, project_id, status: 'failed' });
    return { status: 'error', message: '没有有效 TTC 凭证——请用浏览器扩展扫码同步' };
  }

  const task_id = `sm_${uuid().slice(0, 8)}`;
  const started_at = now();
  running.add(key);
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, task_id, started_at)
    VALUES (?,?, 'running', ?, ?)
    ON CONFLICT(project_id, consultant_id) DO UPDATE SET status='running', error=NULL, result_text=NULL,
      task_id=excluded.task_id, started_at=excluded.started_at, finished_at=NULL`)
    .run(project_id, consultant_id, task_id, started_at);

  (async () => {
    let status = 'failed';
    let settled = false;
    try {
      const result = await callOpenmaiContent(jwt, buildScoutPrompt(criteria));
      settled = settleSupermaiTask(db, { projectId: project_id, consultantId: consultant_id,
        taskId: task_id, status: 'done', resultText: result });
      status = 'done';
    } catch (e) {
      settled = settleSupermaiTask(db, { projectId: project_id, consultantId: consultant_id,
        taskId: task_id, status: 'failed', error: e.message });
    } finally {
      running.delete(key);
      if (settled) bus?.emit?.({ type: 'supermai_result', consultant_id, project_id, status });
    }
  })();

  return { status: 'triggered', task_id, started_at };
}

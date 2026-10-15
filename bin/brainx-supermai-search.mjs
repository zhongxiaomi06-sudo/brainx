#!/usr/bin/env node
/**
 * brainx-supermai-search.mjs — 正式 SuperMai 找人 CLI 工具（生产级）。
 *
 * 直连 callOpenmaiContent（不走 startSupermaiScoutTask 的 fire-and-forget），
 * 复用全部生产函数：落库（settleOpenmaiTask）+ 质量评估（assessOpenmaiCandidateBatch）
 * + 污染检测（looksLikeSessionPollution）+ 事件发送（emitEvent）+ 凭证（getAuthorizedTtcJwt）。
 *
 * 解决 startSupermaiScoutTask fire-and-forget + 短命进程导致任务永远 running 的设计坑：
 * 脚本 await callOpenmaiContent 到结果回来才退出，IIFE 不会死。
 *
 * 事件链路（与生产一致）：
 *   INSERT running → emitEvent sourcing.search_started
 *   → await callOpenmaiContent
 *   → settleOpenmaiTask（内部 emitSearchFinished sourcing.search_finished + UPDATE done/failed）
 *
 * 用法（brainx 用户，cwd=/opt/brainx）：
 *   /usr/bin/node bin/brainx-supermai-search.mjs --consultant mia --criteria "判据文本"
 *   /usr/bin/node bin/brainx-supermai-search.mjs                # 默认 mia + FA 女生优先
 *   /usr/bin/node bin/brainx-supermai-search.mjs --help          # 帮助
 *
 * 结果落 openmai_results（project_id = supermaiCriteriaKey(criteria)），可查询历史。
 * bus.emit 空实现——脚本无前端连接，群投递由 worker/前端 bus 订阅者负责。
 */
import { openDb, now, uuid } from '../src/db.js';
import { callOpenmaiContent, settleOpenmaiTask } from '../src/openmai-task.js';
import { buildScoutPrompt, supermaiCriteriaKey } from '../src/supermai-sourcing.js';
import { getAuthorizedTtcJwt } from '../src/ttcsdk/auth.js';
import { assessOpenmaiCandidateBatch, looksLikeSessionPollution } from '../src/openmai-result.js';
import { emitEvent } from '../src/hub/emit.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`brainx-supermai-search — SuperMai 找人 CLI 工具

用法:
  node bin/brainx-supermai-search.mjs [选项]

选项:
  --consultant <id>     顾问 ID（默认 mia）
  --criteria <text>     找人判据（默认 FA 机构 + 清北 + 女生优先）
  --project-id <PID>    真实项目 ID（传了才能投递回项目群，默认用合成键）
  --help, -h            显示帮助

示例:
  node bin/brainx-supermai-search.mjs
  node bin/brainx-supermai-search.mjs --consultant felix --criteria "AI产品经理，3年经验，北京"
  node bin/brainx-supermai-search.mjs --criteria "后端工程师，Python，5年经验，优先北京"
  node bin/brainx-supermai-search.mjs --consultant wendy --project-id JCDWDEP --criteria "..."

结果落 openmai_results。
project_id：传 --project-id 用真实项目 ID（**完成后 worker 能投递回原群**）；
            否则 supermai:<sha256(criteria)前12位> 合成键（自由找人，不投递——
            设计如此，见 supermai-sourcing.js 头部注释）。
gender 约束已内建（buildScoutPrompt 含提示词约束行）。`);
  process.exit(0);
}

let consultant_id = 'mia';
let criteria = '3年以内经验，清华或北大，FA机构背景（光源资本、义柏资本、义凯资本、云岫资本、IO Investment），女生优先';
let projectIdArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--consultant' && args[i + 1]) consultant_id = args[++i];
  else if (args[i] === '--criteria' && args[i + 1]) criteria = args[++i];
  else if (args[i] === '--project-id' && args[i + 1]) projectIdArg = args[++i];
}

const DB_PATH = process.env.BRAINX_DB || '/opt/brainx/data/brainx.db';
const db = openDb(DB_PATH);
const bus = { emit: () => {} };

// 传 --project-id 用真实项目 ID（投递回群的前提）；否则合成键（自由找人，不投递）。
// 与 supermai-sourcing.js:59 同款逻辑——合成键会让 enqueueOpenmaiDeliveries 的
// INNER JOIN project_launches 匹配不上，结果推不回群（2026-10-15 审查实证）。
const project_id = String(projectIdArg || '').trim() || supermaiCriteriaKey(criteria);
const task_id = `sm_${uuid().slice(0, 8)}`;
const started_at = now();
const searchRound = 1;

console.log(`[${new Date().toISOString()}] start supermai search`);
console.log(`consultant=${consultant_id} project_id=${project_id} task_id=${task_id}`);
console.log(`criteria: ${criteria}`);

const jwt = getAuthorizedTtcJwt(db, consultant_id, 'OPENMAI');
if (!jwt) {
  console.error('NO JWT — 顾问无有效 TTC 凭证，请用浏览器扩展扫码同步');
  db.close();
  process.exit(1);
}
console.log('JWT OK');

db.prepare(`INSERT INTO openmai_results
  (project_id, consultant_id, status, task_id, started_at, search_brief, search_round, excluded_candidate_refs_json)
  VALUES (?, ?, 'running', ?, ?, ?, ?, '[]')
  ON CONFLICT(project_id, consultant_id) DO UPDATE SET status='running', error=NULL, result_text=NULL,
    task_id=excluded.task_id, started_at=excluded.started_at, finished_at=NULL,
    search_brief=excluded.search_brief, search_round=excluded.search_round,
    excluded_candidate_refs_json=excluded.excluded_candidate_refs_json`)
  .run(project_id, consultant_id, task_id, started_at, criteria.slice(0, 2000), searchRound);
console.log('INSERT running OK — openmai_results 可见');

emitEvent(db, {
  event_type: 'sourcing.search_started',
  idem_key: `sourcing.started:${project_id}:${task_id}`,
  actor: 'cli:brainx-supermai-search',
  payload: { project_id, channel: 'supermai', round: searchRound },
  evidence_refs: [{ table: 'openmai_results', id: `${project_id}|${consultant_id}` }],
});
console.log('emitEvent sourcing.search_started OK');

const t0 = Date.now();
let status = 'failed';
let settled = false;
try {
  const result = await callOpenmaiContent(jwt, buildScoutPrompt(criteria, []));
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n[${new Date().toISOString()}] callOpenmaiContent DONE in ${elapsed}s, len=${result.length}`);

  if (looksLikeSessionPollution(result)) {
    throw new Error('OpenMai 会话上下文污染：返回与找人无关的内容');
  }
  const batchQuality = assessOpenmaiCandidateBatch(result);
  const resultStatus = batchQuality.needsInput ? 'needs_input' : 'done';

  settled = settleOpenmaiTask(db, {
    projectId: project_id, consultantId: consultant_id, taskId: task_id,
    status: resultStatus, resultText: result, channel: 'supermai', resultCount: batchQuality.count,
  });
  status = resultStatus;
  // settleOpenmaiTask 内部已 emitSearchFinished（sourcing.search_finished）

  console.log(`settleOpenmaiTask OK: status=${resultStatus} count=${batchQuality.count} needsInput=${batchQuality.needsInput} settled=${settled}`);
  console.log('--- RESULT ---');
  console.log(result);
  console.log('--- END RESULT ---');

  const hasGenderError = /cannot unmarshal array into Go struct field.*gender/i.test(result);
  console.log(`\n=== 判定 ===`);
  console.log(`gender 错误再现: ${hasGenderError ? '是 ❌（提示词约束无效）' : '否 ✅'}`);
  console.log(`候选人数量: ${batchQuality.count}`);
  if (hasGenderError) {
    console.log('结论: gender 提示词约束无效，需向 TTC 报障');
  } else if (batchQuality.count > 0) {
    console.log('结论: gender 约束生效，返回真实候选人 ✅');
  } else {
    console.log('结论: gender 错误未再现但零候选人，可能是其他原因');
  }
} catch (e) {
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.error(`\n[${new Date().toISOString()}] FAILED in ${elapsed}s: ${e.message}`);
  settled = settleOpenmaiTask(db, {
    projectId: project_id, consultantId: consultant_id, taskId: task_id,
    status: 'failed', error: e.message, channel: 'supermai',
  });
} finally {
  if (settled) bus.emit?.({ type: 'supermai_result', consultant_id, project_id, status });
}

db.close();
console.log(`[${new Date().toISOString()}] done, status=${status}, project_id=${project_id}`);
console.log(`查询结果: sqlite3 ${DB_PATH} "SELECT status, length(result_text) FROM openmai_results WHERE task_id='${task_id}';"`);

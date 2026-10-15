#!/usr/bin/env node
/**
 * brainx-auto-search-retrofill.mjs — 存量项目群按 JD 自动触发第一轮找人回填脚本（specs/037）。
 *
 * 咪 2026-10-15 指令：「除了 mia 之外的群都实现自动触发」。
 *
 * 关键设计：spawn brainx-supermai-search.mjs 子进程（await callOpenmaiContent 直连），
 * 而非直接调 startSupermaiScoutTask（fire-and-forget + 短命进程 IIFE 坑）。
 * 每个群串行跑（避免引擎并发），等待子进程完成再继续下一个。
 *
 * 用法（brainx 用户，cwd=/opt/brainx，nohup 后台跑）：
 *   nohup /usr/bin/node bin/brainx-auto-search-retrofill.mjs > /tmp/retrofill.log 2>&1 &
 *   nohup /usr/bin/node bin/brainx-auto-search-retrofill.mjs --dry-run > /tmp/retrofill.log 2>&1 &
 *   nohup /usr/bin/node bin/brainx-auto-search-retrofill.mjs --limit 3 > /tmp/retrofill.log 2>&1 &
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import { buildAutoSearchCriteria, listRetrofillCandidates, notifyCredentialExpired } from '../src/auto-search.js';
import { supermaiCriteriaKey } from '../src/supermai-sourcing.js';
import { getAuthorizedTtcJwt } from '../src/ttcsdk/auth.js';

// 自动加载 /etc/brainx/openclaw.env（飞书 IM 凭据）—— brainx 用户手动跑无 systemd 不会自动加载
const ENV_FILE = '/etc/brainx/openclaw.env';
if (existsSync(ENV_FILE)) {
  const content = readFileSync(ENV_FILE, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  }
  console.log('[env] loaded /etc/brainx/openclaw.env');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 && args[limitArg + 1] ? parseInt(args[limitArg + 1], 10) : 0;
const consultantArg = args.indexOf('--consultant');
const filterConsultant = consultantArg >= 0 && args[consultantArg + 1] ? args[consultantArg + 1] : null;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`brainx-auto-search-retrofill — 存量项目群自动触发第一轮找人回填（specs/037）

用法:
  nohup /usr/bin/node bin/brainx-auto-search-retrofill.mjs [选项] > /tmp/retrofill.log 2>&1 &

选项:
  --dry-run             只列候选群，不实际触发
  --limit N             最多跑 N 个群
  --consultant <id>     只跑某顾问的群
  --help, -h            显示帮助

跳过条件:
  1. consultant_id='mia'（咪拍板除 mia 外都触发）
  2. BRAINX_AUTO_SEARCH_ENABLED=0 全局开关
  3. auto_search_enabled=0 项目级开关
  4. ttc_tokens.needs_reauth=1 或已过期 → 跳过 + 私聊提醒
  5. 已有 search_round=1 done → already_done 复用

每个群 spawn brainx-supermai-search.mjs 子进程（await callOpenmaiContent 直连），
等子进程完成（~165s）再继续下一个。`);
  process.exit(0);
}

const DB_PATH = process.env.BRAINX_DB || '/opt/brainx/data/brainx.db';
const db = openDb(DB_PATH);

console.log(`[${new Date().toISOString()}] retrofill 启动${dryRun ? ' (DRY-RUN)' : ''}`);
console.log(`DB: ${DB_PATH}`);
if (process.env.BRAINX_AUTO_SEARCH_ENABLED === '0') {
  console.log('全局开关 BRAINX_AUTO_SEARCH_ENABLED=0，跳过全部');
  db.close();
  process.exit(0);
}

let candidates = listRetrofillCandidates(db);
console.log(`候选群总数（非 mia READY search_status NULL）：${candidates.length}`);

if (filterConsultant) {
  candidates = candidates.filter(c => c.consultant_id === filterConsultant);
  console.log(`过滤 consultant_id=${filterConsultant}：剩余 ${candidates.length}`);
}
if (limit > 0 && candidates.length > limit) {
  candidates = candidates.slice(0, limit);
  console.log(`--limit ${limit}：实际跑 ${candidates.length}`);
}

console.log('\n=== 候选群清单 ===');
candidates.forEach((c, i) => {
  console.log(`#${i + 1} | proj=${c.project_id} | consultant=${c.consultant_id} | chat=${(c.chat_id || 'NULL').substring(0, 24)} | company=${c.company} | role=${c.role}`);
});

if (dryRun) {
  console.log('\n[DRY-RUN] 不实际触发');
  db.close();
  process.exit(0);
}

// 子进程 spawn 函数
function spawnSearchChild(consultantId, criteria) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/node', [
      '/opt/brainx/bin/brainx-supermai-search.mjs',
      '--consultant', consultantId,
      '--criteria', criteria,
    ], { cwd: '/opt/brainx', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout: stdout.slice(0, 800), stderr: stderr.slice(0, 800) }));
    child.on('error', err => resolve({ code: -1, error: String(err.message).slice(0, 200) }));
  });
}

const results = { triggered: 0, already_done: 0, no_jwt: 0, no_job: 0, no_criteria: 0, error: 0, jwt_notified: [] };

console.log('\n=== 开始触发（每个群约 165s）===');
for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i];
  console.log(`\n[${new Date().toISOString()}] #${i + 1}/${candidates.length} ${c.project_id} (${c.consultant_id})`);

  // 凭证校验（fail-fast）
  const jwt = getAuthorizedTtcJwt(db, c.consultant_id, 'OPENMAI');
  if (!jwt) {
    console.log(`  SKIP no_jwt: 凭证失效 → 私聊提醒`);
    const r = await notifyCredentialExpired(db, c.consultant_id, [c.project_id]);
    results.no_jwt += 1;
    if (r.status === 'notified') results.jwt_notified.push(c.consultant_id);
    continue;
  }

  // 判据生成
  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(c.project_id);
  if (!job) {
    console.log(`  SKIP no_job`);
    results.no_job += 1;
    continue;
  }
  const criteria = buildAutoSearchCriteria(job);
  if (!criteria) {
    console.log(`  SKIP no_criteria`);
    results.no_criteria += 1;
    continue;
  }

  // 已 done 复用（用 supermaiCriteriaKey 查，避免重复付费触发）
  const supermaiProjectId = supermaiCriteriaKey(criteria);
  const existing = db.prepare(`SELECT task_id, status FROM openmai_results
    WHERE project_id=? AND consultant_id=? AND search_round=1`).get(supermaiProjectId, c.consultant_id);
  if (existing?.status === 'done') {
    console.log(`  SKIP already_done task=${existing.task_id} (project=${supermaiProjectId})`);
    results.already_done += 1;
    continue;
  }

  console.log(`  criteria: ${criteria.slice(0, 200)}`);
  console.log(`  spawn brainx-supermai-search.mjs ...`);
  const t0 = Date.now();
  const r = await spawnSearchChild(c.consultant_id, criteria);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (r.code === 0) {
    results.triggered += 1;
    // 从 stdout 提取 task_id
    const m = r.stdout.match(/task_id=sm_[a-f0-9]+/);
    console.log(`  OK done in ${elapsed}s ${m ? m[0] : ''}`);
  } else {
    results.error += 1;
    console.log(`  ERROR code=${r.code} in ${elapsed}s`);
    if (r.stderr) console.log(`  stderr: ${r.stderr.slice(0, 300)}`);
  }
}

console.log(`\n=== 汇总 ===`);
console.log(`触发成功 triggered: ${results.triggered}`);
console.log(`已 done 复用 already_done: ${results.already_done}`);
console.log(`凭证失效跳过 no_jwt: ${results.no_jwt}（已私聊提醒 ${results.jwt_notified.length} 位顾问）`);
console.log(`无职位 no_job: ${results.no_job}`);
console.log(`无判据 no_criteria: ${results.no_criteria}`);
console.log(`异常 error: ${results.error}`);
if (results.jwt_notified.length) {
  console.log(`凭证提醒顾问：${results.jwt_notified.join(', ')}`);
}

db.close();
console.log(`\n[${new Date().toISOString()}] retrofill 完成`);

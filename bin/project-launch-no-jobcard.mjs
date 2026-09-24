#!/usr/bin/env node
/** 运维脚本：新职位建群（跳过接单卡）+ 找人发卡链路。
 * Phase1 建职位(job_facts+sync_runs+membership) → Phase2 建群(跳过接单卡,message_id=NULL)
 * → Phase3 找人(startOpenmaiTask,内部读JWT,需linda凭证) → Phase4 发结果卡(buildOpenmaiDeliveryCard)
 * 用法:
 *   建群:  node --env-file=/etc/brainx/feishu-bot.env bin/project-launch-no-jobcard.mjs --phase=setup --project=JC3V82F --consultant=linda --jd-file=/tmp/jd.txt
 *   找人发卡: 同上 --phase=search (需 linda 已粘贴 TTC JWT)
 */
import { openDb } from '../src/db.js';
import { createProjectChat, sendInteractiveCard, getTenantAccessToken } from '../src/feishu-bot.js';
import { startOpenmaiTask } from '../src/openmai-task.js';
import { buildOpenmaiDeliveryCard } from '../src/openmai-delivery.js';
import { productionBaseUrl } from '../src/brainx-deep-links.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.slice(2), true];
}));
const PHASE = args.phase || 'setup';
const PROJECT = args.project;
const CONSULTANT = args.consultant;
const COMPANY = args.company || '恒星力量';
const ROLE = args.role || '战略研究';
const CITY = args.city || '北京';
if (!PROJECT || !CONSULTANT) {
  console.error('用法: --phase=setup|search --project=JC3V82F --consultant=linda [--company --role --city --jd-file]');
  process.exit(1);
}

const db = openDb('data/brainx.db');
const now = () => new Date().toISOString();
const log = (tool, status, detail) => {
  console.log(`[${new Date().toISOString()}] [${status}] ${tool}: ${detail}`);
  try {
    db.prepare(`INSERT INTO agent_runs (run_id,request_id,tenant_id,consultant_id,channel,account_id,chat_type,sender_hash,chat_id_hash,purpose,tool_name,status,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), `manual:${PROJECT}:${tool}:${Date.now()}`, 'yorkteam', CONSULTANT, 'script', 'mia', 'group', 'manual', 'manual', 'project_launch', tool, status, now());
  } catch (e) { /* agent_runs 约束宽松记录，失败不阻塞主链路 */ }
};

if (PHASE === 'setup') {
  // Phase1 建职位（幂等：job_facts 已存在则跳过，用现有 company/role）
  const ts = now();
  const existing = db.prepare('SELECT company,role FROM job_facts WHERE project_id=?').get(PROJECT);
  let company, role;
  if (existing) {
    company = existing.company; role = existing.role;
    log('build_job', 'SUCCEEDED', `job_facts ${PROJECT} 已存在(${company}-${role}) 跳过INSERT`);
  } else {
    const syncId = randomUUID();
    db.prepare(`INSERT INTO sync_runs (sync_id,consultant_id,source,as_of,input_hash,started_at,completed_at,complete) VALUES (?,?,?,?,?,?,?,1)`)
      .run(syncId, CONSULTANT, 'fixture', ts, `manual:${PROJECT}`, ts, ts);
    company = COMPANY; role = ROLE;
    const jdText = args.jdFile ? readFileSync(args.jdFile, 'utf8') : (args.jd || '');
    db.prepare(`INSERT INTO job_facts (project_id,company,role,city,active_state,captured_at,sync_id,raw_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(PROJECT, company, role, CITY, 'OPEN', ts, syncId, JSON.stringify({ jd: jdText }), ts);
    log('build_job', 'SUCCEEDED', `新建 job_facts ${PROJECT}(${company}-${role})`);
  }
  db.prepare(`INSERT OR IGNORE INTO job_memberships (consultant_id,project_id,relation,source,valid_from) VALUES (?,?,?,?,?)`)
    .run(CONSULTANT, PROJECT, 'MY_JOB', 'MANUAL_CONFIRMATION', ts);

  // Phase2 建群（跳过接单卡）
  const owner = db.prepare('SELECT open_id FROM consultants WHERE consultant_id=?').get(CONSULTANT);
  const mia = db.prepare('SELECT open_id FROM consultants WHERE consultant_id=?').get('mia');
  if (!owner?.open_id) throw new Error('CONSULTANT_OPEN_ID_MISSING');
  const created = await createProjectChat({
    name: `${company}-${role}`,
    description: `BrainTex 职位项目 ${PROJECT}`,
    ownerOpenId: owner.open_id,
    memberOpenIds: mia?.open_id ? [mia.open_id] : [],
    idempotencyKey: `manual:no-jobcard:${PROJECT}:${CONSULTANT}:${Date.now()}`,
    appId: process.env.BRAINX_FEISHU_APP_ID,
    appSecret: process.env.BRAINX_FEISHU_APP_SECRET,
  });
  const chatId = created.chat_id;
  const launchId = randomUUID();
  db.prepare(`INSERT INTO project_launches (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,chat_name,created_at,updated_at,openclaw_status,openclaw_attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(launchId, CONSULTANT, PROJECT, `manual:no-jobcard:${PROJECT}:${CONSULTANT}`, 'READY', 'READY', chatId, created.name, ts, now(), 'PENDING');
  db.prepare(`UPDATE job_facts SET chat_id=?, updated_at=? WHERE project_id=?`).run(chatId, now(), PROJECT);
  log('create_chat', 'SUCCEEDED', `群 ${chatId} owner=${CONSULTANT} 跳过接单卡 message_id=NULL openclaw=PENDING`);
  console.log(JSON.stringify({ ok: true, phase: 'setup', project: PROJECT, consultant: CONSULTANT, chat_id: chatId, chat_name: created.name, launch_id: launchId, next: '等 linda 粘贴 TTC JWT 后跑 --phase=search' }));
  db.close();
} else if (PHASE === 'search') {
  // Phase3 找人（startOpenmaiTask 内部读 getAuthorizedTtcJwt，没凭证会写 failed）
  const jdRow = db.prepare('SELECT raw_json FROM job_facts WHERE project_id=?').get(PROJECT);
  const brief = jdRow ? (JSON.parse(jdRow.raw_json).jd || '').slice(0, 2000) : '';
  const launch = db.prepare("SELECT chat_id,chat_name FROM project_launches WHERE project_id=? AND status='READY'").get(PROJECT);
  if (!launch?.chat_id) throw new Error('PROJECT_CHAT_NOT_READY 先跑 --phase=setup');
  const result = startOpenmaiTask(db, null, CONSULTANT, PROJECT, { searchBrief: brief, force: true });
  log('openmai_search', result.status === 'error' ? 'FAILED' : 'SUCCEEDED', JSON.stringify(result));
  if (result.status === 'error') {
    console.log(JSON.stringify({ ok: false, phase: 'search', error: result.message || 'no jwt', next: 'linda 需粘贴 TTC JWT 或授权共享凭证' }));
    db.close(); process.exit(2);
  }
  // 轮询 openmai_results done（startOpenmaiTask 异步，最多等 6 分钟）
  let row = null;
  for (let i = 0; i < 72; i++) {
    row = db.prepare("SELECT status,result_text,error,search_round FROM openmai_results WHERE project_id=? AND consultant_id=?").get(PROJECT, CONSULTANT);
    if (row?.status === 'done' || row?.status === 'failed') break;
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!row || row.status !== 'done') {
    console.log(JSON.stringify({ ok: false, phase: 'search', status: row?.status, error: row?.error }));
    db.close(); process.exit(3);
  }
  // Phase4 发结果卡到新群
  const job = db.prepare('SELECT project_id,company,role,chat_id FROM job_facts WHERE project_id=?').get(PROJECT);
  const card = buildOpenmaiDeliveryCard({ job, status: 'done', resultText: row.result_text, publicBaseUrl: productionBaseUrl() });
  const token = await getTenantAccessToken({ appId: process.env.BRAINX_FEISHU_APP_ID, appSecret: process.env.BRAINX_FEISHU_APP_SECRET });
  const sent = await sendInteractiveCard({ target: launch.chat_id, card, idempotencyKey: `${PROJECT}-search-${row.search_round}-${Date.now()}`, appId: process.env.BRAINX_FEISHU_APP_ID, appSecret: process.env.BRAINX_FEISHU_APP_SECRET });
  log('deliver_card', 'SUCCEEDED', `round=${row.search_round} message_id=${sent?.message_id} chat=${launch.chat_id}`);
  console.log(JSON.stringify({ ok: true, phase: 'search', project: PROJECT, round: row.search_round, message_id: sent?.message_id, chat_id: launch.chat_id }));
  db.close();
}

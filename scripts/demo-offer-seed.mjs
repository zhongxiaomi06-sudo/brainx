#!/usr/bin/env node
/** demo-offer-seed — Offer 谈判演示数据灌入 CLI（数据来自 fixtures/demo-offer-candidates.json，全为虚构演示数据）。
 *
 * 子命令：
 *   seed --db <path> --tenant <t> --account <a> [--source-chat <ref>=<oc_...>]...
 *       灌入身份绑定、项目成员、READY launch、候选人重点名单（含快照）、来源群讨论消息。
 *       幂等；已存在真实 launch 的项目会跳过并告警，绝不覆盖。
 *   seed-offer-msg --db <path> --chat <oc_...> --ref <candidate_ref>
 *       决策群建成后，把该候选人的「电话纪要」消息灌进新群 chat_id，
 *       供 brainx_candidate_report V2 的「本决策群新增证据」使用（生产 OpenClaw 不落 lark_messages）。
 *   status --db <path> --tenant <t>
 *       打印每位演示候选人的就绪情况（绑定/launch/focus/消息/决策群/报告）。
 *
 * 用法：node scripts/demo-offer-seed.mjs seed --db data/brainx.db --tenant <tenant> --account mia
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, now } from '../src/db.js';
import { setProjectCandidateFocus } from '../src/candidate-focus.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/demo-offer-candidates.json');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

function requireArg(args, key) {
  if (!args[key] || args[key] === true) {
    console.error(`❌ 缺少参数 --${key}`);
    process.exit(2);
  }
  return args[key];
}

function loadCandidates() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')).candidates;
}

function minutesAgo(min) {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function ensureBinding(db, { tenantId, accountId, consultantId, at }) {
  const consultant = db.prepare('SELECT open_id FROM consultants WHERE consultant_id=? AND active=1')
    .get(consultantId);
  if (!consultant?.open_id) return { consultantId, skipped: '无 open_id 或顾问不存在' };
  const existing = db.prepare(`SELECT binding_id FROM feishu_identity_bindings
    WHERE tenant_id=? AND channel_account_id=? AND consultant_id=? AND binding_status='ACTIVE'`)
    .get(tenantId, accountId, consultantId);
  if (existing) return { consultantId, skipped: '已存在 ACTIVE 绑定' };
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
     binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'ACTIVE',?,'demo-offer-seed',?,?)`)
    .run(`demo-bind-${accountId}-${consultantId}`, tenantId, accountId, '0'.repeat(64),
      consultant.open_id, consultantId, at, at, at);
  return { consultantId, inserted: true };
}

function ensureMembership(db, { consultantId, jobId, relation, at }) {
  db.prepare(`INSERT OR IGNORE INTO job_memberships
    (consultant_id,project_id,relation,source,valid_from) VALUES (?,?,?,'demo-offer-seed',?)`)
    .run(consultantId, jobId, relation, at);
}

function ensureLaunch(db, { consultantId, jobId, chatId, at }) {
  const existing = db.prepare('SELECT launch_id,status,chat_id FROM project_launches WHERE project_id=?')
    .get(jobId);
  if (existing) return { jobId, skipped: `已存在 launch(${existing.status})，未覆盖` };
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,chat_name,
     created_at,updated_at)
    VALUES (?,?,?,?,'READY','READY',?,?,?,?)`)
    .run(`demo-launch-${jobId}`, consultantId, jobId, `demo-launch-${jobId}`, chatId,
      `demo-src-${jobId}`, at, at);
  return { jobId, inserted: true };
}

function insertMessages(db, { chatId, messages, idPrefix }) {
  let inserted = 0;
  messages.forEach((msg, index) => {
    const at = minutesAgo(msg.offset_min);
    const result = db.prepare(`INSERT OR IGNORE INTO lark_messages
      (message_id,chat_id,message_type,text,mentions_json,create_time,received_at)
      VALUES (?,?,'text',?,'[]',?,?)`)
      .run(`${idPrefix}-${index}`, chatId, msg.text, at, at);
    inserted += result.changes;
  });
  return inserted;
}

function cmdSeed(args) {
  const dbPath = requireArg(args, 'db');
  const tenantId = requireArg(args, 'tenant');
  const accountId = requireArg(args, 'account');
  const chatMap = {};
  for (const entry of args._.slice(1).concat(typeof args['source-chat'] === 'string' ? [args['source-chat']] : [])) {
    const [ref, chat] = String(entry).split('=');
    if (ref && chat) chatMap[ref] = chat;
  }
  const db = openDb(dbPath);
  const at = now();
  for (const candidate of loadCandidates()) {
    const sourceChat = chatMap[candidate.candidate_ref] || `oc_demo_src_${candidate.candidate_ref}`;
    console.log(`\n== ${candidate.snapshot.name}（${candidate.candidate_ref} × ${candidate.job_id}）来源群 ${sourceChat}`);
    const people = [...new Set([candidate.consultant_id, ...(candidate.member_consultants || [])])];
    for (const consultantId of people) {
      console.log('  绑定:', JSON.stringify(ensureBinding(db, { tenantId, accountId, consultantId, at })));
      ensureMembership(db, { consultantId, jobId: candidate.job_id,
        relation: consultantId === candidate.consultant_id ? 'MY_JOB' : 'TEAM_SHARED', at });
    }
    console.log('  launch:', JSON.stringify(ensureLaunch(db,
      { consultantId: candidate.consultant_id, jobId: candidate.job_id, chatId: sourceChat, at })));
    setProjectCandidateFocus(db, { tenantId, consultantId: candidate.consultant_id,
      jobId: candidate.job_id, candidateRef: candidate.candidate_ref,
      candidateSnapshot: candidate.snapshot }, true, at);
    console.log('  focus: 已设置（含快照）');
    console.log(`  来源群消息: 灌入 ${insertMessages(db,
      { chatId: sourceChat, messages: candidate.source_messages, idPrefix: `demo-src-${candidate.candidate_ref}` })} 条`);
  }
  db.close();
  console.log('\n✅ seed 完成。下一步：在各来源群 @机器人 触发 CREATE_DECISION_GROUP（或用 status 检查）。');
}

function cmdSeedOfferMsg(args) {
  const dbPath = requireArg(args, 'db');
  const chatId = requireArg(args, 'chat');
  const ref = requireArg(args, 'ref');
  const candidate = loadCandidates().find((item) => item.candidate_ref === ref);
  if (!candidate) { console.error(`❌ fixture 中无候选人 ${ref}`); process.exit(2); }
  const db = openDb(dbPath);
  const inserted = insertMessages(db, { chatId, messages: candidate.offer_messages,
    idPrefix: `demo-offer-${ref}` });
  db.close();
  console.log(`✅ 已向 ${chatId} 灌入 ${inserted} 条电话纪要，可触发「更新报告」生成含新增证据的新版本。`);
}

function cmdStatus(args) {
  const dbPath = requireArg(args, 'db');
  const tenantId = requireArg(args, 'tenant');
  const db = openDb(dbPath);
  for (const candidate of loadCandidates()) {
    const launch = db.prepare('SELECT status,chat_id FROM project_launches WHERE project_id=?')
      .get(candidate.job_id);
    const focus = db.prepare(`SELECT focus_status FROM project_candidate_focus
      WHERE tenant_id=? AND position_id=? AND candidate_ref=?`)
      .get(tenantId, candidate.job_id, candidate.candidate_ref);
    const group = db.prepare(`SELECT status,target_chat_id,target_chat_name FROM candidate_decision_groups
      WHERE tenant_id=? AND position_id=? AND candidate_ref=?`)
      .get(tenantId, candidate.job_id, candidate.candidate_ref);
    const messages = group?.target_chat_id
      ? db.prepare('SELECT COUNT(*) n FROM lark_messages WHERE chat_id=?').get(group.target_chat_id).n : 0;
    const reports = group
      ? db.prepare(`SELECT COUNT(*) n FROM candidate_reports WHERE decision_group_id=
          (SELECT decision_group_id FROM candidate_decision_groups
           WHERE tenant_id=? AND position_id=? AND candidate_ref=?)`)
        .get(tenantId, candidate.job_id, candidate.candidate_ref).n : 0;
    console.log(`${candidate.snapshot.name} ${candidate.candidate_ref}`
      + ` | launch=${launch ? `${launch.status}@${launch.chat_id}` : '缺'}`
      + ` | focus=${focus ? focus.focus_status : '缺'}`
      + ` | 决策群=${group ? `${group.status} ${group.target_chat_name || ''}` : '未建'}`
      + ` | 群消息=${messages} | 报告=${reports} 版`);
  }
  db.close();
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === 'seed') cmdSeed(args);
else if (cmd === 'seed-offer-msg') cmdSeedOfferMsg(args);
else if (cmd === 'status') cmdStatus(args);
else {
  console.error('用法: node scripts/demo-offer-seed.mjs seed|seed-offer-msg|status（见文件头注释）');
  process.exit(2);
}

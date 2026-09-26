/** fact-agent-extract.test.mjs — 抽取管线框架契约（specs/023 施工序③）。
 *
 * 覆盖：post 富文本拍平、信号预筛、受控枚举归一化（非法值丢弃）、消歧三分叉（US2）、
 * GLM 批量契约解析（单条畸形不废整批）、evidence 原文锚定（宁缺勿错）、
 * 开关关闭路径（零 LLM 零落库，US1-AC3）、端到端幂等（AC-1）。
 * LLM 以注入假函数模拟——核心模块零网络 IO（架构红线）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import {
  postToPlainText, isSignalMessage, normalizeValue, disambiguate,
  parseBatchResponse, factToRow, runFactAgentPipeline, hintSimilarity,
} from '../src/fact-agent-extract.js';
import { statsAgentFacts } from '../src/agent-facts.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-fa-')), 'test.db'));

function seedJob(db, { projectId, chatId, company = '星曜科技', role = '后端工程师' }) {
  // job_facts.sync_id NOT NULL REFERENCES sync_runs：先种一条 complete 同步批次
  db.prepare(`INSERT OR IGNORE INTO sync_runs
    (sync_id, consultant_id, source, as_of, complete, input_hash, started_at, completed_at)
    VALUES ('sync_test', 'c_test', 'fixture', '2026-09-01T00:00:00.000Z', 1, 'test', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO job_facts (project_id, company, role, chat_id, active_state,
    captured_at, sync_id, raw_json, updated_at)
    VALUES (?, ?, ?, ?, 'UNKNOWN', ?, 'sync_test', '{}', ?)`)
    .run(projectId, company, role, chatId, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
}

function seedMessage(db, { messageId, chatId, text, createTime = '2026-09-20T10:00:00.000Z' }) {
  db.prepare(`INSERT INTO lark_messages (message_id, chat_id, message_type, text, create_time, received_at)
    VALUES (?, ?, 'post', ?, ?, ?)`)
    .run(messageId, chatId, text, createTime, createTime);
}

// ---------------------------------------------------------------- postToPlainText

test('post 富文本拍平：title + 嵌套 content 文本拼接，格式噪音剔除', () => {
  const post = JSON.stringify({
    title: '进度同步',
    content: [[{ tag: 'text', text: '候选人约了' }, { tag: 'a', text: '二面', href: 'x' }], [{ tag: 'text', text: 'HC 不限' }]],
  });
  const out = postToPlainText(post);
  assert.ok(out.includes('进度同步') && out.includes('候选人约了') && out.includes('二面') && out.includes('HC 不限'));
  assert.ok(!out.includes('"tag"'), 'JSON 结构噪音不得外泄');
});

test('postToPlainText 防御式：非法 JSON / 纯文本 / 非预期形状一律回落原文，不抛错', () => {
  assert.equal(postToPlainText('{"broken'), '{"broken');
  assert.equal(postToPlainText('直接说话的文本'), '直接说话的文本');
  assert.equal(postToPlainText('{"foo":1}'), '{"foo":1}');
  assert.equal(postToPlainText(null), '');
});

// ---------------------------------------------------------------- 预筛与归一化

test('预筛：阶段/offer/HC/状态关键词命中；闲聊不命中', () => {
  assert.equal(isSignalMessage('候选人约了二面，下周三'), true);
  assert.equal(isSignalMessage('长期招聘HC不限，直接汇报coo'), true);
  assert.equal(isSignalMessage('这个职位暂停了'), true);
  assert.equal(isSignalMessage('明天团建记得带伞'), false);
  assert.equal(isSignalMessage(''), false);
});

test('归一化：阶段说法映射受控枚举；不可映射丢弃（非法值丢弃红线）', () => {
  assert.equal(normalizeValue('current_stage', '约了初面'), '一面');
  assert.equal(normalizeValue('current_stage', '二面'), '二面');
  assert.equal(normalizeValue('current_stage', '终面通过了'), '终面');
  assert.equal(normalizeValue('current_stage', '发了offer'), 'Offer');
  assert.equal(normalizeValue('current_stage', '下周到岗'), '入职');
  assert.equal(normalizeValue('current_stage', '聊得不错'), null);
  // 2026-09-26 生产试点实证缺口：「第 N 轮」说法（40 条试点 invalid 10 条的主因之一）
  assert.equal(normalizeValue('current_stage', '第二轮'), '二面');
  assert.equal(normalizeValue('current_stage', '进入第一轮'), '一面');
  assert.equal(normalizeValue('current_stage', '第三轮'), '终面');
  assert.equal(normalizeValue('current_stage', '面试'), null, '无轮次的「面试」不可映射，保持丢弃');
});

test('归一化：active_state 只认 OPEN/CLOSED/COOLING；OPEN 与矛盾词并存 → 丢弃（规则校验）', () => {
  assert.equal(normalizeValue('active_state', 'OPEN'), 'OPEN');
  assert.equal(normalizeValue('active_state', 'cooling'), 'COOLING');
  assert.equal(normalizeValue('active_state', '在招'), null, '中文说法必须 GLM 先归一，规则层不兜底猜测');
  assert.equal(normalizeValue('active_state', 'OPEN', '这个职位暂停了'), null, 'GLM 判 OPEN 但证据是暂停 → 矛盾丢弃');
  assert.equal(normalizeValue('active_state', 'OPEN', '长期招聘HC不限'), 'OPEN');
});

// ---------------------------------------------------------------- 消歧三分叉

test('消歧三分叉：1:1 群直落 / 多职位 GLM 指名 / 指不出落群级（US2）', () => {
  const jobs = [
    { project_id: 'pj_a', company: '星曜科技', role: '后端工程师' },
    { project_id: 'pj_b', company: '煌炎科技', role: '算法工程师' },
  ];
  assert.deepEqual(disambiguate({}, [jobs[0]]), { project_id: 'pj_a', fork: 'single' });
  assert.deepEqual(disambiguate({ project_hint: '煌炎科技' }, jobs), { project_id: 'pj_b', fork: 'named' });
  assert.deepEqual(disambiguate({ project_hint: '完全无关的东西' }, jobs), { project_id: null, fork: 'group' });
  assert.deepEqual(disambiguate({}, jobs), { project_id: null, fork: 'group' });
});

test('相似度：包含=1；字符交集比例供指名匹配；阈值 0.7 生效', () => {
  assert.equal(hintSimilarity('星曜科技', '星曜科技（上海）'), 1);
  assert.equal(hintSimilarity('后端', '后端工程师'), 1);
  assert.ok(hintSimilarity('星曜', '煌炎') < 0.7, '不相干指名不得过阈值');
});

// ---------------------------------------------------------------- GLM 批量契约

test('批量回复解析：容忍围栏；畸形条目丢弃不废整批；message_id 白名单外拒收', () => {
  const raw = '前置说明```json\n{"results":['
    + '{"message_id":"om_1","facts":[{"field":"current_stage","value":"二面","confidence":0.9,"evidence":"约了二面"}]},'
    + '{"message_id":"om_坏行"},'
    + '{"message_id":"om_2","facts":[{"field":"active_state","value":"OPEN","confidence":0.8,"evidence":"还在招"}]}'
    + ']}```后缀';
  const { ok, byMessage } = parseBatchResponse(raw, ['om_1', 'om_2', 'om_3']);
  assert.equal(ok, true);
  assert.equal(byMessage.get('om_1').length, 1);
  assert.equal(byMessage.get('om_2').length, 1);
  assert.equal(byMessage.size, 2, 'om_坏行 无 facts 数组被丢');
  const outside = parseBatchResponse('{"results":[{"message_id":"om_999","facts":[]}]}', ['om_1']);
  assert.equal(outside.byMessage.size, 0, '白名单外 message_id 拒收');
  assert.equal(parseBatchResponse('完全不是 JSON', ['om_1']).ok, false);
});

test('factToRow：evidence 无原文锚定丢弃（宁缺勿错）；不可映射值丢弃并给原因', () => {
  const item = { message_id: 'om_1', chat_id: 'oc_g', plain: '候选人约了二面，下周三', jobs: [] };
  const anchored = factToRow(
    { field: 'current_stage', value: '二面', confidence: 0.9, evidence: '约了二面' }, item, 'glm-x');
  assert.equal(anchored.row.value, '二面');
  assert.equal(anchored.fork, 'group');
  const notAnchored = factToRow(
    { field: 'current_stage', value: '二面', confidence: 0.9, evidence: '原文里没有这句' }, item, 'glm-x');
  assert.equal(notAnchored.row, null);
  assert.equal(notAnchored.reason, 'evidence_not_anchored');
  const unmappable = factToRow(
    { field: 'active_state', value: '很好', confidence: 0.9, evidence: '还在招' }, item, 'glm-x');
  assert.equal(unmappable.row, null);
});

// ---------------------------------------------------------------- 端到端

function seedScenario(db) {
  seedJob(db, { projectId: 'pj_a', chatId: 'oc_single' });                    // 1:1 群
  seedJob(db, { projectId: 'pj_c1', chatId: 'oc_multi', company: '创联数科', role: '数据工程师' });
  seedJob(db, { projectId: 'pj_c2', chatId: 'oc_multi', company: 'Pix', role: 'MLE 实习' }); // 多职位群
  seedMessage(db, { messageId: 'om_s1', chatId: 'oc_single', text: '候选人约了二面' });
  seedMessage(db, {
    messageId: 'om_m1', chatId: 'oc_multi',
    text: JSON.stringify({ title: '', content: [[{ tag: 'text', text: 'Pix又发出了一张MLE实习offer' }]] }),
  });
  seedMessage(db, { messageId: 'om_m2', chatId: 'oc_multi', text: '创联数科那个职位暂停了' });
  seedMessage(db, { messageId: 'om_g1', chatId: 'oc_nobind', text: '客户那边这个职位暂停了，先不推人' }); // 群无绑定 → 群级
  seedMessage(db, { messageId: 'om_n1', chatId: 'oc_quiet', text: '今天天气不错，出去走走' });
}

/** 假 LLM：按消息内容回确定性抽取（模拟 GLM 行为，不触网）。 */
function fakeLlm({ user }) {
  const out = [];
  for (const m of user.match(/【消息\d+】message_id=(\S+)/g) || []) {
    const id = m.split('message_id=')[1];
    if (id === 'om_s1') {
      out.push({ message_id: id, facts: [
        { field: 'current_stage', value: '二面', confidence: 0.9, evidence: '约了二面' }] });
    } else if (id === 'om_m1') {
      out.push({ message_id: id, facts: [
        { field: 'current_stage', value: 'offer', confidence: 0.85, project_hint: 'Pix', evidence: '发出了一张MLE实习offer' }] });
    } else if (id === 'om_m2') {
      out.push({ message_id: id, facts: [
        { field: 'active_state', value: 'COOLING', confidence: 0.8, project_hint: '创联数科', evidence: '创联数科那个职位暂停了' }] });
    } else if (id === 'om_g1') {
      out.push({ message_id: id, facts: [
        { field: 'active_state', value: 'COOLING', confidence: 0.8, evidence: '这个职位暂停了' }] }); // 无 hint + 群无绑定 → 群级
    }
  }
  return Promise.resolve(JSON.stringify({ results: out }));
}

test('端到端：三分叉落位正确，群级行不串职位级；统计结构完整（FR-6）', async () => {
  const db = newDb();
  seedScenario(db);
  const { stats, rows } = await runFactAgentPipeline(db, { llm: fakeLlm, extractedAt: '2026-09-24T00:00:00.000Z' });
  assert.equal(stats.candidates, 4, 'om_n1 闲聊不进候选');
  assert.equal(stats.inserted, 4);
  const stageA = db.prepare("SELECT value FROM job_agent_facts WHERE project_id='pj_a'").get();
  assert.equal(stageA.value, '二面', '1:1 群直落职位级');
  const pix = db.prepare("SELECT value FROM job_agent_facts WHERE project_id='pj_c2'").get();
  assert.equal(pix.value, 'Offer', '多职位群 GLM 指名 → 职位级');
  const group = db.prepare("SELECT value FROM job_agent_facts WHERE project_id IS NULL AND message_id='om_g1'").get();
  assert.equal(group.value, 'COOLING', '无绑定群落群级（project_id NULL）');
  const m2Group = db.prepare("SELECT value FROM job_agent_facts WHERE project_id IS NULL AND message_id='om_m2'").get();
  assert.equal(m2Group, undefined, '创联数科被指名 → 不落群级');
  assert.equal(stats.fork.single, 1);
  assert.equal(stats.fork.named, 2);
  assert.equal(stats.fork.group, 1);
  assert.ok(stats.byField.current_stage === 2 && stats.byField.active_state === 2);
  assert.equal(rows.length, 4);
});

test('端到端幂等（含群级行）：同批重跑第二轮零新增（AC-1 全层级）', async () => {
  const db = newDb();
  seedScenario(db);
  const r1 = await runFactAgentPipeline(db, { llm: fakeLlm, extractedAt: '2026-09-24T00:00:00.000Z' });
  assert.equal(r1.stats.inserted, 4);
  const r2 = await runFactAgentPipeline(db, { llm: fakeLlm, extractedAt: '2026-09-24T01:00:00.000Z' });
  assert.equal(r2.stats.inserted, 0, '第二轮零新增——职位级与群级一并成立');
  assert.equal(r2.stats.duplicates, 4);
  assert.equal(statsAgentFacts(db).total, 4, '总行数不得翻倍（群级 NULL≠NULL 防回归）');
});

test('开关关闭路径：无 llm 注入 → 只跑解析+预筛，零 GLM 批次零落库（US1-AC3）', async () => {
  const db = newDb();
  seedScenario(db);
  const { stats, rows } = await runFactAgentPipeline(db, { llm: null });
  assert.equal(stats.scanned, 5);
  assert.equal(stats.candidates, 4);
  assert.equal(stats.llmBatches, 0, '零 token');
  assert.equal(stats.inserted, 0);
  assert.equal(rows.length, 0);
  assert.equal(statsAgentFacts(db).total, 0, '零落库');
});

test('LLM 批次失败：失败计数不阻塞、不落库；下轮重试由幂等键兜底（US4）', async () => {
  const db = newDb();
  seedScenario(db);
  const { stats } = await runFactAgentPipeline(db, {
    llm: () => Promise.reject(new Error('GLM_TIMEOUT')),
    extractedAt: '2026-09-24T00:00:00.000Z',
  });
  assert.ok(stats.llmBatches > 0);
  assert.equal(stats.llmFailures, stats.llmBatches);
  assert.equal(stats.inserted, 0);
  assert.equal(statsAgentFacts(db).total, 0);
});

test('增量窗口：--since 只扫窗口内消息；管线按 20 条切批（FR-2）', async () => {
  const db = newDb();
  seedScenario(db);
  seedMessage(db, { messageId: 'om_old', chatId: 'oc_single', text: '还在招', createTime: '2026-09-01T00:00:00.000Z' });
  const { stats } = await runFactAgentPipeline(db, { llm: fakeLlm, since: '2026-09-10T00:00:00.000Z' });
  assert.equal(stats.scanned, 5, 'om_old（09-01）在窗口外');
  // 25 条信号消息 → 2 个批次（20+5）
  seedMessage(db, { messageId: 'om_b00', chatId: 'oc_single', text: '还在招' }); // 群已有职位绑定，1:1 通道
  for (let i = 1; i < 25; i++) {
    seedMessage(db, { messageId: `om_b${String(i).padStart(2, '0')}`, chatId: 'oc_batch', text: `急招工程师${i}号` });
  }
  const calls = [];
  await runFactAgentPipeline(db, {
    llm: ({ user }) => { calls.push(user); return Promise.resolve('{"results":[]}'); },
    limit: 100,
  });
  assert.equal(calls.length, 2, '25 条候选应切成 2 批');
  assert.ok(calls[0].includes('【消息20】') && !calls[0].includes('【消息21】'), '首批 ≤20 条');
});

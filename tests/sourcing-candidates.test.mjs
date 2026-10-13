import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { settleOpenmaiTask } from '../src/openmai-task.js';
import { createSourcingRecallToolHandlers } from '../src/agent-gateway/tools-sourcing-recall.js';
import { createFreeformCandidateHandlers } from '../src/agent-gateway/tools-freeform-candidates.js';
import {
  storeSourcingCandidates, recallSourcingCandidates, updateSourcingCareerStatus,
  splitCandidateRole, parseScoreNum, careerStatusMap,
} from '../src/sourcing-candidates.js';
import { assertSafeAgentProjection } from '../src/agent-gateway/projection.js';

const MACHINE_BLOCK = (refs) => `前置说明文字
<!-- BRAINX_CANDIDATES_V1
{"candidates":[${refs.map((ref, i) => JSON.stringify({
  candidate_ref: ref, name: `候选人${i + 1}`,
  role: i === 0 ? '小红书 / AI产品经理' : '字节跳动 / 高级产品经理',
  experience: '7 年', city: '上海', education: '硕士 · 复旦',
  evaluation: '大模型应用落地经验充分', score: i === 0 ? '92%' : '84',
  talent_url: `https://app.ttcadvisory.com/app/talent/${ref}`,
})).join(',')}]}
-->`;

const principal = { tenantId: 't1', consultantId: 'felix', accountId: 'a1', senderId: 'ou_me', chatType: 'group', chatId: 'oc_g' };

function fixture(t, refs = ['PL9000000001', 'PL9000000002']) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const at = now();
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,task_id,started_at,search_brief,search_round,excluded_candidate_refs_json)
    VALUES ('supermai:abc123def456','felix','running','sm_rc',?,'上海 AI 产品经理',1,'[]')`).run(at);
  return { db, settleDone: () => settleOpenmaiTask(db, { projectId: 'supermai:abc123def456',
    consultantId: 'felix', taskId: 'sm_rc', status: 'done', resultText: MACHINE_BLOCK(refs) }) };
}

test('done 结算同步拆行：公司/职位拆分、分值数值化、recommended 初始态', t => {
  const { db, settleDone } = fixture(t);
  assert.equal(settleDone(), true);
  const rows = db.prepare('SELECT * FROM sourcing_candidates ORDER BY candidate_ref').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(splitCandidateRole('小红书 / AI产品经理'), { company: '小红书', title: 'AI产品经理' });
  assert.deepEqual(splitCandidateRole('独立职位'), { company: null, title: '独立职位' });
  assert.equal(parseScoreNum('92%'), 92);
  assert.equal(parseScoreNum('—'), null);
  const first = rows.find((r) => r.candidate_ref === 'PL9000000001');
  assert.equal(first.company, '小红书');
  assert.equal(first.title, 'AI产品经理');
  assert.equal(first.score_num, 92);
  assert.equal(first.career_status, 'recommended');
  assert.equal(first.city, '上海');
});

test('failed / needs_input 结算不拆行', t => {
  const { db } = fixture(t);
  settleOpenmaiTask(db, { projectId: 'supermai:abc123def456', consultantId: 'felix', taskId: 'sm_rc',
    status: 'needs_input', resultText: '请补充职位信息' });
  assert.equal(db.prepare('SELECT count(*) n FROM sourcing_candidates').get().n, 0);
});

test('recall：关键词过滤 + 顾问隔离 + 排序 + limit', t => {
  const { db, settleDone } = fixture(t);
  settleDone();
  const mine = recallSourcingCandidates(db, { consultantId: 'felix', filter: '小红书' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].candidate_ref, 'PL9000000001');
  assert.equal(recallSourcingCandidates(db, { consultantId: 'felix', city: '北京' }).length, 0);
  assert.equal(recallSourcingCandidates(db, { consultantId: 'felix', limit: 1 }).length, 1);
  assert.deepEqual(recallSourcingCandidates(db, { consultantId: 'mia' }), []);
  const byScore = recallSourcingCandidates(db, { consultantId: 'felix' });
  assert.equal(byScore[0].candidate_ref, 'PL9000000001');
  // LIKE 通配符不放大匹配：把 % 当字面词查不到
  assert.equal(recallSourcingCandidates(db, { consultantId: 'felix', filter: '%' }).length, 0);
});

test('recall 工具 envelope 过群聊投影安全，不含付费搜索暗示', async t => {
  const { db, settleDone } = fixture(t);
  settleDone();
  const handlers = createSourcingRecallToolHandlers({ db });
  const out = handlers.brainx_sourcing_recall({ filter: '字节' }, { principal });
  assert.equal(out.data.recalled, 1);
  assert.equal(out.data.items[0].candidate_ref, 'PL9000000002');
  assert.equal(out.data.items[0].career_label, '新推荐');
  assert.equal(out.facts[0].paid_search_triggered, false);
  assert.doesNotThrow(() => assertSafeAgentProjection(out, principal));
  assert.equal(Object.keys(JSON.parse(JSON.stringify(out.data))).some(k => /contact/i.test(k)), false);
  const empty = handlers.brainx_sourcing_recall({ filter: '不存在的人' }, { principal });
  assert.equal(empty.data.recalled, 0);
  assert.match(empty.recommendations[0].note, /brainx_supermai_scout/);
  await assert.rejects(async () => handlers.brainx_sourcing_recall({ search_key: 'bad key!' }, { principal }), /INVALID_ARGUMENT/);
});

test('四动作回写 career_status：SCREEN/REJECT/RESTORE，入库后 in_pool', async t => {
  const { db, settleDone } = fixture(t);
  settleDone();
  // freeform 动作授权三件套：binding + group scope + 投递快照（authorizedCandidate 的真实数据源）
  const at = now();
  const appKeyHash = 'k'.repeat(64);
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
    binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('b','t1','a1',?,'ou_me','felix','ACTIVE',?,'test',?,?)`).run(appKeyHash, at, at, at);
  db.prepare(`INSERT INTO agent_group_scopes
    (group_scope_id,tenant_id,channel_account_id,chat_id,scope_status,allowed_purposes_json,created_at,updated_at)
    VALUES ('s','t1','a1','oc_g','ACTIVE','["candidate_review"]',?,?)`).run(at, at);
  db.prepare(`INSERT INTO sourcing_group_deliveries
    (delivery_id,task_id,search_key,consultant_id,binding_id,group_scope_id,search_brief,search_round,
     excluded_candidate_refs_json,next_attempt_at,result_status,result_text,delivery_status,created_at,updated_at)
    VALUES ('d','sm_rc','supermai:abc123def456','felix','b','s','上海 AI 产品经理',1,'[]',?,'done',?, 'SENT',?,?)`)
    .run(at, MACHINE_BLOCK(['PL9000000001', 'PL9000000002']), at, at);
  const deps = { addTalentFn: async () => ({ id: 77, already: false }),
    loadCandidateContactFn: async () => assert.fail('本用例不触发'),
    sendTextMessageFn: async () => assert.fail('本用例不触发') };
  const handlers = createFreeformCandidateHandlers({ db, ...deps });
  const args = { search_key: 'supermai:abc123def456', candidate_ref: 'PL9000000001', confirm: true };
  await handlers.brainx_freeform_candidate_action({ ...args, action: 'SCREEN' }, { principal });
  assert.equal(careerStatusMap(db, { searchKey: 'supermai:abc123def456', consultantId: 'felix' }).PL9000000001, 'screened');
  await handlers.brainx_freeform_candidate_action({ ...args, action: 'REJECT' }, { principal });
  assert.equal(careerStatusMap(db, { searchKey: 'supermai:abc123def456', consultantId: 'felix' }).PL9000000001, 'rejected');
  await handlers.brainx_freeform_candidate_action({ ...args, action: 'ADD_TO_RELOOP' }, { principal });
  assert.equal(careerStatusMap(db, { searchKey: 'supermai:abc123def456', consultantId: 'felix' }).PL9000000001, 'in_pool');
  // 状态非法值拒绝；跨顾问不串行
  assert.throws(() => updateSourcingCareerStatus(db, { searchKey: 'supermai:abc123def456',
    consultantId: 'felix', candidateRef: 'PL9000000001', status: 'bogus' }), /SOURCING_CAREER_STATUS_INVALID/);
  assert.equal(updateSourcingCareerStatus(db, { searchKey: 'supermai:abc123def456',
    consultantId: 'mia', candidateRef: 'PL9000000001', status: 'screened' }), 0);
});

test('重结算幂等：快照字段刷新，已动作的 career_status 不被重置为 recommended', t => {
  const { db, settleDone } = fixture(t);
  settleDone();
  updateSourcingCareerStatus(db, { searchKey: 'supermai:abc123def456',
    consultantId: 'felix', candidateRef: 'PL9000000001', status: 'screened' });
  db.prepare("UPDATE openmai_results SET status='running', task_id='sm_rc2', result_text=NULL").run();
  settleOpenmaiTask(db, { projectId: 'supermai:abc123def456', consultantId: 'felix', taskId: 'sm_rc2',
    status: 'done', resultText: MACHINE_BLOCK(['PL9000000001', 'PL9000000002']) });
  assert.equal(careerStatusMap(db, { searchKey: 'supermai:abc123def456', consultantId: 'felix' }).PL9000000001, 'screened');
});

test('超长输入遵守解析层契约：extract 截到 60 后落库不二次截断、不报错', t => {
  const { db } = fixture(t);
  const long = 'x'.repeat(3000);
  const poisoned = `<!-- BRAINX_CANDIDATES_V1
{"candidates":[{"candidate_ref":"PL9000000009","name":"${long}","role":"r","score":"1"}]}
-->`;
  db.prepare('UPDATE openmai_results SET result_text=?').run(poisoned);
  const n = storeSourcingCandidates(db, { projectId: 'supermai:abc123def456',
    consultantId: 'felix', taskId: 'sm_rc' });
  // 解析层（openmai-result.js V1 契约）已把 name 截到 60——落库层如实保存、不做第二次截断。
  assert.equal(n, 1);
  const row = db.prepare(`SELECT LENGTH(name) len FROM sourcing_candidates
    WHERE candidate_ref='PL9000000009'`).get();
  assert.equal(row.len, 60);
});

/** 工具注册表 / sql 守门 / cid 锁定 / 技能发现 测试。不触网。 */
process.env.BRAINX_LLM_DISABLE = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { TOOL_ROWS, createToolkit } from '../src/agent/registry.js';
import { guardSelect, stripComments, maskStrings, SqlGuardError } from '../src/agent/sql-guard.js';
import { discoverSkills, loadSkill, parseSkillFile, GLOBAL_SKILLS_DIR } from '../src/agent/skills.js';
import { buildSystemPrompt } from '../src/agent/persona.js';

const ctxOf = (db, cid = 'felix', extra = {}) => ({ db, cid, skillsIndex: new Map(), readDb: () => db, ...extra });

// —— 注册表完备性 ——

test('注册表:命名合法唯一、无写操作工具', () => {
  const names = TOOL_ROWS.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  for (const row of TOOL_ROWS) {
    assert.match(row.name, /^[a-z0-9_]{1,64}$/);
    assert.ok(row.description && row.run && row.parameters);
  }
  const WRITE_TOOLS = ['brainx_engage', 'brainx_record_progress', 'brainx_terminal_result',
    'brainx_record_outcome', 'brainx_feedback', 'brainx_recommend_run', 'brainx_sync_now'];
  for (const w of WRITE_TOOLS) assert.ok(!names.includes(w), `${w} 不得注册`);
  const { schemas, toolCount } = createToolkit(ctxOf(openDb(':memory:')));
  assert.equal(schemas.length, toolCount);
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.ok(s.function.name && s.function.description && s.function.parameters);
  }
});

test('BRAINX_AGENT_SQL=0 时 query_sql 不进 schema', () => {
  const withSql = createToolkit(ctxOf(openDb(':memory:')));
  const withoutSql = createToolkit(ctxOf(openDb(':memory:')), { includeSql: false });
  assert.ok(withSql.schemas.some((s) => s.function.name === 'query_sql'));
  assert.ok(!withoutSql.schemas.some((s) => s.function.name === 'query_sql'));
  assert.equal(withoutSql.toolCount, withSql.toolCount - 1);
});

// —— sql 守门 ——

test('guardSelect 放行只读并包 LIMIT', () => {
  assert.equal(guardSelect('select * from job_facts'), 'SELECT * FROM (select * from job_facts) AS __q LIMIT 500');
  assert.ok(guardSelect('WITH t AS (SELECT 1) SELECT * FROM t').startsWith('SELECT * FROM (WITH t'));
  assert.equal(guardSelect('EXPLAIN SELECT 1'), 'EXPLAIN SELECT 1'); // EXPLAIN 不包子查询
  assert.ok(guardSelect('  -- 注释\nSELECT 1;').endsWith('LIMIT 500')); // 行首注释+尾分号
});

test('guardSelect 拒绝写操作/多语句/注释偷渡/危险函数', () => {
  const bad = [
    'INSERT INTO job_facts VALUES (1)',
    'SELECT 1; DROP TABLE job_facts',
    'SELECT 1 /* ; DROP TABLE x -- */ ; DELETE FROM job_facts',
    'PRAGMA integrity_check',
    'PRAGMA user_version = 3',
    'ATTACH DATABASE "x" AS x',
    'UPDATE job_facts SET city="x"',
    'SELECT load_extension("evil")',
    'SELECT readfile("/etc/passwd")',
    'CREATE TABLE t (a)',
    'VACUUM',
  ];
  for (const sql of bad) {
    assert.throws(() => guardSelect(sql), (e) => e instanceof SqlGuardError, sql);
  }
});

test('字符串字面量里的分号与禁词不误伤', () => {
  const ok = guardSelect("SELECT * FROM job_facts WHERE company='A;DROP' AND note LIKE '%delete%'");
  assert.match(ok, /^SELECT \* FROM \(/);
  assert.equal(maskStrings("SELECT 'a;b', 'c'"), "SELECT '', ''");
  assert.equal(stripComments("SELECT '--not-comment', 1 -- real").trim(), "SELECT '--not-comment', 1");
});

test('query_sql 真查 fixture 库 + 拒写 + 单元格截断', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const toolkit = createToolkit(ctxOf(db));
  const count = JSON.parse(await toolkit.call('query_sql', { sql: 'SELECT count(*) AS n FROM job_facts' }));
  assert.equal(typeof count.rows[0].n, 'number');
  assert.ok(count.rows[0].n > 0);
  const denied = JSON.parse(await toolkit.call('query_sql', { sql: 'DELETE FROM job_facts' }));
  assert.equal(denied.error, 'SQL_GUARD');
  // 长单元格截断
  const long = JSON.parse(await toolkit.call('query_sql', {
    sql: "SELECT printf('%.*c', 2000, 'x') AS big",
  }));
  assert.ok(String(long.rows[0].big).length <= 501);
});

// —— cid 锁定(严格隔离) ——

test('数据工具忽略外来 consultant_id,不可见职位 fail-closed', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const pid = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' AND valid_to IS NULL LIMIT 1").get()?.project_id;
  assert.ok(pid, 'fixture 应给 felix 落关系');
  const felixKit = createToolkit(ctxOf(db, 'felix'));
  const mine = JSON.parse(await felixKit.call('brainx_opportunity', { project_id: pid, consultant_id: 'mia' }));
  assert.ok(mine.job, '会话 cid 是 felix,外来 consultant_id 应被忽略');
  const miaKit = createToolkit(ctxOf(db, 'mia'));
  const other = JSON.parse(await miaKit.call('brainx_opportunity', { project_id: pid }));
  assert.equal(other.error, 'NOT_FOUND'); // mia 无关系 → fail-closed
  const wb = JSON.parse(await miaKit.call('brainx_workbench', { consultant_id: 'felix' }));
  assert.equal(wb.consultant_id, 'mia');
});

test('replay 跨人回放返回 NOT_FOUND(与 HTTP 同口径)', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const { recommend } = await import('../src/recommend.js');
  recommend(db, 'felix', { top: 5 });
  const dec = db.prepare("SELECT decision_id FROM recommendations WHERE consultant_id='felix' LIMIT 1").get()?.decision_id;
  assert.ok(dec);
  const miaKit = createToolkit(ctxOf(db, 'mia'));
  assert.equal(JSON.parse(await miaKit.call('brainx_replay', { decision_id: dec })).error, 'NOT_FOUND');
  const felixKit = createToolkit(ctxOf(db, 'felix'));
  assert.ok(JSON.parse(await felixKit.call('brainx_replay', { decision_id: dec })).recommendation);
});

test('brainx_profile 只读(无写入参数)', () => {
  const row = TOOL_ROWS.find((r) => r.name === 'brainx_profile');
  assert.ok(!row.parameters.properties || !('profile_keywords' in (row.parameters.properties || {})));
});

test('花名册是唯一跨人工具且只出名单', async () => {
  const db = openDb(':memory:');
  const toolkit = createToolkit(ctxOf(db, 'mia'));
  const roster = JSON.parse(await toolkit.call('brainx_consultants', {}));
  assert.ok(roster.length > 0);
  for (const c of roster) assert.deepEqual(Object.keys(c).sort(), ['consultant_id', 'display_name']);
});

// —— 循环检测 ——

test('同参同果第三次调用附纠偏提示', async () => {
  const toolkit = createToolkit(ctxOf(openDb(':memory:')));
  let last = '';
  for (let i = 0; i < 3; i++) last = await toolkit.call('brainx_consultants', {});
  assert.match(last, /改变策略/);
});

// —— 技能 ——

test('parseSkillFile 取 name/description/正文', () => {
  const parsed = parseSkillFile('---\nname: demo\ndescription: 演示技能\n---\n# 正文\n内容');
  assert.deepEqual({ ...parsed, body: undefined }, { name: 'demo', description: '演示技能', body: undefined });
  assert.match(parsed.body, /正文/);
  assert.equal(parseSkillFile('没有 frontmatter'), null);
  assert.equal(parseSkillFile('---\ndescription: 缺名\n---\nx'), null);
});

test('仓库 skills/ 发现 6 个 brainx 技能,加载与逃逸防护', () => {
  const index = discoverSkills({ includeGlobal: false });
  const names = [...index.keys()];
  for (const n of ['brainx-workbench', 'brainx-engagement', 'brainx-data-explorer', 'brainx-talent', 'brainx-ops', 'brainx-report']) {
    assert.ok(names.includes(n), `缺技能 ${n}`);
  }
  const skill = loadSkill(index, 'brainx-workbench');
  assert.match(skill.body, /brainx_workbench/);
  assert.ok(skill.body.length <= 20000);
  assert.equal(loadSkill(index, '../../etc/passwd'), null);
  assert.equal(loadSkill(index, 'no-such-skill'), null);
});

test('OpenClaw 安装集只引用当前精确白名单工具', () => {
  const index = discoverSkills({ includeGlobal: false });
  const installable = ['brainx-workbench', 'brainx-engagement', 'brainx-report', 'brainx-ops', 'brainx-talent'];
  const allowed = new Set(['brainx_workbench', 'brainx_recommendations', 'brainx_opportunity',
    'brainx_progress_suggestion', 'brainx_replay', 'brainx_push_preview', 'brainx_candidate_shortlist']);
  for (const name of installable) {
    const body = loadSkill(index, name).body;
    const referenced = body.match(/brainx_[a-z_]+/g) || [];
    for (const tool of referenced) assert.ok(allowed.has(tool), `${name} 引用了未开放工具 ${tool}`);
  }
});

test('全局技能加扫只收 brainx-* 前缀', () => {
  const index = discoverSkills({ includeGlobal: true });
  const globalOnes = [...index.values()].filter((s) => s.root === GLOBAL_SKILLS_DIR);
  for (const s of globalOnes) assert.ok(s.name.startsWith('brainx-'), `非 brainx 全局技能混入:${s.name}`);
});

// —— persona ——

test('persona 含 cid/写操作纪律/隔离规则/技能索引', () => {
  const index = discoverSkills({ includeGlobal: false });
  const prompt = buildSystemPrompt({ cid: 'felix', displayName: 'Felix 黄鑫', context: { page: 'today', sync_state: 'READY' }, skillIndex: index });
  assert.match(prompt, /felix/);
  assert.match(prompt, /不能执行任何写操作/);
  assert.match(prompt, /请同事本人登录后查询/);
  assert.match(prompt, /brainx-workbench/);
  assert.match(prompt, /"sync_state":"READY"/);
});

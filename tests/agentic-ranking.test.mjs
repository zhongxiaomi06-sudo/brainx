import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { updateProfile } from '../src/roster.js';
import { runAgenticRanking, replayAgenticRanking } from '../src/agentic-ranking.js';
import { registerContext } from '../src/context-registry.js';

const request = {
  tenantId: 'brainx', consultantId: 'felix', authorizationVersion: 'auth-v1',
};

function seededDb() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  updateProfile(db, 'felix', { profile_keywords: ['AI', '工程'], profile_note: 'A 测试画像' });
  return db;
}

function item(candidate, rank) {
  return {
    job_id: candidate.job_id,
    job_fact_version: candidate.job_fact_version,
    rank,
    decision_tier: 'TODAY',
    reason_codes: ['EXPLICIT_DIRECTION'],
    reason: `第 ${rank} 个 Agent 判断`,
    tradeoff: '与其他候选相比证据更直接',
    evidence_refs: [candidate.evidence_refs[0]],
    uncertainties: ['供给时效仍需确认'],
    suggested_next_action: '核对岗位现状后决定是否接单',
  };
}

function outputFor(input, candidates = input.candidates) {
  return {
    schema_version: 'agentic-ranking-v1', run_id: input.run_id, decision: 'RECOMMEND',
    items: candidates.map((candidate, index) => item(candidate, index + 1)),
    not_selected: [], missing_information: [], stop_reason: 'SUFFICIENT_EVIDENCE',
  };
}

const deps = (agentFn, extra = {}) => ({
  enabled: true, agentFn, modelId: 'test-model', providerId: 'test-provider',
  ...extra,
});

test('Algorithm A 默认关闭，关闭时不创建运行或调用模型', async () => {
  const db = seededDb();
  let called = false;
  const out = await runAgenticRanking(db, request, {
    agentFn: async () => { called = true; },
  });
  assert.equal(out.disabled, true);
  assert.equal(called, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agentic_ranking_runs').get().n, 0);
});

test('硬过滤在 Agent 前排除关闭、忽略、已承接、明确排除和容量超限', async () => {
  const db = seededDb();
  const ids = db.prepare(`SELECT project_id FROM job_memberships
    WHERE consultant_id='felix' AND valid_to IS NULL ORDER BY project_id LIMIT 5`)
    .all().map((row) => row.project_id);
  assert.equal(ids.length, 5);
  db.prepare('UPDATE job_facts SET active_state=\'CLOSED\' WHERE project_id=?').run(ids[0]);
  db.prepare(`INSERT INTO opportunity_ignores
    (consultant_id,project_id,idempotency_key,ignored_at) VALUES ('felix',?,?,'2026-09-23T00:00:00.000Z')`)
    .run(ids[1], `ignore:${ids[1]}`);
  db.prepare(`INSERT INTO decision_events
    (event_id,event_type,actor,occurred_at,project_id,idempotency_key,next_state)
    VALUES (?,'ACCEPTED','felix','2026-09-23T00:00:00.000Z',?,?,'ACCEPTED')`)
    .run(`accept:${ids[2]}`, ids[2], `accept:${ids[2]}`);
  const excludedCompany = db.prepare('SELECT company FROM job_facts WHERE project_id=?').get(ids[3]).company;
  const profile = JSON.parse(db.prepare(`SELECT profile_json FROM consultants
    WHERE consultant_id='felix'`).get().profile_json);
  profile.excluded_companies = [excludedCompany];
  db.prepare(`UPDATE consultants SET profile_json=? WHERE consultant_id='felix'`)
    .run(JSON.stringify(profile));
  updateProfile(db, 'felix', { profile_note: '加入明确排除' });

  let seen;
  const out = await runAgenticRanking(db, request, deps(async ({ input }) => {
    seen = input.candidates.map((candidate) => candidate.job_id);
    return { output: { schema_version: 'agentic-ranking-v1', run_id: input.run_id,
      decision: 'ABSTAIN', items: [], not_selected: [], missing_information: [],
      stop_reason: 'NO_SUITABLE_CANDIDATE' } };
  }));
  assert.equal(out.status, 'ABSTAINED');
  for (const id of ids.slice(0, 4)) assert.ok(!seen.includes(id), `${id} 应被硬过滤`);

  const profile2 = JSON.parse(db.prepare(`SELECT profile_json FROM consultants
    WHERE consultant_id='felix'`).get().profile_json);
  profile2.capacity_limit = 1;
  db.prepare(`UPDATE consultants SET profile_json=? WHERE consultant_id='felix'`)
    .run(JSON.stringify(profile2));
  updateProfile(db, 'felix', { profile_note: '容量已满' });
  let capacityCalled = false;
  const full = await runAgenticRanking(db, request, deps(async () => { capacityCalled = true; }));
  assert.equal(full.status, 'ABSTAINED');
  assert.equal(capacityCalled, false);
});

test('Agent 返回 B、A、C 就原序发布，合法不足量不补齐且不污染基线', async () => {
  const db = seededDb();
  const baselineBefore = db.prepare('SELECT COUNT(*) n FROM decision_runs').get().n;
  let expected;
  const out = await runAgenticRanking(db, request, deps(async ({ input }) => {
    const picked = [input.candidates[1], input.candidates[0], input.candidates[2]];
    expected = picked.map((candidate) => candidate.job_id);
    return { output: outputFor(input, picked), usage: {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    } };
  }));
  assert.equal(out.status, 'PUBLISHED');
  assert.deepEqual(out.items.map((row) => row.job_id), expected);
  assert.deepEqual(out.items.map((row) => row.rank), [1, 2, 3]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agentic_ranking_items WHERE run_id=?')
    .get(out.run_id).n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM decision_runs').get().n, baselineBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recommendations').get().n, 0);
});

test('只有 8 条合法 Agent 推荐时只保存 8 条', async () => {
  const db = seededDb();
  const out = await runAgenticRanking(db, request, deps(async ({ input }) => {
    assert.ok(input.candidates.length >= 8);
    return { output: outputFor(input, input.candidates.slice(0, 8)) };
  }));
  assert.equal(out.items.length, 8);
});

test('伪证据和重复职位不发布，最多修复两次且每次计入用量', async () => {
  const db = seededDb();
  let calls = 0;
  const repaired = await runAgenticRanking(db, request, deps(async ({ input, validationErrors }) => {
    calls += 1;
    if (!validationErrors.length) {
      const invalid = outputFor(input, [input.candidates[0], input.candidates[0]]);
      invalid.items[0].evidence_refs = ['fake:evidence'];
      return { output: invalid };
    }
    return { output: outputFor(input, input.candidates.slice(0, 2)) };
  }));
  assert.equal(repaired.status, 'PUBLISHED');
  assert.equal(repaired.repair_count, 1);
  assert.equal(calls, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_usage_calls WHERE run_id=?')
    .get(repaired.run_id).n, 2);

  const failed = await runAgenticRanking(db, request, deps(async ({ input }) => {
    const invalid = outputFor(input, [input.candidates[0], input.candidates[0]]);
    return { output: invalid };
  }));
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failure_code, 'OUTPUT_VALIDATION_FAILED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agentic_ranking_items WHERE run_id=?')
    .get(failed.run_id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_usage_calls WHERE run_id=?')
    .get(failed.run_id).n, 3);
});

test('没有最终 JSON、取消或预算耗尽都不产生 A 推荐', async () => {
  const db = seededDb();
  const noOutput = await runAgenticRanking(db, request, deps(async () => ({ output: null })));
  assert.equal(noOutput.status, 'FAILED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agentic_ranking_items WHERE run_id=?')
    .get(noOutput.run_id).n, 0);

  const cancelled = await runAgenticRanking(db, request, deps(async () => {
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  }));
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(db.prepare('SELECT status FROM agent_usage_calls WHERE run_id=?')
    .get(cancelled.run_id).status, 'CANCELLED');

  const budgeted = await runAgenticRanking(db, { ...request, budget: { maxCalls: 1 } },
    deps(async ({ input }) => ({ output: { ...outputFor(input, [input.candidates[0]]),
      run_id: 'wrong-run' } })));
  assert.equal(budgeted.status, 'FAILED');
  assert.equal(budgeted.failure_code, 'AGENT_BUDGET_EXHAUSTED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agentic_ranking_items WHERE run_id=?')
    .get(budgeted.run_id).n, 0);
});

test('Agent 可合法弃权，保存 ABSTAINED 且无推荐项', async () => {
  const db = seededDb();
  const out = await runAgenticRanking(db, request, deps(async ({ input }) => ({ output: {
    schema_version: 'agentic-ranking-v1', run_id: input.run_id, decision: 'ABSTAIN',
    items: [], not_selected: [], missing_information: ['供给证据不足'],
    stop_reason: 'INSUFFICIENT_EVIDENCE',
  } })));
  assert.equal(out.status, 'ABSTAINED');
  assert.equal(out.items.length, 0);
});

test('授权 Context Registry 内容只在运行时交给 Agent，账本只保存引用', async () => {
  const db = seededDb();
  const context = registerContext(db, {
    tenantId: 'brainx', consultantId: 'felix', purpose: 'ranking',
    sourceType: 'document', sourceId: 'ranking-note', sourceVersion: 'v1',
    summary: '本轮补充上下文', content: { direction: 'AI 基础设施' },
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const out = await runAgenticRanking(db, request, deps(async ({ input, registeredContexts }) => {
    assert.deepEqual(input.context_refs, [context.context_id]);
    assert.equal(registeredContexts[0].content.direction, 'AI 基础设施');
    return { output: outputFor(input, input.candidates.slice(0, 1)) };
  }, { contextRefs: [context.context_id] }));
  assert.equal(out.status, 'PUBLISHED');
  assert.deepEqual(JSON.parse(db.prepare(`SELECT context_refs_json FROM agent_usage_calls
    WHERE run_id=?`).get(out.run_id).context_refs_json), [context.context_id]);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM agent_run_context_refs WHERE run_id=?`)
    .get(out.run_id).n, 1);
  assert.doesNotMatch(db.prepare(`SELECT input_json FROM agentic_ranking_runs WHERE run_id=?`)
    .get(out.run_id).input_json, /AI 基础设施/);
});

test('发布前新增忽略使运行 STALE，不保存旧判断', async () => {
  const db = seededDb();
  const out = await runAgenticRanking(db, request, deps(async ({ input }) => {
    const selected = input.candidates[0];
    db.prepare(`INSERT INTO opportunity_ignores
      (consultant_id,project_id,idempotency_key,ignored_at) VALUES ('felix',?,?,'2026-09-23T00:00:00.000Z')`)
      .run(selected.job_id, `late-ignore:${selected.job_id}`);
    return { output: outputFor(input, [selected]) };
  }));
  assert.equal(out.status, 'STALE');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agentic_ranking_items WHERE run_id=?')
    .get(out.run_id).n, 0);
});

test('发布前授权版本变化使运行 STALE', async () => {
  const db = seededDb();
  const out = await runAgenticRanking(db, request, deps(async ({ input }) => ({
    output: outputFor(input, input.candidates.slice(0, 1)),
  }), { currentAuthorizationVersionFn: () => 'auth-v2' }));
  assert.equal(out.status, 'STALE');
  assert.equal(out.failure_code, 'STALE_AUTHORIZATION');
  assert.equal(out.items.length, 0);
});

test('两个运行乱序完成时旧 generation 不能覆盖新结果', async () => {
  const db = seededDb();
  let newer;
  const older = await runAgenticRanking(db, request, deps(async ({ input }) => {
    newer = await runAgenticRanking(db, request, deps(async ({ input: next }) => ({
      output: outputFor(next, next.candidates.slice(0, 2)),
    })));
    return { output: outputFor(input, input.candidates.slice(0, 2)) };
  }));
  assert.equal(newer.status, 'PUBLISHED');
  assert.equal(older.status, 'STALE');
  assert.ok(newer.generation > older.generation);
});

test('决策回放只读冻结输入和 Agent 输出，不再次调用模型', async () => {
  const db = seededDb();
  let calls = 0;
  const published = await runAgenticRanking(db, request, deps(async ({ input }) => {
    calls += 1;
    return { output: outputFor(input, input.candidates.slice(0, 2)) };
  }));
  const replay = replayAgenticRanking(db, {
    tenantId: 'brainx', consultantId: 'felix', runId: published.run_id,
  });
  assert.equal(calls, 1);
  assert.equal(replay.run.status, 'PUBLISHED');
  assert.deepEqual(replay.items.map((row) => row.job_id),
    published.items.map((row) => row.job_id));
  assert.equal(replay.input.run_id, published.run_id);
});

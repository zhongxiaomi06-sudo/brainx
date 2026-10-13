import test from 'node:test';
import assert from 'node:assert/strict';
import { internalFirst } from '../src/agent-gateway/search-internal-first.js';
import { createSourcingToolHandlers } from '../src/agent-gateway/tools-sourcing.js';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { engage } from '../src/engagement.js';

test('内部查询区分命中、空、不可用和自由条件缺接口，不伪造零命中', async () => {
  assert.equal((await internalFirst(null, 'P1', {})).status, 'unavailable');
  assert.equal((await internalFirst(() => assert.fail(), '', {})).status, 'not_supported');
  assert.equal((await internalFirst(async () => { throw new Error('secret'); }, 'P1', {})).status, 'unavailable');
  assert.equal((await internalFirst(async () => ({ data: { items: [] } }), 'P1', {})).status, 'empty');
  const matched = await internalFirst(async () => ({ data: { items_count: 2, card_delivered: true } }), 'P1', {});
  assert.equal(matched.count, 2); assert.equal(matched.card_delivered, true);
});
test('通过权限与续搜检查后才查内部；读回终态不重复查库', async t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const id = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  const context = { principal: { consultantId: 'felix', tenantId: 't', chatType: 'p2p', purpose: 'candidate_review' } };
  let calls = 0;
  const tools = createSourcingToolHandlers({ db, internalShortlistFn: async args => {
    calls++; assert.equal(args.job_id, id);
    assert.equal(db.prepare('SELECT count(*) n FROM openmai_results').get().n, 0, '先内部后外部');
    return { data: { items: [] } };
  } });
  await assert.rejects(() => tools.brainx_openmai_search({ job_id: 'other' }, context));
  assert.equal(calls, 0);
  engage(db, 'felix', id, 'ACCEPT', { confirm: true, idempotency_key: 'internal-test' });
  const out = await tools.brainx_openmai_search({ job_id: id }, context);
  assert.equal(out.data.internal_shortlist.status, 'empty');
  await tools.brainx_openmai_search({ job_id: id }, context);
  assert.equal(calls, 1);
});

/** hub-dispatcher.test.mjs — specs/019 US2：消费异步派发、错误可调度（测试先行）。
 *
 * 权威契约: specs/019-hub-event-backbone/contracts/event-types.md（消费者注册契约）；
 * 判定要点：注册表驱动派发、恰好一次、失败重试→死信→可重放、故障隔离、
 * prepare/apply 两段式（prepare 抛错零业务写入）、新注册消费者收存量。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerDb, emitTestEvent, eventsByType, countEvents } from './helpers/event-ledger.js';
import { dispatchOnce, replayConsumerFailure, defaultConsumers } from '../src/hub/dispatcher.js';
import { consumeOnceAsync } from '../src/hub/consumer.js';
import { registerChatContext } from '../src/gateway/chat-contexts.js';
import { processLarkEvent } from '../src/gateway/lark-gateway.js';

const msgEvent = (db, id, type = 'test.ping') => emitTestEvent(db, {
  event_type: type, idem_key: `test:${id}`, payload: { id },
});

test('US2: 未消费事件派发给注册消费者，恰好一次', async () => {
  const db = createLedgerDb();
  msgEvent(db, 'a');
  const seen = [];
  const consumer = {
    name: 'c1', eventTypes: ['test.ping'], maxRetries: 3,
    apply: (d, event) => seen.push(event.event_id),
  };
  await dispatchOnce(db, [consumer]);
  assert.equal(seen.length, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM processed_events WHERE consumer_name='c1'`).get().n, 1);

  await dispatchOnce(db, [consumer]);
  assert.equal(seen.length, 1, '重复派发不得重复消费');
});

test('US2: eventTypes 过滤——不匹配的事件不派发', async () => {
  const db = createLedgerDb();
  msgEvent(db, 'a', 'test.ping');
  msgEvent(db, 'b', 'test.other');
  const seen = [];
  await dispatchOnce(db, [{ name: 'c1', eventTypes: ['test.ping'], maxRetries: 3, apply: (d, e) => seen.push(e.event_id) }]);
  assert.equal(seen.length, 1);
});

test('US2: prepare/apply 两段式——异步 prepare 结果进入事务内 apply', async () => {
  const db = createLedgerDb();
  msgEvent(db, 'a');
  let applyGot = null;
  await dispatchOnce(db, [{
    name: 'c1', eventTypes: [], maxRetries: 3,
    prepare: async (event) => ({ echo: event.payload.id, async: true }),
    apply: (d, event, prepared) => { applyGot = prepared; },
  }]);
  assert.deepEqual(applyGot, { echo: 'a', async: true });
});

test('US2: prepare 抛错 → 零业务写入（无 processed 标记、无消费副作用）', async () => {
  const db = createLedgerDb();
  msgEvent(db, 'a');
  let applied = 0;
  await dispatchOnce(db, [{
    name: 'c1', eventTypes: [], maxRetries: 3,
    prepare: async () => { throw new Error('LLM_DOWN'); },
    apply: () => { applied += 1; },
  }]);
  assert.equal(applied, 0, 'prepare 失败不得进入 apply');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM processed_events WHERE consumer_name='c1'`).get().n, 0);
});

test('US2: apply 抛错 → 失败计数递增，达到 maxRetries 后死信跳过', async () => {
  const db = createLedgerDb();
  msgEvent(db, 'a');
  const consumer = {
    name: 'c1', eventTypes: [], maxRetries: 2,
    apply: () => { throw new Error('BOOM'); },
  };
  await dispatchOnce(db, [consumer]);
  await dispatchOnce(db, [consumer]);
  let f = db.prepare('SELECT * FROM consumer_failures WHERE consumer_name=?').get('c1');
  assert.equal(f.attempts, 2, '每轮失败递增计数');
  assert.match(f.last_error, /BOOM/);

  await dispatchOnce(db, [consumer]); // 已死信，不再调用
  f = db.prepare('SELECT * FROM consumer_failures WHERE consumer_name=?').get('c1');
  assert.equal(f.attempts, 2, '死信后不再重试');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM processed_events WHERE consumer_name='c1'`).get().n, 0);
});

test('US2: 故障隔离——消费者 A 持续失败不阻塞消费者 B 与账本', async () => {
  const db = createLedgerDb();
  msgEvent(db, 'a');
  const seenB = [];
  await dispatchOnce(db, [
    { name: 'bad', eventTypes: [], maxRetries: 1, apply: () => { throw new Error('A_DOWN'); } },
    { name: 'good', eventTypes: [], maxRetries: 1, apply: (d, e) => seenB.push(e.event_id) },
  ]);
  assert.equal(seenB.length, 1, 'B 不受 A 故障影响');
  assert.equal(countEvents(db, 'test.ping'), 1, '事件本体仍在账本');
});

test('US2: 死信重放——replayConsumerFailure 后补消费成功', async () => {
  const db = createLedgerDb();
  msgEvent(db, 'a');
  let fail = true;
  const seen = [];
  const consumer = {
    name: 'c1', eventTypes: [], maxRetries: 1,
    apply: (d, e) => { if (fail) throw new Error('DOWN'); seen.push(e.event_id); },
  };
  await dispatchOnce(db, [consumer]);
  await dispatchOnce(db, [consumer]); // 死信
  assert.equal(seen.length, 0);

  fail = false;
  replayConsumerFailure(db, ...(() => {
    const f = db.prepare('SELECT event_id FROM consumer_failures WHERE consumer_name=?').get('c1');
    return [f.event_id, 'c1'];
  })());
  await dispatchOnce(db, [consumer]);
  assert.equal(seen.length, 1, '重放后补消费成功');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM processed_events WHERE consumer_name='c1'`).get().n, 1);
});

test('US2: 新注册消费者收到存量未消费事件（backlog）', async () => {
  const db = createLedgerDb();
  emitTestEvent(db, { event_type: 'test.ping', idem_key: 'test:old-1',
    payload: { id: 'old-1' }, occurred_at: '2026-09-23T00:00:01.000Z' });
  emitTestEvent(db, { event_type: 'test.ping', idem_key: 'test:old-2',
    payload: { id: 'old-2' }, occurred_at: '2026-09-23T00:00:02.000Z' });
  const seen = [];
  await dispatchOnce(db, [{ name: 'late-joiner', eventTypes: [], maxRetries: 3, apply: (d, e) => seen.push(e.payload.id) }]);
  assert.deepEqual(seen, ['old-1', 'old-2'], '按发生时间顺序补消费存量');
});

test('US2: consumeOnceAsync 快速路径——已消费事件不调 prepare（省钱）', async () => {
  const db = createLedgerDb();
  const ev = msgEvent(db, 'a');
  let prepared = 0;
  const consumer = {
    name: 'c1', eventTypes: [],
    prepare: async () => { prepared += 1; },
    apply: () => {},
  };
  await consumeOnceAsync(db, ev.event.event_id, 'c1', consumer);
  await consumeOnceAsync(db, ev.event.event_id, 'c1', consumer);
  assert.equal(prepared, 1, '第二次直接短路，prepare 不再执行');
});

test('US2: 默认注册表——lark.message_received 经 dispatcher 产出双域草稿', async () => {
  const db = createLedgerDb();
  registerChatContext(db, { chat_id: 'oc_g', bot_mode: 'ALL' });
  processLarkEvent(db, {
    message_id: 'om_disp_1', chat_id: 'oc_g', open_id: 'ou_u',
    mentions: [], message_type: 'text',
    create_time: '2026-09-23T12:00:00+08:00',
    body: { text: '星曜科技说：不接受异地候选人，急招后端工程师，base 上海' },
  });
  const consumers = defaultConsumers();
  assert.deepEqual(consumers.map((c) => c.name), ['job-extract', 'judgment-extract']);
  await dispatchOnce(db, consumers);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 1, 'job 域草稿');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM judgment_drafts').get().n, 1, '判断域草稿');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM processed_events WHERE consumer_name='job-extract'`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM processed_events WHERE consumer_name='judgment-extract'`).get().n, 1);
});

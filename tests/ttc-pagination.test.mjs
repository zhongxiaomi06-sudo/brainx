import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAll } from '../src/ttcsdk/job.js';

const ok = (data) => ({ status: 200, ok: true, json: async () => ({ code: 0, data }) });
const requestBody = (options) => JSON.parse(options.body);

test('searchAll 拉完所有 cursor 页后才返回成功', async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(requestBody(options));
    return requests.length === 1
      ? ok({ jobs: [{ unique_id: 'a' }], has_more: true, cursor: 'next-1' })
      : ok({ jobs: [{ unique_id: 'b' }], has_more: false });
  };

  const jobs = await searchAll('jwt', { status: 1 }, fetchImpl, { maxPages: 3 });
  assert.deepEqual(jobs.map((job) => job.unique_id), ['a', 'b']);
  assert.deepEqual(requests, [
    { page: 1, status: 1 },
    { page: 1, status: 1, cursor: 'next-1' },
  ]);
});

test('searchAll 达到页数上限仍有下一页时拒绝返回残缺结果', async () => {
  let page = 0;
  const fetchImpl = async () => ok({ jobs: [{ unique_id: String(++page) }], has_more: true, cursor: `next-${page}` });

  await assert.rejects(
    searchAll('jwt', {}, fetchImpl, { maxPages: 2 }),
    (error) => error.code === 'TTC_PAGINATION_INCOMPLETE' && /达到 2 页安全上限/.test(error.message),
  );
  assert.equal(page, 2);
});

test('searchAll 对缺失或不前进的 cursor fail-fast', async (t) => {
  await t.test('缺失 cursor', async () => {
    await assert.rejects(
      searchAll('jwt', {}, async () => ok({ jobs: [], has_more: true }), { maxPages: 2 }),
      (error) => error.code === 'TTC_PAGINATION_INCOMPLETE' && /没有返回 cursor/.test(error.message),
    );
  });
  await t.test('cursor 重复', async () => {
    await assert.rejects(
      searchAll('jwt', { cursor: 'same' }, async () => ok({ jobs: [], has_more: true, cursor: 'same' }), { maxPages: 2 }),
      (error) => error.code === 'TTC_PAGINATION_INCOMPLETE' && /cursor 未前进/.test(error.message),
    );
  });
});

test('searchAll 拒绝无效 maxPages', async () => {
  await assert.rejects(searchAll('jwt', {}, async () => ok({ jobs: [] }), { maxPages: 0 }), /正整数/);
});

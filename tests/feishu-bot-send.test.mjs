import test from 'node:test';
import assert from 'node:assert/strict';
import { sendInteractiveCard } from '../src/feishu-bot.js';

const response = (body) => ({ ok: true, json: async () => body });

test('飞书机器人直连接口：获取 tenant token 后向 open_id 发送互动卡片', async () => {
  const calls = [];
  const out = await sendInteractiveCard({
    target: 'ou_test_user',
    card: { header: { title: { content: '今日推荐' } } },
    appId: 'cli_test',
    appSecret: 'test-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? response({ code: 0, tenant_access_token: 'tenant-test-token' })
        : response({ code: 0, data: { message_id: 'om_test' } });
    },
  });

  assert.equal(out.message_id, 'om_test');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /receive_id_type=open_id$/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer tenant-test-token');
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.receive_id, 'ou_test_user');
  assert.equal(body.msg_type, 'interactive');
  assert.deepEqual(JSON.parse(body.content), { header: { title: { content: '今日推荐' } } });
});

test('飞书机器人直连接口：缺凭证或非法目标时 fail-closed', async () => {
  await assert.rejects(
    sendInteractiveCard({ target: 'ou_test', card: {}, appId: '', appSecret: '' }),
    /FEISHU_BOT_CREDENTIALS_MISSING/,
  );
  await assert.rejects(
    sendInteractiveCard({ target: 'someone@example.com', card: {}, appId: 'cli_test', appSecret: 'secret' }),
    /FEISHU_TARGET_INVALID/,
  );
});

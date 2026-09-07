import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectChat, sendInteractiveCard, sendPdfFile } from '../src/feishu-bot.js';

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

test('飞书机器人直连接口：用 open_id 成员和当前机器人创建幂等项目群', async () => {
  const calls = [];
  const out = await createProjectChat({
    name: '海马云-PM',
    description: 'BrainTex 项目 J-1',
    ownerOpenId: 'ou_owner',
    memberOpenIds: ['ou_owner', 'ou_partner'],
    idempotencyKey: 'launch-j1-mia',
    appId: 'cli_test',
    appSecret: 'test-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? response({ code: 0, tenant_access_token: 'tenant-test-token' })
        : response({ code: 0, data: { chat_id: 'oc_project', name: '海马云-PM' } });
    },
  });

  assert.deepEqual(out, { chat_id: 'oc_project', name: '海马云-PM' });
  assert.match(calls[1].url, /\/open-apis\/im\/v1\/chats\?user_id_type=open_id/);
  assert.match(calls[1].url, /uuid=launch-j1-mia/);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.owner_id, 'ou_owner');
  assert.deepEqual(body.user_id_list, ['ou_owner', 'ou_partner']);
  assert.deepEqual(body.bot_id_list, ['cli_test']);
  assert.equal(body.chat_type, 'private');
});

test('飞书机器人直连接口：建群输入和飞书失败都显式报错', async () => {
  await assert.rejects(
    createProjectChat({ name: '', idempotencyKey: 'x', appId: 'a', appSecret: 'b' }),
    /FEISHU_CHAT_NAME_REQUIRED/,
  );
  await assert.rejects(
    createProjectChat({
      name: '职位群', ownerOpenId: 'bad-id', idempotencyKey: 'x', appId: 'a', appSecret: 'b',
    }),
    /FEISHU_CHAT_MEMBER_INVALID/,
  );
  let count = 0;
  await assert.rejects(
    createProjectChat({
      name: '职位群', ownerOpenId: 'ou_owner', idempotencyKey: 'x', appId: 'a', appSecret: 'b',
      fetchImpl: async () => (++count === 1
        ? response({ code: 0, tenant_access_token: 'token' })
        : response({ code: 230001, msg: 'no permission' })),
    }),
    /FEISHU_CHAT_CREATE_FAILED: no permission/,
  );
});

test('飞书机器人把 PDF 上传后以幂等文件消息发到项目群', async () => {
  const calls = [];
  const out = await sendPdfFile({
    target: 'oc_project', fileName: '张三-简历.pdf', data: Buffer.from('%PDF-1.7 test'),
    idempotencyKey: 'delivery-1-resume-1', appId: 'cli_test', appSecret: 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return response({ code: 0, tenant_access_token: 'token' });
      if (calls.length === 2) return response({ code: 0, data: { file_key: 'file-key-1' } });
      return response({ code: 0, data: { message_id: 'om_file' } });
    },
  });
  assert.deepEqual(out, { file_key: 'file-key-1', message_id: 'om_file' });
  assert.match(calls[1].url, /\/open-apis\/im\/v1\/files$/);
  assert.equal(calls[1].options.body.get('file_type'), 'stream');
  assert.equal(calls[1].options.body.get('file_name'), '张三-简历.pdf');
  assert.match(calls[2].url, /receive_id_type=chat_id&uuid=delivery-1-resume-1/);
  const sent = JSON.parse(calls[2].options.body);
  assert.equal(sent.msg_type, 'file');
  assert.deepEqual(JSON.parse(sent.content), { file_key: 'file-key-1' });
});

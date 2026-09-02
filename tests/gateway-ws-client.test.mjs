/** gateway-ws-client.test.mjs — SDK WS 客户端骨架凭证缺失优雅降级（测试先行）。
 *
 * 对应 specs/002-step1-lark-gateway/spec.md US5 + SC-005；
 * 实现为 src/gateway/ws-client.js 的 startGateway/stopGateway。
 * 不真实连接飞书 WS（需凭证 + 网络），只验证降级与参数校验路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { startGateway, stopGateway, getBotOpenId } from '../src/gateway/ws-client.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-step1-')), 'test.db'));

const origFetch = global.fetch;

test('SC-005: 无凭证 startGateway 返回 credentials_missing 不抛错', async () => {
  const db = newDb();
  const r = await startGateway({ db }); // 无 credentials
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'credentials_missing');
});

test('SC-005: 凭证缺 App ID 即视为未配置（credentials_missing）', async () => {
  const db = newDb();
  const r = await startGateway({ db, credentials: { appSecret: 'x', encryptKey: 'k' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'credentials_missing');
});

test('US5: 凭证完整但环境为 mock 模式不真实连接，返回 ready 标记', async () => {
  const db = newDb();
  const r = await startGateway({
    db,
    credentials: { appId: 'cli_x', appSecret: 'sec', encryptKey: 'ek', verificationToken: 'vt' },
    mode: 'mock', // 测试用：不真实 new WSClient，只校验参数与可启动性
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'mock');
  assert.equal(r.botOpenId, 'ou_bot', 'mock 模式回落测试约定值');
  stopGateway(); // 清理单例
});

test('修复 BOT_OPEN_ID: getBotOpenId 成功返回真实 open_id', async () => {
  global.fetch = async (url, opts) => {
    if (url.includes('tenant_access_token')) {
      return { json: async () => ({ tenant_access_token: 'tok_123' }) };
    }
    if (url.includes('bot/v3/info')) {
      return { json: async () => ({ code: 0, bot: { open_id: 'ou_real_bot_999' } }) };
    }
    throw new Error('unexpected ' + url);
  };
  const r = await getBotOpenId({ appId: 'cli_x', appSecret: 'sec' });
  global.fetch = origFetch;
  assert.equal(r.ok, true);
  assert.equal(r.openId, 'ou_real_bot_999');
});

test('修复 BOT_OPEN_ID: getBotOpenId tenant_access_token 缺失时显式失败不静默回落', async () => {
  global.fetch = async (url) => {
    if (url.includes('tenant_access_token')) {
      return { json: async () => ({ code: 99991661, msg: 'app_id or app_secret invalid' }) };
    }
    throw new Error('不应调到 bot/v3/info');
  };
  const r = await getBotOpenId({ appId: 'bad', appSecret: 'bad' });
  global.fetch = origFetch;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bot_info_failed');
});

test('修复 BOT_OPEN_ID: startGateway live 模式 getBotOpenId 失败时显式 bot_info_failed 不静默', async () => {
  global.fetch = async () => ({ json: async () => ({ code: 99991661 }) });
  const db = newDb();
  const r = await startGateway({
    db,
    credentials: { appId: 'cli_x', appSecret: 'sec', encryptKey: 'ek', verificationToken: 'vt' },
    mode: 'live',
  });
  global.fetch = origFetch;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bot_info_failed');
});

test('US5: stopGateway 无活动连接时安全空操作', () => {
  assert.doesNotThrow(() => stopGateway());
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { assistantRoutes } from '../src/assistant-routes.js';
import { suggestWeights } from '../src/weight-suggestion.js';

const request = (payload) => ({
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); },
});
const response = () => ({
  status: 0, text: '', destroyed: false,
  writeHead(status) { this.status = status; },
  end(chunk = '') { this.text += String(chunk); },
});

test('suggestWeights 通过统一 chatJson 生成六维且归一为 100%', async () => {
  let system = '';
  const result = await suggestWeights('多探索新机会', { chatJsonFn: async (systemPrompt) => {
    system = systemPrompt;
    return { weights: { exploration: 60, direction: 40 }, reply: '提高探索，同时保留方向匹配。' };
  } });
  assert.equal(Object.values(result.weights).reduce((sum, value) => sum + value, 0), 100);
  assert.ok(result.weights.exploration > result.weights.activity);
  assert.match(system, /六个权重/);
  assert.equal(result.reply, '提高探索，同时保留方向匹配。');
});

test('suggestWeights 拒绝模型返回的未知维度和空偏好', async () => {
  await assert.rejects(suggestWeights('', { chatJsonFn: async () => ({}) }), (error) => error.code === 'INVALID_PREFERENCE');
  await assert.rejects(
    suggestWeights('偏好', { chatJsonFn: async () => ({ weights: { vendor_secret: 100 } }) }),
    (error) => error.code === 'LLM_INVALID_RESPONSE',
  );
});

test('权重建议路由只使用服务器 LLM，不接收浏览器 API Key', async () => {
  const db = openDb(':memory:');
  let capturedUser = '';
  const routes = assistantRoutes(db, {
    isLlmConfiguredFn: () => true,
    chatJsonFn: async (_system, user) => {
      capturedUser = user;
      return { weights: { direction: 50, exploration: 50 }, reply: '建议已生成' };
    },
  });
  const res = response();
  await routes['POST /api/v1/assistant/weight-suggestion'](
    request({ preference: '重视方向', api_key: 'browser-secret-must-not-pass-through' }), res, 'felix',
  );
  assert.equal(res.status, 200);
  assert.equal(capturedUser, '重视方向');
  assert.doesNotMatch(capturedUser, /browser-secret/);
  assert.equal(JSON.parse(res.text).weights.direction > 0, true);
});

test('权重建议路由在服务器未配置 LLM 时明确返回 503', async () => {
  const routes = assistantRoutes(openDb(':memory:'), { isLlmConfiguredFn: () => false });
  const res = response();
  await routes['POST /api/v1/assistant/weight-suggestion'](request({ preference: '重视结果' }), res, 'felix');
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.text).error.code, 'LLM_NOT_CONFIGURED');
});

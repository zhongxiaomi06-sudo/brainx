import assert from 'node:assert/strict';
import test from 'node:test';
import { readFeishuDocument } from '../plugins/brainx-openclaw/doc-reader.js';

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('readFeishuDocument 用 tenant_access_token 拉文档纯文本', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'token-xyz' });
    if (url.includes('/raw_content')) return response({ code: 0, data: { content: '杨东旭意愿度 9/10' } });
    return response({ code: 0, data: {} });
  };
  const result = await readFeishuDocument({
    docId: 'TrFHdPfc3oXzyLxa2TRcVxQvn6b', appId: 'cli_test', appSecret: 'secret', fetchImpl,
  });
  assert.equal(result.document_id, 'TrFHdPfc3oXzyLxa2TRcVxQvn6b');
  assert.equal(result.content, '杨东旭意愿度 9/10');
  // token 端点要带 app_id + app_secret
  const tokenCall = calls[0];
  assert.match(tokenCall.url, /tenant_access_token\/internal/);
  assert.deepEqual(JSON.parse(tokenCall.options.body), { app_id: 'cli_test', app_secret: 'secret' });
  // 文档端点要带 Bearer token，路径含 docx token
  const docCall = calls[1];
  assert.match(docCall.url, /documents\/TrFHdPfc3oXzyLxa2TRcVxQvn6b\/raw_content/);
  // HTTP header 名不区分大小写，但 JS 对象属性区分；代码写的是 Authorization（大写 A）
  const authHeader = docCall.options.headers.Authorization || docCall.options.headers.authorization;
  assert.equal(authHeader, 'Bearer token-xyz');
});

test('readFeishuDocument 缺 docId 直接报错不调 API', async () => {
  await assert.rejects(() => readFeishuDocument({ appId: 'a', appSecret: 'b' }), /FEISHU_DOC_ID_REQUIRED/);
});

test('readFeishuDocument 飞书返回非零 code 时抛 FEISHU_DOC_READ_FAILED（含飞书 msg）', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'tok' });
    // 飞书权限不足的典型返回
    return response({ code: 99991661, msg: 'permission denied: docx:document:readonly' });
  };
  await assert.rejects(
    () => readFeishuDocument({ docId: 'doc_x', appId: 'a', appSecret: 'b', fetchImpl }),
    /FEISHU_DOC_READ_FAILED.*docx:document:readonly/,
  );
});

test('readFeishuDocument HTTP 非 200 + 非 JSON 体报 RESPONSE_INVALID', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'tok' });
    return new Response('Not Found', { status: 404 });
  };
  await assert.rejects(
    () => readFeishuDocument({ docId: 'doc_x', appId: 'a', appSecret: 'b', fetchImpl }),
    /FEISHU_DOC_READ_RESPONSE_INVALID/,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeishuDocument } from '../src/feishu-document.js';

const response = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('飞书报告先建文档再批量写入标题与正文块', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'token' });
    if (url.endsWith('/documents')) return response({ code: 0, data: { document: { document_id: 'doc_1' } } });
    return response({ code: 0, data: {} });
  };
  const result = await createFeishuDocument({ title: '报告', sections: [
    { title: '摘要', paragraphs: ['只写已验证事实'] },
  ], docBaseUrl: 'https://tenant.feishu.cn', appId: 'cli_test', appSecret: 'secret', fetchImpl });
  assert.deepEqual(result, { document_id: 'doc_1', document_url: 'https://tenant.feishu.cn/docx/doc_1' });
  assert.match(calls[2].url, /documents\/doc_1\/blocks\/doc_1\/children/);
  const body = JSON.parse(calls[2].options.body);
  assert.deepEqual(body.children.map((item) => item.block_type), [4, 2]);
});

test('飞书报告地址只接受租户 HTTPS 域名', async () => {
  await assert.rejects(() => createFeishuDocument({ title: '报告', sections: [],
    docBaseUrl: 'https://evil.example', appId: 'a', appSecret: 'b' }), /FEISHU_DOC_BASE_URL_INVALID/);
});

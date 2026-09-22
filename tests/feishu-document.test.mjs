import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendFeishuDocumentSections,
  createFeishuDocument,
  readFeishuDocument,
  textFromFeishuBlocks,
} from '../src/feishu-document.js';

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
  // 建文档后必须放开「组织内链接可编辑」，否则群成员打不开报告。
  assert.match(calls[3].url, /permissions\/doc_1\/public\?type=docx/);
  assert.equal(calls[3].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[3].options.body), { link_share_entity: 'tenant_editable' });
});

test('飞书报告地址只接受租户 HTTPS 域名', async () => {
  await assert.rejects(() => createFeishuDocument({ title: '报告', sections: [],
    docBaseUrl: 'https://evil.example', appId: 'a', appSecret: 'b' }), /FEISHU_DOC_BASE_URL_INVALID/);
});

test('读取飞书报告正文会分页并保留用户编辑后的文本', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'token' });
    if (!url.includes('page_token=')) return response({ code: 0, data: { items: [
      { block_type: 4, heading2: { elements: [{ text_run: { content: '决策摘要' } }] } },
      { block_type: 2, text: { elements: [{ text_run: { content: '用户编辑：最看重成长路径' } }] } },
    ], has_more: true, page_token: 'next' } });
    return response({ code: 0, data: { items: [
      { block_type: 12, bullet: { elements: [{ text_run: { content: '需要明确晋升标准' } }] } },
    ], has_more: false } });
  };
  const result = await readFeishuDocument({ documentId: 'doc_1', appId: 'id', appSecret: 'secret', fetchImpl });
  assert.equal(result.content, '决策摘要\n用户编辑：最看重成长路径\n需要明确晋升标准');
  assert.equal(calls.filter((url) => url.includes('/blocks?')).length, 2);
  assert.match(calls.at(-1), /page_token=next/);
});

test('同一飞书报告可追加新证据且文本块提取忽略非正文元数据', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'token' });
    return response({ code: 0, data: {} });
  };
  await appendFeishuDocumentSections({ documentId: 'doc_1', sections: [
    { title: '新增证据', paragraphs: ['候选人确认到岗时间'] },
  ], appId: 'id', appSecret: 'secret', fetchImpl });
  const body = JSON.parse(calls.at(-1).options.body);
  assert.deepEqual(body.children.map((item) => item.block_type), [4, 2]);
  assert.equal(textFromFeishuBlocks([{ block_id: 'secret-id', text: {
    elements: [{ text_run: { content: '只保留正文' } }],
  } }]), '只保留正文');
});

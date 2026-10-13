/** 使用企业自建应用身份创建只含脱敏业务事实的飞书云文档。
 *  创建后统一放开「组织内获得链接的人可编辑」（link_share_entity=tenant_editable），
 *  保证决策群成员点开报告即可查看与协作编辑；放开失败必须报错，不允许生成只有机器人能看的报告。
 *
 *  readFeishuDocument（2026-09-16 新增）：用 tenant_access_token 拉文档纯文本，
 *  供 Offer 决策群小机器人把用户改后的报告正文作为对话背景上下文。权限要求
 *  docx:document:readonly（或 docx:document），缺 scope 会 403；调用方负责降级。 */
import { getTenantAccessToken } from './feishu-bot.js';

const BASE = 'https://open.feishu.cn';
const textRun = (content) => ({ text_run: { content: String(content || '') } });
const block = (blockType, key, content) => ({
  block_type: blockType,
  [key]: { elements: [textRun(content)] },
});
const TEXT_BLOCK_KEYS = [
  'text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5',
  'heading6', 'heading7', 'heading8', 'heading9', 'bullet', 'ordered',
  'quote', 'todo', 'code', 'callout',
];

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function safeDocBase(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.feishu.cn')) {
    throw new Error('FEISHU_DOC_BASE_URL_INVALID');
  }
  return url.origin;
}

async function json(response, fallback) {
  try { return await response.json(); } catch { throw new Error(fallback); }
}

function sectionChildren(sections) {
  const children = [];
  for (const section of sections || []) {
    children.push(block(4, 'heading2', section.title));
    for (const paragraph of section.paragraphs || []) children.push(block(2, 'text', paragraph));
  }
  return children;
}

async function appendChildren({ documentId, children, token, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(
    `${BASE}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children?document_revision_id=-1`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ children, index: -1 }), signal: AbortSignal.timeout(timeoutMs) },
  );
  const body = await json(response, 'FEISHU_DOC_APPEND_RESPONSE_INVALID');
  if (response.ok === false || body.code !== 0) {
    throw coded(`FEISHU_DOC_APPEND_FAILED: ${String(body.msg || body.code || 'unknown').slice(0, 160)}`,
      'FEISHU_DOC_APPEND_FAILED');
  }
}

async function makeDocumentTenantEditable({ documentId, token, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(
    `${BASE}/open-apis/drive/v1/permissions/${encodeURIComponent(documentId)}/public?type=docx`,
    { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_share_entity: 'tenant_editable' }),
      signal: AbortSignal.timeout(timeoutMs) },
  );
  const body = await json(response, 'FEISHU_DOC_PERMISSION_RESPONSE_INVALID');
  if (response.ok === false || body.code !== 0) {
    throw coded(`FEISHU_DOC_PERMISSION_FAILED: ${String(body.msg || body.code || 'unknown').slice(0, 160)}`,
      'FEISHU_DOC_PERMISSION_FAILED');
  }
}

export function textFromFeishuBlocks(blocks) {
  const lines = [];
  for (const item of blocks || []) {
    for (const key of TEXT_BLOCK_KEYS) {
      const elements = item?.[key]?.elements;
      if (!Array.isArray(elements)) continue;
      const line = elements.map((element) => element?.text_run?.content || '').join('').trim();
      if (line) lines.push(line);
    }
  }
  return lines.join('\n');
}

export async function createFeishuDocument({ title, sections, fetchImpl = globalThis.fetch,
  docBaseUrl = process.env.BRAINX_FEISHU_DOC_BASE_URL, appId, appSecret, timeoutMs = 15_000 }) {
  const baseUrl = safeDocBase(docBaseUrl);
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });
  const createdResponse = await fetchImpl(`${BASE}/open-apis/docx/v1/documents`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: String(title || '').slice(0, 200) }), signal: AbortSignal.timeout(timeoutMs),
  });
  const created = await json(createdResponse, 'FEISHU_DOC_CREATE_RESPONSE_INVALID');
  const documentId = created.data?.document?.document_id;
  if (createdResponse.ok === false || created.code !== 0 || !documentId) {
    throw new Error(`FEISHU_DOC_CREATE_FAILED: ${String(created.msg || created.code || 'unknown').slice(0, 160)}`);
  }
  await appendChildren({ documentId, children: sectionChildren(sections), token, fetchImpl, timeoutMs });
  await makeDocumentTenantEditable({ documentId, token, fetchImpl, timeoutMs });
  return { document_id: documentId, document_url: `${baseUrl}/docx/${documentId}` };
}

export async function appendFeishuDocumentSections({ documentId, sections, fetchImpl = globalThis.fetch,
  appId, appSecret, timeoutMs = 15_000 }) {
  if (!String(documentId || '').trim()) throw coded('FEISHU_DOC_ID_REQUIRED', 'INVALID_ARGUMENT');
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });
  await appendChildren({ documentId, children: sectionChildren(sections), token, fetchImpl, timeoutMs });
  return { document_id: documentId };
}

export async function readFeishuDocument({ documentId, docId, fetchImpl = globalThis.fetch,
  appId, appSecret, timeoutMs = 15_000 }) {
  const resolvedId = String(documentId || docId || '').trim();
  if (!resolvedId) throw coded('FEISHU_DOC_ID_REQUIRED', 'INVALID_ARGUMENT');
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });
  if (docId && !documentId) {
    const response = await fetchImpl(
      `${BASE}/open-apis/docx/v1/documents/${encodeURIComponent(resolvedId)}/raw_content`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) },
    );
    const body = await json(response, 'FEISHU_DOC_READ_RESPONSE_INVALID');
    if (response.ok === false || body.code !== 0) {
      throw coded(`FEISHU_DOC_READ_FAILED: ${String(body.msg || body.code || 'unknown').slice(0, 160)}`,
        'FEISHU_DOC_READ_FAILED');
    }
    return { content: String(body.data?.content || ''), document_id: resolvedId };
  }
  const items = [];
  let pageToken = '';
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ page_size: '500', document_revision_id: '-1' });
    if (pageToken) query.set('page_token', pageToken);
    const response = await fetchImpl(
      `${BASE}/open-apis/docx/v1/documents/${encodeURIComponent(resolvedId)}/blocks?${query}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) },
    );
    const body = await json(response, 'FEISHU_DOC_READ_RESPONSE_INVALID');
    if (response.ok === false || body.code !== 0 || !Array.isArray(body.data?.items)) {
      throw coded(`FEISHU_DOC_READ_FAILED: ${String(body.msg || body.code || 'unknown').slice(0, 160)}`,
        'FEISHU_DOC_READ_FAILED');
    }
    items.push(...body.data.items);
    if (!body.data.has_more) break;
    pageToken = String(body.data.page_token || '');
    if (!pageToken || page === 19) throw coded('FEISHU_DOC_READ_INCOMPLETE', 'FEISHU_DOC_READ_FAILED');
  }
  return { document_id: resolvedId, content: textFromFeishuBlocks(items) };
}

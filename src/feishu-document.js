/** 使用企业自建应用身份创建只含脱敏业务事实的飞书云文档。 */
import { getTenantAccessToken } from './feishu-bot.js';

const BASE = 'https://open.feishu.cn';
const textRun = (content) => ({ text_run: { content: String(content || '') } });
const block = (blockType, key, content) => ({
  block_type: blockType,
  [key]: { elements: [textRun(content)] },
});

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
  const children = [];
  for (const section of sections || []) {
    children.push(block(4, 'heading2', section.title));
    for (const paragraph of section.paragraphs || []) children.push(block(2, 'text', paragraph));
  }
  const appendResponse = await fetchImpl(
    `${BASE}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children?document_revision_id=-1`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ children, index: -1 }), signal: AbortSignal.timeout(timeoutMs) },
  );
  const appended = await json(appendResponse, 'FEISHU_DOC_APPEND_RESPONSE_INVALID');
  if (appendResponse.ok === false || appended.code !== 0) {
    throw new Error(`FEISHU_DOC_APPEND_FAILED: ${String(appended.msg || appended.code || 'unknown').slice(0, 160)}`);
  }
  return { document_id: documentId, document_url: `${baseUrl}/docx/${documentId}` };
}

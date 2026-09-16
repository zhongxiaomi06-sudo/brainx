/** 群级特殊背景文档读取器：调飞书 raw_content API 拉文档纯文本。
 *
 *  自包含 tenant_access_token 获取（不跨目录引用 src/），避免 npm pack 丢文件
 *  （test 449 契约：plugin package ships every locally imported module）。
 *  仅供 plugins/brainx-openclaw/prompt.js 的 preloadSpecialGroupDoc 使用。
 *
 *  失败抛错，调用方负责降级。权限要求 docx:document:readonly（或 docx:document）。 */
const FEISHU_BASE = 'https://open.feishu.cn';

async function json(response, fallback) {
  try { return await response.json(); }
  catch { throw new Error(fallback); }
}

let tokenCache = null;

async function getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs }) {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.value;
  const response = await fetchImpl(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await json(response, 'FEISHU_TOKEN_RESPONSE_INVALID');
  if (body.code !== 0) throw new Error(`FEISHU_TOKEN_FAILED:${body.code}`);
  tokenCache = { value: body.tenant_access_token, expiresAt: Date.now() + 110 * 1000 };
  return tokenCache.value;
}

/** 读取飞书 docx 文档纯文本。用 raw_content API（结构扁平化但内容完整），
 *  足够作为对话背景；表格会被展平为换行文本。docId 必须是飞书 docx token
 *  （/docx/<token> 路径里的 token）。 */
export async function readFeishuDocument({ docId, fetchImpl = globalThis.fetch,
  appId, appSecret, timeoutMs = 15_000 }) {
  if (!docId) throw new Error('FEISHU_DOC_ID_REQUIRED');
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });
  const response = await fetchImpl(
    `${FEISHU_BASE}/open-apis/docx/v1/documents/${encodeURIComponent(docId)}/raw_content`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) },
  );
  const body = await json(response, 'FEISHU_DOC_READ_RESPONSE_INVALID');
  if (response.ok === false || body.code !== 0) {
    throw new Error(`FEISHU_DOC_READ_FAILED: ${String(body.msg || body.code || 'unknown').slice(0, 160)}`);
  }
  return { content: String(body.data?.content || ''), document_id: docId };
}

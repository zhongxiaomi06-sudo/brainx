/** feishu-bot.js — 使用企业自建应用身份发送飞书互动卡片。 */

const FEISHU_BASE = 'https://open.feishu.cn';

const safeMessage = (body, fallback) => String(body?.msg || body?.message || fallback).slice(0, 200);

async function readJson(response, fallback) {
  try {
    return await response.json();
  } catch {
    throw new Error(fallback);
  }
}

/**
 * 直接使用飞书开放接口发卡，不依赖本机 lark-cli。
 * target 只接受 open_id（ou_）或 chat_id（oc_）；自动推送调用方只传顾问 open_id。
 */
export async function sendInteractiveCard({
  target,
  card,
  appId = process.env.BRAINX_FEISHU_APP_ID || process.env.LARK_APP_ID,
  appSecret = process.env.BRAINX_FEISHU_APP_SECRET || process.env.LARK_APP_SECRET,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  if (!appId || !appSecret) throw new Error('FEISHU_BOT_CREDENTIALS_MISSING');
  if (!/^(ou|oc)_[A-Za-z0-9_-]+$/.test(String(target || ''))) {
    throw new Error('FEISHU_TARGET_INVALID');
  }

  const tokenResponse = await fetchImpl(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const tokenBody = await readJson(tokenResponse, 'FEISHU_TOKEN_RESPONSE_INVALID');
  if (tokenResponse.ok === false || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
    throw new Error(`FEISHU_TOKEN_FAILED: ${safeMessage(tokenBody, tokenBody.code ?? 'unknown')}`);
  }

  const receiveIdType = String(target).startsWith('oc_') ? 'chat_id' : 'open_id';
  const sendResponse = await fetchImpl(
    `${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenBody.tenant_access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: target,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const sendBody = await readJson(sendResponse, 'FEISHU_SEND_RESPONSE_INVALID');
  if (sendResponse.ok === false || sendBody.code !== 0) {
    throw new Error(`FEISHU_SEND_FAILED: ${safeMessage(sendBody, sendBody.code ?? 'unknown')}`);
  }
  return { message_id: sendBody.data?.message_id || null };
}

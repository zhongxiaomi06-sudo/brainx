/** feishu-bot.js — 使用企业自建应用身份发送飞书互动卡片。 */

import { readFileSync } from 'node:fs';

const FEISHU_BASE = 'https://open.feishu.cn';

const safeMessage = (body, fallback) => String(body?.msg || body?.message || fallback).slice(0, 200);

function feishuCredentials(appId, appSecret) {
  if (appId !== undefined || appSecret !== undefined) return { appId, appSecret };
  if (process.env.BRAINX_FEISHU_CREDENTIALS_FROM_OPENCLAW === '1') {
    try {
      const feishu = JSON.parse(readFileSync(process.env.BRAINX_OPENCLAW_CONFIG_PATH, 'utf8'))
        .channels?.feishu;
      // 凭证有两种落法：本机开发配置写顶层 appId/appSecret；生产 openclaw.json
      // 写在 accounts 表里（defaultAccount 指向的账号，如 accounts.mia）。
      // 生产值还是 ${VAR} 环境引用形态（OpenClaw 启动时才插值），必须按进程环境解析。
      const account = feishu?.accounts?.[feishu?.defaultAccount || 'mia'];
      const resolve = (value) => {
        const match = /^\$\{([A-Z0-9_]+)\}$/.exec(String(value || ''));
        return match ? process.env[match[1]] : value;
      };
      return {
        appId: feishu?.appId || resolve(account?.appId),
        appSecret: feishu?.appSecret || resolve(account?.appSecret),
      };
    } catch {
      return { appId: undefined, appSecret: undefined };
    }
  }
  return {
    appId: process.env.BRAINX_FEISHU_APP_ID || process.env.LARK_APP_ID,
    appSecret: process.env.BRAINX_FEISHU_APP_SECRET || process.env.LARK_APP_SECRET,
  };
}

async function readJson(response, fallback) {
  try {
    return await response.json();
  } catch {
    throw new Error(fallback);
  }
}

export async function getTenantAccessToken({
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  ({ appId, appSecret } = feishuCredentials(appId, appSecret));
  if (!appId || !appSecret) throw new Error('FEISHU_BOT_CREDENTIALS_MISSING');
  const response = await fetchImpl(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(response, 'FEISHU_TOKEN_RESPONSE_INVALID');
  if (response.ok === false || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`FEISHU_TOKEN_FAILED: ${safeMessage(body, body.code ?? 'unknown')}`);
  }
  return body.tenant_access_token;
}

/**
 * 使用应用身份创建职位项目群。uuid 由业务层提供，飞书据此避免网络重试重复建群。
 * 创建时显式把当前应用机器人加入群，成员统一使用 open_id。
 */
export async function createProjectChat({
  name,
  description = '',
  ownerOpenId,
  memberOpenIds = [],
  botAppIds,
  idempotencyKey,
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  ({ appId, appSecret } = feishuCredentials(appId, appSecret));
  const title = String(name || '').trim();
  if (!title) throw new Error('FEISHU_CHAT_NAME_REQUIRED');
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('FEISHU_CHAT_IDEMPOTENCY_KEY_REQUIRED');
  }
  const members = [...new Set([ownerOpenId, ...memberOpenIds].filter(Boolean))];
  if (members.some((id) => !/^ou_[A-Za-z0-9_-]+$/.test(String(id)))) {
    throw new Error('FEISHU_CHAT_MEMBER_INVALID');
  }
  const bots = [...new Set((botAppIds || [appId]).filter(Boolean))];
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });
  const response = await fetchImpl(
    `${FEISHU_BASE}/open-apis/im/v1/chats?user_id_type=open_id&set_bot_manager=true&uuid=${encodeURIComponent(idempotencyKey)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: title.slice(0, 100),
        description: String(description || '').slice(0, 100),
        owner_id: ownerOpenId || undefined,
        user_id_list: members,
        bot_id_list: bots,
        group_message_type: 'chat',
        chat_mode: 'group',
        chat_type: 'private',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const body = await readJson(response, 'FEISHU_CHAT_CREATE_RESPONSE_INVALID');
  if (response.ok === false || body.code !== 0 || !body.data?.chat_id) {
    throw new Error(`FEISHU_CHAT_CREATE_FAILED: ${safeMessage(body, body.code ?? 'unknown')}`);
  }
  return { chat_id: body.data.chat_id, name: body.data.name || title };
}

/**
 * 直接使用飞书开放接口发卡，不依赖本机 lark-cli。
 * target 只接受 open_id（ou_）或 chat_id（oc_）；自动推送调用方只传顾问 open_id。
 */
export async function sendInteractiveCard({
  target,
  card,
  idempotencyKey,
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  ({ appId, appSecret } = feishuCredentials(appId, appSecret));
  if (!appId || !appSecret) throw new Error('FEISHU_BOT_CREDENTIALS_MISSING');
  if (!/^(ou|oc)_[A-Za-z0-9_-]+$/.test(String(target || ''))) {
    throw new Error('FEISHU_TARGET_INVALID');
  }

  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });

  const receiveIdType = String(target).startsWith('oc_') ? 'chat_id' : 'open_id';
  const uuidQuery = idempotencyKey ? `&uuid=${encodeURIComponent(idempotencyKey)}` : '';
  const sendResponse = await fetchImpl(
    `${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}${uuidQuery}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
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

/** 列出机器人当前所在的全部群（specs/015 入群轮询用）。翻页直到 has_more=false。 */
export async function listBotChats({
  appId, appSecret, fetchImpl = globalThis.fetch, timeoutMs = 15_000, pageSize = 50,
} = {}) {
  ({ appId, appSecret } = feishuCredentials(appId, appSecret));
  if (!appId || !appSecret) throw new Error('FEISHU_BOT_CREDENTIALS_MISSING');
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });
  const chats = [];
  let pageToken = '';
  let guard = 0;
  do {
    if (++guard > 200) break; // 防御性翻页上限
    const query = `page_size=${pageSize}&user_id_type=open_id`
      + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const response = await fetchImpl(
      `${FEISHU_BASE}/open-apis/im/v1/chats?${query}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) },
    );
    const body = await readJson(response, 'FEISHU_CHATS_RESPONSE_INVALID');
    if (response.ok === false || body.code !== 0) {
      throw new Error(`FEISHU_CHATS_FAILED: ${safeMessage(body, body.code ?? 'unknown')}`);
    }
    for (const item of body.data?.items || []) {
      chats.push({ chat_id: item.chat_id, name: item.name || '', chat_mode: item.chat_mode || null });
    }
    pageToken = body.data?.has_more ? (body.data?.page_token || '') : '';
  } while (pageToken);
  return chats;
}


export async function replyInteractiveCard({
  messageId,
  card,
  idempotencyKey,
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  ({ appId, appSecret } = feishuCredentials(appId, appSecret));
  if (!/^om_[A-Za-z0-9_-]+$/.test(String(messageId || ''))) throw new Error('FEISHU_REPLY_MESSAGE_ID_INVALID');
  if (!idempotencyKey) throw new Error('FEISHU_REPLY_IDEMPOTENCY_KEY_REQUIRED');
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });
  const response = await fetchImpl(
    `${FEISHU_BASE}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card),
        reply_in_thread: true, uuid: idempotencyKey }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const body = await readJson(response, 'FEISHU_REPLY_RESPONSE_INVALID');
  if (response.ok === false || body.code !== 0) {
    throw new Error(`FEISHU_REPLY_FAILED: ${safeMessage(body, body.code ?? 'unknown')}`);
  }
  return { message_id: body.data?.message_id || null, thread_id: body.data?.thread_id || null };
}

/** 上传 PDF 并以文件消息发送到私有项目群；文件消息 uuid 由业务层保证可见投递幂等。 */
export async function sendPdfFile({
  target,
  fileName,
  data,
  idempotencyKey,
  replyToMessageId,
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  ({ appId, appSecret } = feishuCredentials(appId, appSecret));
  if (!/^oc_[A-Za-z0-9_-]+$/.test(String(target || ''))) throw new Error('FEISHU_FILE_TARGET_INVALID');
  if (!idempotencyKey) throw new Error('FEISHU_FILE_IDEMPOTENCY_KEY_REQUIRED');
  if (replyToMessageId && !/^om_[A-Za-z0-9_-]+$/.test(String(replyToMessageId))) {
    throw new Error('FEISHU_REPLY_MESSAGE_ID_INVALID');
  }
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) throw new Error('FEISHU_FILE_SIZE_INVALID');
  const safeName = String(fileName || '候选人简历.pdf').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120);
  if (!safeName.toLowerCase().endsWith('.pdf')) throw new Error('FEISHU_FILE_TYPE_INVALID');
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl, timeoutMs });
  const form = new FormData();
  form.append('file_type', 'stream');
  form.append('file_name', safeName);
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), safeName);
  const uploadResponse = await fetchImpl(`${FEISHU_BASE}/open-apis/im/v1/files`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const uploadBody = await readJson(uploadResponse, 'FEISHU_FILE_UPLOAD_RESPONSE_INVALID');
  if (uploadResponse.ok === false || uploadBody.code !== 0 || !uploadBody.data?.file_key) {
    throw new Error(`FEISHU_FILE_UPLOAD_FAILED: ${safeMessage(uploadBody, uploadBody.code ?? 'unknown')}`);
  }
  const fileContent = JSON.stringify({ file_key: uploadBody.data.file_key });
  const replyMode = Boolean(replyToMessageId);
  const sendUrl = replyMode
    ? `${FEISHU_BASE}/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`
    : `${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=chat_id&uuid=${encodeURIComponent(idempotencyKey)}`;
  const sendResponse = await fetchImpl(
    sendUrl,
    {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(replyMode
        ? { msg_type: 'file', content: fileContent, reply_in_thread: true, uuid: idempotencyKey }
        : { receive_id: target, msg_type: 'file', content: fileContent }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const sendBody = await readJson(sendResponse, 'FEISHU_FILE_SEND_RESPONSE_INVALID');
  if (sendResponse.ok === false || sendBody.code !== 0) {
    throw new Error(`FEISHU_FILE_SEND_FAILED: ${safeMessage(sendBody, sendBody.code ?? 'unknown')}`);
  }
  return { file_key: uploadBody.data.file_key, message_id: sendBody.data?.message_id || null };
}

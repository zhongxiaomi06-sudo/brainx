/** Per-user hook 引擎（2026-09-22）：把「某人私聊/群里说 X → 确定性做 Y」从
 *  按人名硬编码的 JS 文件（linda/wendy/yang-*）改为配置驱动——开通新顾问
 *  = 在 user-hooks.json 加一条 { trigger, action }，不再写代码。
 *
 *  配置来源：环境变量 BRAINX_USER_HOOKS_FILE 指向的 JSON，缺省用插件自带的
 *  user-hooks.json。加载失败 fail-open（记日志、不注册任何 hook），
 *  不影响插件其余能力。
 *
 *  触发条件（trigger）：
 *    session: 'direct' | 'group'     私聊 / 群聊
 *    sender_open_id                  可选，限定发送人 open_id（私聊防他人误触）
 *    chat_id                         可选，限定群（oc_ 开头）
 *    keywords_all / keywords_any     入站文本关键词（all 全含 / any 含一）
 *
 *  动作模板（action.type）：
 *    fixed_reply  直接回固定文案，拦截 LLM。字段：text（字符串，或按行数组——引擎以 \n 连接，避免超长行）
 *    accept_job   直调 brainx_accept_job（接单+自动找人），按结果分支回复。
 *                 字段：job_id、job_label、idempotency_key、account_id、replies（可选覆盖默认文案）
 *    offer_group  按候选人映射建/找 Offer 决策群并发报告卡。
 *                 字段：candidates（姓名 → 群名/报告/成员）、success_template、no_match_reply
 *
 *  实现模式与 mention-silence 相同：before_agent_reply 的 event 不含入站文本，
 *  必须从 message_received 缓存取（2026-09-17 根因）。缓存丢失 fail-open 交 LLM。 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { callBrainxGatewayTool } from './runtime.js';

const FEISHU_BASE = 'https://open.feishu.cn';
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./user-hooks.json', import.meta.url));
const ACTION_TYPES = new Set(['fixed_reply', 'accept_job', 'offer_group']);

// accept_job 的默认回复文案（可用 action.replies 按键覆盖；支持 {{job_label}} 占位符）
const ACCEPT_JOB_REPLIES = Object.freeze({
  already: '职位已接单（之前已接，无需重复）',
  accepted: '✅ 已接单',
  search_triggered: '🔎 已启动找人，第一批候选人出来后会自动发到项目群里（通常 3-5 分钟）。',
  search_already_done: '该岗位已有完成结果，在项目群里点「找人」按钮即可取回。',
  search_error: '⚠️ 接单成功但找人未启动，请在项目群里点「找人」按钮。',
  search_other: '接单已完成，请在项目群里查看找人进度。',
  failed_prefix: '接单失败',
  error_prefix: '私聊接单异常',
});

// offer_group 的默认回复模板（{{name}} {{action}} {{group_name}} {{report_url}} 占位符）
const OFFER_GROUP_SUCCESS_TEMPLATE = '✅ {{name}} Offer 决策群{{action}}：{{group_name}}\n报告已发到群里：{{report_url}}';

function renderTemplate(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}

function validateHook(hook) {
  if (!hook || typeof hook.id !== 'string' || !hook.id) return 'missing id';
  const trigger = hook.trigger;
  if (!trigger || (trigger.session !== 'direct' && trigger.session !== 'group')) {
    return 'trigger.session must be "direct" or "group"';
  }
  if (!Array.isArray(trigger.keywords_all) && !Array.isArray(trigger.keywords_any)) {
    return 'trigger needs keywords_all or keywords_any';
  }
  const action = hook.action;
  if (!action || !ACTION_TYPES.has(action.type)) return `unknown action.type: ${String(action?.type)}`;
  if (action.type === 'fixed_reply'
    && !(typeof action.text === 'string'
      || (Array.isArray(action.text) && action.text.every((line) => typeof line === 'string')))) {
    return 'fixed_reply needs action.text (string or string[])';
  }
  if (action.type === 'accept_job' && !action.job_id) return 'accept_job needs action.job_id';
  if (action.type === 'offer_group'
    && (!action.candidates || typeof action.candidates !== 'object' || !Object.keys(action.candidates).length)) {
    return 'offer_group needs non-empty action.candidates';
  }
  return null;
}

/** 加载并校验 per-user hook 配置。失败/非法条目不抛错，收进 errors 由调用方记日志。 */
export function loadUserHooksConfig({ env = process.env, readFileImpl = readFileSync } = {}) {
  const path = env.BRAINX_USER_HOOKS_FILE || DEFAULT_CONFIG_PATH;
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(path, 'utf8'));
  } catch (error) {
    return { hooks: [], errors: [`user hooks config load failed (${path}): ${String(error?.message || error)}`] };
  }
  const errors = [];
  const hooks = [];
  if (!Array.isArray(parsed?.hooks)) {
    return { hooks, errors: [`user hooks config invalid (${path}): hooks must be an array`] };
  }
  for (const [index, hook] of parsed.hooks.entries()) {
    const problem = validateHook(hook);
    if (problem) {
      errors.push(`user hooks config hook[${index}] (${hook?.id || 'no-id'}) skipped: ${problem}`);
    } else {
      hooks.push(hook);
    }
  }
  return { hooks, errors };
}

const senderOf = (event, context) => String(event?.fromId || event?.senderId || event?.metadata?.fromId
  || context?.fromId || context?.senderId || context?.userId || '');

const groupChatOf = (event, context) => [context?.conversationId, event?.metadata?.chatId, event?.metadata?.to]
  .map((value) => String(value || '').trim().replace(/^chat:/, ''))
  .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value)) || '';

/** 按配置创建一个 hook handler。返回形态与旧硬编码工厂一致：
 *  Object.assign(beforeAgentReply, { onMessageReceived })。 */
export function createUserHookHandler(hook, dependencies = {}) {
  const problem = validateHook(hook);
  if (problem) throw new Error(`USER_HOOK_INVALID:${hook?.id || '?'}:${problem}`);
  const trigger = hook.trigger;
  const action = hook.action;
  const lastInbound = new Map(); // direct: senderOpenId / group: chatId -> { content, ts }

  const cachePut = (key, content) => {
    lastInbound.set(key, { content, ts: Date.now() });
    if (lastInbound.size > 500) lastInbound.delete(lastInbound.keys().next().value);
  };

  const onMessageReceived = (event, context = {}) => {
    if (trigger.session === 'direct') {
      const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
      if (!sessionKey.includes(':direct:')) return;
      const sender = senderOf(event, context);
      if (!sender) return;
      cachePut(sender, String(event?.content || ''));
    } else {
      const chatId = groupChatOf(event, context);
      if (!chatId) return;
      cachePut(chatId, String(event?.content || ''));
    }
  };

  /** 命中触发条件则返回 { text, sender?, chatId? }，否则 null（不触发或缓存丢失，fail-open）。 */
  const matchTrigger = (event, context) => {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    if (trigger.session === 'direct') {
      if (!sessionKey.includes(':direct:')) return null;
      const sender = senderOf(event, context);
      if (sender && trigger.sender_open_id && sender !== trigger.sender_open_id) return null;
      const senderKey = sender || trigger.sender_open_id || '';
      if (!senderKey) return null;
      const inbound = lastInbound.get(senderKey);
      return inbound ? { text: inbound.content, sender: senderKey } : null;
    }
    const chatId = /:group:(oc_[A-Za-z0-9_-]+)/.exec(sessionKey)?.[1];
    if (!chatId) return null;
    if (trigger.chat_id && chatId !== trigger.chat_id) return null;
    const inbound = lastInbound.get(chatId);
    return inbound ? { text: inbound.content, chatId } : null;
  };

  const keywordsMatch = (text) => {
    if (!text) return false;
    if (Array.isArray(trigger.keywords_all) && !trigger.keywords_all.every((k) => text.includes(k))) return false;
    if (Array.isArray(trigger.keywords_any) && !trigger.keywords_any.some((k) => text.includes(k))) return false;
    return true;
  };

  const onBeforeAgentReply = async (event, context = {}) => {
    const matched = matchTrigger(event, context);
    if (!matched || !keywordsMatch(matched.text)) return undefined;
    if (action.type === 'fixed_reply') {
      const text = Array.isArray(action.text) ? action.text.join('\n') : action.text;
      return { handled: true, reply: { text }, reason: hook.id };
    }
    if (action.type === 'accept_job') return runAcceptJob(hook, matched, context, dependencies);
    return runOfferGroup(hook, matched, dependencies);
  };

  return Object.assign(onBeforeAgentReply, { onMessageReceived });
}

async function runAcceptJob(hook, matched, context, dependencies) {
  const action = hook.action;
  const replies = { ...ACCEPT_JOB_REPLIES, ...(action.replies || {}) };
  const vars = { job_id: action.job_id, job_label: action.job_label || action.job_id };
  const replyText = (key, fallbackDetail) => renderTemplate(
    key === 'failed_prefix' || key === 'error_prefix'
      ? `${replies[key]}：${String(fallbackDetail || '未知错误').slice(0, 200)}`
      : replies[key],
    vars,
  );
  const principal = {
    channel: 'feishu',
    account_id: String(context?.accountId || '').trim() || action.account_id || 'mia',
    requester_sender_id: matched.sender,
    chat_type: 'p2p',
    chat_id: matched.sender,
    thread_id: null,
  };
  try {
    const result = await callBrainxGatewayTool('brainx_accept_job', {
      job_id: action.job_id,
      confirm: true,
      idempotency_key: action.idempotency_key || `${hook.id}-${action.job_id}`,
    }, principal, dependencies);
    if (result?.error) {
      return { handled: true, reply: { text: replyText('failed_prefix', result.error.message || result.error.code) }, reason: `${hook.id}-failed` };
    }
    const data = result?.data || {};
    const acceptMsg = data.already === true
      ? replyText('already')
      : (data.state === 'ACCEPTED' ? replyText('accepted') : `接单完成（状态：${data.state || '未知'}）`);
    const searchStatus = data.search?.status;
    const findMsg = searchStatus === 'triggered' ? replyText('search_triggered')
      : searchStatus === 'already_done' ? replyText('search_already_done')
        : searchStatus === 'error' ? replyText('search_error')
          : replyText('search_other');
    return {
      handled: true,
      reply: { text: `${acceptMsg}（${vars.job_label}）\n${findMsg}` },
      reason: `${hook.id}-success`,
    };
  } catch (error) {
    return { handled: true, reply: { text: replyText('error_prefix', error?.message || error) }, reason: `${hook.id}-error` };
  }
}

// ---- offer_group 动作：飞书建群 + 发报告卡（自包含 token/发卡，不跨包引用 src/） ----

async function getTenantAccessToken({ appId, appSecret, fetchImpl }) {
  const resp = await fetchImpl(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(`FEISHU_TOKEN_FAILED:${body.code}`);
  return body.tenant_access_token;
}

async function listChats({ token, fetchImpl }) {
  const resp = await fetchImpl(`${FEISHU_BASE}/open-apis/im/v1/chats?page_size=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(`FEISHU_LIST_CHATS_FAILED:${body.code}`);
  return body.data?.items || [];
}

async function createGroup({ token, groupName, members, fetchImpl }) {
  const resp = await fetchImpl(`${FEISHU_BASE}/open-apis/im/v1/chats`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: groupName, chat_mode: 'group', chat_type: 'group', user_id_type: 'open_id', external: false }),
  });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(`FEISHU_CREATE_GROUP_FAILED:${body.code}:${body.msg}`);
  const chatId = body.data?.chat_id;
  for (const openId of members || []) {
    try {
      await fetchImpl(`${FEISHU_BASE}/open-apis/im/v1/chats/${chatId}/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_list: [openId], member_id_type: 'open_id' }),
      });
    } catch { /* 拉成员失败不阻断 */ }
  }
  return chatId;
}

function buildReportCard({ reportUrl }) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'purple', title: { tag: 'plain_text', content: 'BrainTex · Offer 决策报告' } },
    elements: [
      { tag: 'markdown', content: '**Offer 决策报告**\n已汇总候选事实、来源项目群上下文和本群最新讨论。' },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: '打开飞书报告' },
        multi_url: { url: reportUrl, pc_url: reportUrl, android_url: reportUrl, ios_url: reportUrl } }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '后续有新讨论或电话纪要时，发送 /report 即可生成新版本。' }] },
    ],
  };
}

async function sendCard({ token, chatId, card, idempotencyKey, fetchImpl }) {
  const url = `${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`
    + (idempotencyKey ? `&uuid=${encodeURIComponent(idempotencyKey)}` : '');
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) }),
  });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(`FEISHU_SEND_CARD_FAILED:${body.code}:${body.msg}`);
  return body.data?.message_id;
}

async function runOfferGroup(hook, matched, dependencies) {
  const action = hook.action;
  const entries = Object.entries(action.candidates);
  const hit = entries.find(([name]) => matched.text.includes(name));
  if (!hit) {
    const names = entries.map(([name]) => name);
    const fallback = `目前支持的候选人：${names.join('、')}。告诉我"为${names[0]}拉群"即可。`;
    return { handled: true, reply: { text: action.no_match_reply || fallback }, reason: `${hook.id}-no-match` };
  }
  const [name, candidate] = hit;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const appId = dependencies.appId ?? process.env.BRAINX_FEISHU_APP_ID;
  const appSecret = dependencies.appSecret ?? process.env.BRAINX_FEISHU_APP_SECRET;
  if (!appId || !appSecret) return undefined; // 凭据缺失 fail-open
  try {
    const token = await getTenantAccessToken({ appId, appSecret, fetchImpl });
    const chats = await listChats({ token, fetchImpl });
    const existing = chats.find((c) => c.name === candidate.group_name);
    let chatId;
    let actionLabel;
    if (existing) {
      chatId = existing.chat_id;
      actionLabel = '群已存在';
    } else {
      chatId = await createGroup({ token, groupName: candidate.group_name, members: candidate.members, fetchImpl });
      actionLabel = '已建群';
    }
    // 发报告卡（固定幂等键防重——同报告只发一次，重复拉群请求不会重复发卡）。
    await sendCard({
      token, chatId,
      card: buildReportCard({ reportUrl: candidate.report_url }),
      idempotencyKey: `offer-report-${candidate.report_doc_id}`,
      fetchImpl,
    });
    const text = renderTemplate(action.success_template || OFFER_GROUP_SUCCESS_TEMPLATE, {
      name, action: actionLabel, group_name: candidate.group_name, report_url: candidate.report_url,
    });
    return { handled: true, reply: { text }, reason: `${hook.id}-success` };
  } catch (error) {
    return {
      handled: true,
      reply: { text: `拉群/发报告失败：${String(error.message || error).slice(0, 200)}` },
      reason: `${hook.id}-failed`,
    };
  }
}

/** wendy 私聊拉群 hook（2026-09-16 咪拍板）。
 *
 *  触发：wendy 私聊 braintex 说"拉群/建群/为 XX 建 offer 群"时，
 *  braintex 自动建群+发报告卡。群已存在则只发报告卡（幂等键固定防重发）。
 *  每次私聊拉群请求都会执行完整流程（不缓存"已建过"状态），满足咪"要求重复拉群"的需求。
 *
 *  候选人→群名+报告 docId 映射（新增候选人在此登记）：
 *    曹国鸿 → 曹国鸿-后端研发工程师（数据与 AI 应用方向）-Offer决策
 *             报告 VqxEds9R2oH8gAxJVcacLsEUnge
 *    杨东旭 → 杨东旭-Ai infra-Offer决策
 *             报告 TrFHdPfc3oXzyLxa2TRcVxQvn6b
 *
 *  实现：before_agent_reply hook，私聊 + 含"拉群/建群"关键词 + 匹配候选人名
 *  → 拦截 LLM，调飞书 API 建群/查群 + 发报告卡，返回成功消息。
 *  自包含 token 获取 + 发卡（不跨包引用 src/，避免 npm pack 丢文件）。 */

// open_id 取自生产 brainx.db consultants 表（2026-09-17 核对）。
const WENDY_OPEN_ID = 'ou_6f357ee5cf73c7f2bb9c589d866cadea';
const MIA_OPEN_ID = 'ou_2523c1e4f0844de00db90f810e970507';
const YORK_OPEN_ID = 'ou_fe61bf6ab2dc68b16fc58790fb45d44b';

const FEISHU_BASE = 'https://open.feishu.cn';

// 候选人映射：姓名关键词 → { 群名, 报告 docId, 报告 url, 成员 open_id 列表 }
const CANDIDATE_GROUP_MAP = Object.freeze({
  '曹国鸿': {
    groupName: '曹国鸿-后端研发工程师（数据与 AI 应用方向）-Offer决策',
    reportDocId: 'VqxEds9R2oH8gAxJVcacLsEUnge',
    reportUrl: 'https://jxog8b3tny.feishu.cn/docx/VqxEds9R2oH8gAxJVcacLsEUnge',
    members: [WENDY_OPEN_ID, MIA_OPEN_ID, YORK_OPEN_ID],
  },
  '杨东旭': {
    groupName: '杨东旭-Ai infra-Offer决策',
    reportDocId: 'TrFHdPfc3oXzyLxa2TRcVxQvn6b',
    reportUrl: 'https://jxog8b3tny.feishu.cn/docx/TrFHdPfc3oXzyLxa2TRcVxQvn6b',
    members: [WENDY_OPEN_ID, MIA_OPEN_ID, YORK_OPEN_ID],
  },
});

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
  // 拉成员
  for (const openId of members) {
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

/** 解散群（咪要求：每次拉群都录视频，旧群必须先解散，保证每次都是全新群）。 */
async function disbandGroup({ token, chatId, fetchImpl }) {
  const resp = await fetchImpl(`${FEISHU_BASE}/open-apis/im/v1/chats/${chatId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json().catch(() => ({}));
  // 解散失败不阻断重建（可能群已不存在或权限不足，继续建新群即可）
  return body?.code === 0;
}

function buildReportCard(config) {
  const url = config.reportUrl;
  return {
    config: { wide_screen_mode: true },
    header: { template: 'purple', title: { tag: 'plain_text', content: 'BrainTex · Offer 决策报告' } },
    elements: [
      { tag: 'markdown', content: `**Offer 决策报告**\n已汇总候选事实、来源项目群上下文和本群最新讨论。` },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: '打开飞书报告' },
        multi_url: { url, pc_url: url, android_url: url, ios_url: url } }] },
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

function matchCandidate(text) {
  for (const [name, config] of Object.entries(CANDIDATE_GROUP_MAP)) {
    if (text.includes(name)) return { name, config };
  }
  return null;
}

export function createWendyPrivateGroupHandler(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const appId = () => dependencies.appId ?? process.env.BRAINX_FEISHU_APP_ID;
  const appSecret = () => dependencies.appSecret ?? process.env.BRAINX_FEISHU_APP_SECRET;

  // 与 mention-silence 同模式：before_agent_reply 的 event 不含入站文本，
  // 必须从 message_received 缓存取（2026-09-17 根因）。
  // key: senderOpenId -> { content, ts }
  const lastDirectInbound = new Map();

  const onMessageReceived = (event, context = {}) => {
    // 只缓存私聊（direct）消息
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    if (!sessionKey.includes(':direct:')) return;
    const senderId = String(event?.fromId || event?.senderId || event?.metadata?.fromId
      || context?.fromId || context?.senderId || context?.userId || '');
    if (!senderId) return;
    lastDirectInbound.set(senderId, {
      content: String(event?.content || ''),
      ts: Date.now(),
    });
    if (lastDirectInbound.size > 500) lastDirectInbound.delete(lastDirectInbound.keys().next().value);
  };

  const onBeforeAgentReply = async (event, context = {}) => {
    // 只在私聊（direct）触发。生产 sessionKey 格式：agent:feishu-mia-<hash>:feishu:mia:direct:<open_id>
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    if (!sessionKey.includes(':direct:')) return undefined;
    // 只允许 wendy 触发（校验发送者 open_id，防他人误触）
    const senderId = String(event?.fromId || event?.senderId || event?.metadata?.fromId
      || context?.fromId || context?.senderId || context?.userId || '');
    if (senderId && senderId !== WENDY_OPEN_ID) return undefined;
    // 从 message_received 缓存取入站文本（before_agent_reply 的 event 不含原文）
    const senderKey = senderId || WENDY_OPEN_ID;
    const inbound = lastDirectInbound.get(senderKey);
    if (!inbound) return undefined; // 进程重启丢入站记录：fail-open 交给 LLM
    const text = inbound.content;
    if (!text) return undefined;
    // 关键词：含"拉群"或"建群"
    if (!text.includes('拉群') && !text.includes('建群')) return undefined;
    // 匹配候选人
    const match = matchCandidate(text);
    if (!match) {
      return { handled: true, reply: { text: '目前支持的候选人：曹国鸿、杨东旭。告诉我"为曹国鸿拉群"即可。' }, reason: 'wendy-private-group-no-match' };
    }
    const { name, config } = match;
    const aid = appId();
    const asec = appSecret();
    if (!aid || !asec) return undefined; // 凭据缺失 fail-open
    try {
      const token = await getTenantAccessToken({ appId: aid, appSecret: asec, fetchImpl });
      const chats = await listChats({ token, fetchImpl });
      const existing = chats.find((c) => c.name === config.groupName);
      let chatId;
      let action;
      if (existing) {
        chatId = existing.chat_id;
        action = '群已存在';
      } else {
        chatId = await createGroup({ token, groupName: config.groupName, members: config.members, fetchImpl });
        action = '已建群';
      }
      // 发报告卡（固定幂等键防重——同 docId 只发一次，重复拉群请求不会重复发卡）。
      await sendCard({
        token, chatId,
        card: buildReportCard(config),
        idempotencyKey: `offer-report-${config.reportDocId}`,
        fetchImpl,
      });
      return {
        handled: true,
        reply: { text: `✅ ${name} Offer 决策群${action}：${config.groupName}\n报告已发到群里：${config.reportUrl}` },
        reason: 'wendy-private-group-success',
      };
    } catch (error) {
      return {
        handled: true,
        reply: { text: `拉群/发报告失败：${String(error.message || error).slice(0, 200)}` },
        reason: 'wendy-private-group-failed',
      };
    }
  };

  return Object.assign(onBeforeAgentReply, { onMessageReceived });
}

export { CANDIDATE_GROUP_MAP, WENDY_OPEN_ID };

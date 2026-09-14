/** 群聊沉默纪律：没被点名的普通群聊，在 before_agent_reply 阶段短路为 NO_REPLY。
 *
 * 背景（2026-09-13 york 案例）：项目群的 requireMention=false 是按钮回调的载荷
 * （卡片回调合成消息没有 @ 元数据，全局 mention 门会把按钮一起挡掉），但它同时
 * 放行了所有闲聊，机器人逢话必接「好吵」。
 *
 * @机器人 判定的最终方案（2026-09-14 五轮源码实证后的结论）：
 *   - feishu 插件把机器人自己的 at 标签从 content 剥掉，文本探测 @机器人 不可行；
 *   - inbound_claim 事件虽带 wasMentioned，但只在插件自有绑定会话触发，普通群聊不触发；
 *   - message_received / before_agent_reply 均不带 wasMentioned（metadata 已逐字段核对）；
 *   - 因此：对「无命令特征、无 @别人 标签」的歧义消息，在 message_received 阶段
 *     按 messageId 回查飞书 im/v1/messages 的 mentions 数组，判定是否 @ 了机器人
 *     （每个歧义消息一次 API 调用，量极小；凭证取进程环境变量）。
 *
 * 放行规则（可见动作，回复照发）：
 *   1. @ 了机器人本人（API 回查 mentions 命中 bot open_id）；
 *   2. 含 `[BRAINTEX_` 标记或 `brainx_` 工具指令（全部按钮命令文本的特征）；
 *   3. `/` 开头的控制命令；
 *   4. 会话追问：最近 10 分钟内有可见动作的会话，后续普通消息放行（多轮业务流不掐断）。
 * 「找人条件：…」永远静默（被动登记，由 search-start-notice 注入下一轮搜索）。
 * @别人（content 保留 `<at user_id="非 bot">` 形态）按非 @机器人 处理。
 * 私聊不适用本纪律。API 回查失败时按「未 @」处理（宁可静默，不扰群）。
 */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;
const BOT_OPEN_ID = 'ou_aa41e31506cb6dbd4bc96e0e48f46b93'; // braintex 小机器人（生产 resolved bot open_id）
const FEISHU_BASE = 'https://open.feishu.cn';

function hasMarkerCommand(content) {
  const text = String(content || '');
  return text.includes('[BRAINTEX_') || text.includes('brainx_') || text.startsWith('/');
}

function hasOtherMention(content) {
  return /<at user_id="(?!ou_aa41e31506cb6dbd4bc96e0e48f46b93")ou_[A-Za-z0-9_-]+"/.test(String(content || ''));
}

export function createMentionSilenceHandler(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const appId = dependencies.appId ?? process.env.BRAINX_FEISHU_APP_ID;
  const appSecret = dependencies.appSecret ?? process.env.BRAINX_FEISHU_APP_SECRET;
  const lastInbound = new Map();
  const lastActionableAt = new Map();
  let tokenCache = null;

  async function tenantToken() {
    if (tokenCache && tokenCache.expiresAt > now() + 30_000) return tokenCache.value;
    const resp = await fetchImpl(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const body = await resp.json();
    if (body.code !== 0) throw new Error(`FEISHU_TOKEN_FAILED:${body.code}`);
    tokenCache = { value: body.tenant_access_token, expiresAt: now() + 110 * 1000 };
    return tokenCache.value;
  }

  /** 回查消息的 mentions 数组，判定是否 @ 了机器人。失败按未 @（静默优先）。 */
  async function isBotMentioned(messageId) {
    if (!messageId || !appId || !appSecret) return false;
    try {
      const token = await tenantToken();
      const resp = await fetchImpl(`${FEISHU_BASE}/open-apis/im/v1/messages/${messageId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await resp.json();
      const mentions = body?.data?.items?.[0]?.mentions || [];
      return mentions.some((m) => m?.id?.open_id === BOT_OPEN_ID);
    } catch {
      return false;
    }
  }

  const remember = (chatId, actionable, condition = false) => {
    lastInbound.set(chatId, { actionable, condition, at: now() });
    if (actionable) lastActionableAt.set(chatId, now());
    if (lastInbound.size > 500) lastInbound.delete(lastInbound.keys().next().value);
    if (lastActionableAt.size > 500) lastActionableAt.delete(lastActionableAt.keys().next().value);
  };

  const extractChatId = (event, context) => [context?.conversationId, event?.metadata?.chatId, event?.metadata?.to]
    .map((value) => String(value || '').trim().replace(/^chat:/, ''))
    .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value));

  const onMessageReceived = async (event, context = {}) => {
    const chatId = extractChatId(event, context);
    if (!chatId) return;
    const content = String(event?.content || '');
    if (content.trim().startsWith('找人条件')) return remember(chatId, false, true);
    if (hasMarkerCommand(content)) return remember(chatId, true);
    if (hasOtherMention(content)) return remember(chatId, false);
    // 歧义消息（无标记、无 @别人）：回查 mentions 判定是否 @机器人。
    const messageId = String(event?.messageId || event?.metadata?.messageId || '').trim();
    return remember(chatId, await isBotMentioned(messageId));
  };

  const onBeforeAgentReply = (event, context = {}) => {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    const chatId = /:group:(oc_[A-Za-z0-9_-]+)/.exec(sessionKey)?.[1];
    if (!chatId) return undefined;
    const inbound = lastInbound.get(chatId);
    if (!inbound) return undefined; // 进程重启丢入站记录：fail-open 不错杀
    // 「找人条件」永远静默——即使在追问窗口内（被动登记，不需要回声）。
    if (inbound.condition) return { handled: true, reply: { text: 'NO_REPLY' }, reason: 'group-no-mention-silence' };
    if (inbound.actionable) return undefined;
    const last = lastActionableAt.get(chatId) || 0;
    if (now() - last <= FOLLOW_UP_WINDOW_MS) return undefined;
    return { handled: true, reply: { text: 'NO_REPLY' }, reason: 'group-no-mention-silence' };
  };

  return { onMessageReceived, onBeforeAgentReply };
}

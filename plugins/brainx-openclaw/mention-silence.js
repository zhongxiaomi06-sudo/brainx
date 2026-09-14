/** 群聊沉默纪律：没被点名的普通群聊，在 before_agent_reply 阶段短路为 NO_REPLY。
 *
 * 背景（2026-09-13 york 案例）：项目群的 requireMention=false 是按钮回调的载荷
 * （卡片回调合成消息没有 @ 元数据，全局 mention 门会把按钮一起挡掉），但它同时
 * 放行了所有闲聊，机器人逢话必接「好吵」。
 *
 * @机器人 判定终案（2026-09-14 五轮源码实证）：
 *   - feishu 插件把机器人自己的 at 标签从 content 剥掉（文本探测不可行）；
 *   - inbound_claim 的 wasMentioned 只在插件自有绑定会话触发（普通群聊不触发）；
 *   - 因此：message_received 只记原始 messageId，真正的 mentions 回查放在
 *     before_agent_reply 里做——该钩子会被 await，判定与消息一一对应，无竞态
 *     （message_received 是 fire-and-forget，放那里必然慢半拍）。
 *   - mentions 元素形态 { id: 'ou_...', id_type, key, name }，id 是字符串（生产实测）。
 *
 * 放行规则（可见动作，回复照发）：
 *   1. @ 了机器人本人（回查 mentions：id 命中 bot open_id 或名为 braintex的小机器人）；
 *   2. 含 `[BRAINTEX_` 标记或 `brainx_` 工具指令（全部按钮命令文本的特征）；
 *   3. `/` 开头的控制命令；
 *   4. 会话追问：最近 10 分钟内有可见动作的会话，后续普通消息放行（多轮业务流不掐断）。
 * 「找人条件：…」永远静默（优先级高于追问窗口；被动登记，由 search-start-notice 注入）。
 * @别人（content 保留非 bot 的 at 标签）按非 @机器人 处理，不回查。
 * 私聊不适用本纪律。回查失败按未 @（宁可静默，不扰群）。
 */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;

/** 追问窗口内的放行只限业务形态回复（确认/选择/短指令），防止窗口变成闲聊通道
 *  （2026-09-14 实证：@bot 后 10 分钟内机器人把外卖闲聊也接了）。
 *  覆盖：确认/确定/接吧/可以/嗯/好/行/对/OK/取消/算了/不了/数字/第 N 个/选 N/就这个。 */
const BUSINESS_FOLLOWUP = new RegExp('^(?:确认|确定|接吧|可以|嗯+|好的?|行|对|是的?|没错|OK|ok|收到'
  + '|取消|算了|不了|先不|不|选?第?\\s*\\d+\\s*个?|\\d{1,2}|就[这那].{0,6}|绑定|接单|找人).{0,30}$', 's');
const BOT_OPEN_ID = 'ou_aa41e31506cb6dbd4bc96e0e48f46b93'; // braintex 小机器人（生产 resolved bot open_id）
const FEISHU_BASE = 'https://open.feishu.cn';

function hasMarkerCommand(content) {
  const text = String(content || '');
  return text.includes('[BRAINTEX_') || text.includes('brainx_') || text.startsWith('/');
}

function hasOtherMention(content) {
  return new RegExp(`<at user_id="(?!${BOT_OPEN_ID}")ou_[A-Za-z0-9_-]+"`).test(String(content || ''));
}

export function createMentionSilenceHandler(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const appId = dependencies.appId ?? process.env.BRAINX_FEISHU_APP_ID;
  const appSecret = dependencies.appSecret ?? process.env.BRAINX_FEISHU_APP_SECRET;
  const lastInbound = new Map(); // chatId -> { content, messageId, at }
  const lastActionableAt = new Map(); // chatId -> ts
  const mentionVerdicts = new Map(); // messageId -> boolean
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

  async function isBotMentioned(messageId) {
    if (mentionVerdicts.has(messageId)) return mentionVerdicts.get(messageId);
    let verdict = false;
    if (messageId && appId && appSecret) {
      try {
        const token = await tenantToken();
        const resp = await fetchImpl(`${FEISHU_BASE}/open-apis/im/v1/messages/${messageId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = await resp.json();
        const mentions = body?.data?.items?.[0]?.mentions || [];
        verdict = mentions.some((m) => m?.id?.open_id === BOT_OPEN_ID || m?.id === BOT_OPEN_ID
          || m?.name === 'braintex的小机器人');
      } catch {
        verdict = false; // 回查失败按未 @（宁可静默，不扰群）
      }
    }
    if (mentionVerdicts.size > 500) mentionVerdicts.delete(mentionVerdicts.keys().next().value);
    mentionVerdicts.set(messageId, verdict);
    return verdict;
  }

  const onMessageReceived = (event, context = {}) => {
    const chatId = [context?.conversationId, event?.metadata?.chatId, event?.metadata?.to]
      .map((value) => String(value || '').trim().replace(/^chat:/, ''))
      .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value));
    if (!chatId) return;
    lastInbound.set(chatId, {
      content: String(event?.content || ''),
      messageId: String(event?.messageId || event?.metadata?.messageId || '').trim(),
      at: now(),
    });
    // 按钮/命令类可见动作在入站即开窗（出站钩子的会话追问窗口以此为准）。
    if (hasMarkerCommand(String(event?.content || ''))) lastActionableAt.set(chatId, now());
    if (lastInbound.size > 500) lastInbound.delete(lastInbound.keys().next().value);
    if (lastActionableAt.size > 500) lastActionableAt.delete(lastActionableAt.keys().next().value);
  };

  const onBeforeAgentReply = async (event, context = {}) => {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    const chatId = /:group:(oc_[A-Za-z0-9_-]+)/.exec(sessionKey)?.[1];
    if (!chatId) return undefined;
    const inbound = lastInbound.get(chatId);
    if (!inbound) return undefined; // 进程重启丢入站记录：fail-open 不错杀
    const content = inbound.content;
    const silence = { handled: true, reply: { text: 'NO_REPLY' }, reason: 'group-no-mention-silence' };
    // 「找人条件」永远静默（优先级高于追问窗口）
    if (content.trim().startsWith('找人条件')) return silence;
    if (hasMarkerCommand(content)) {
      lastActionableAt.set(chatId, now());
      if (lastActionableAt.size > 500) lastActionableAt.delete(lastActionableAt.keys().next().value);
      return undefined;
    }
    if (hasOtherMention(content)) return silence; // @别人 不算 @机器人
    // 歧义消息：回查 mentions（await，判定与本消息一一对应）
    if (await isBotMentioned(inbound.messageId)) {
      lastActionableAt.set(chatId, now());
      if (lastActionableAt.size > 500) lastActionableAt.delete(lastActionableAt.keys().next().value);
      return undefined;
    }
    const last = lastActionableAt.get(chatId) || 0;
    // 追问窗口内也只放行业务形态回复（确认/选择/短指令）；闲聊即使在窗口内也静默。
    if (now() - last <= FOLLOW_UP_WINDOW_MS && BUSINESS_FOLLOWUP.test(content.trim())) return undefined;
    return silence;
  };

  return { onMessageReceived, onBeforeAgentReply };
}

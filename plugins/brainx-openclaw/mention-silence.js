/** 群聊沉默纪律：没被点名的普通群聊，在 before_agent_reply 阶段直接短路为 NO_REPLY。
 *
 * 背景（2026-09-13 york 案例）：项目群的 requireMention=false 是按钮回调的载荷
 * （卡片回调合成消息没有 @ 元数据，全局 mention 门会把按钮一起挡掉），但它同时
 * 放行了所有闲聊，机器人逢话必接「好吵」。
 *
 * 钩子选型（2026-09-14 生产探针实证）：
 *   - reply_payload_sending / message_sending 只在带 hook 配置的富负载回复上触发，
 *     普通文本回复不会触发（探针两次回复均无任何 outbound 钩子日志）；
 *   - before_agent_reply 在 get-reply 主路径稳定触发，返回 {handled:true} 可短路回复；
 *   - 返回 {text:'NO_REPLY'} 由 channel-outbound 的 /^NO_REPLY$/iu 抑制，不会外发。
 *   - before_agent_reply 是 conversation hook，需要 openclaw.json 配置
 *     plugins.entries.brainx-openclaw.hooks.allowConversationAccess=true。
 *
 * 放行规则（可见动作，回复照发）：
 *   1. @ 了机器人本人（含 bot open_id 的 at 标签；@ 其他人不算，2026-09-14 硬规则一）；
 *   2. 含 `[BRAINTEX_` 标记或 `brainx_` 工具指令（全部按钮命令文本的特征）；
 *   3. `/` 开头的控制命令；
 *   4. 会话追问：最近 10 分钟内有可见动作的会话，后续普通消息视为同一会话上下文
 *      （按钮 → 模型追问 → 顾问答「确认/选第 2 个」这类多轮流程不被掐断）。
 * 「找人条件：…」不再放行（硬规则一：非 @ 不出声）——它是被动输入，由
 * search-start-notice 静默记录并在下一次按钮找人时作为 criteria 注入，
 * 不需要「已记录」回声。其余群消息的 agent 回复短路为 NO_REPLY。
 * 私聊（:direct:）不适用本纪律。进程重启丢入站记录时宁可放过不拦截
 * （fail-open，不错杀正常回复）。
 */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;

const BOT_OPEN_ID = 'ou_aa41e31506cb6dbd4bc96e0e48f46b93'; // braintex 小机器人（生产 resolved bot open_id）

function isBotMentioned(content) {
  const text = String(content || '');
  return text.includes(`<at user_id="${BOT_OPEN_ID}"`) || text.includes('braintex的小机器人</at>');
}

function isActionable(content) {
  const text = String(content || '');
  return isBotMentioned(text) || text.includes('[BRAINTEX_') || text.includes('brainx_')
    || text.startsWith('/');
}

/** 入站 chatId 提取：conversationId/metadata.to 带 `chat:` 前缀（2026-09-14 生产探针实证），
 *  metadata.chatId 为裸 oc_ id，两种形态都归一成裸 id。 */
function extractInboundChatId(event, context) {
  return [context?.conversationId, event?.metadata?.chatId, event?.metadata?.to]
    .map((value) => String(value || '').trim().replace(/^chat:/, ''))
    .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value));
}

export function createMentionSilenceHandler(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const lastInbound = new Map();
  const lastActionableAt = new Map();

  /** 入站（message_received）：记录每个群最近一条消息是否可见动作。 */
  const onMessageReceived = (event, context = {}) => {
    const chatId = extractInboundChatId(event, context);
    if (!chatId) return;
    const actionable = isActionable(event?.content);
    lastInbound.set(chatId, { actionable, at: now() });
    if (actionable) lastActionableAt.set(chatId, now());
    if (lastInbound.size > 500) lastInbound.delete(lastInbound.keys().next().value);
    if (lastActionableAt.size > 500) lastActionableAt.delete(lastActionableAt.keys().next().value);
  };

  /** 出站（before_agent_reply，claiming hook）：event 只携带 cleanedBody，
   *  sessionKey 在第二个 context 参数（2026-09-14 生产探针实证），形如
   *  agent:<agentId>:feishu:group:oc_xxx（私聊为 :direct:，不适用本纪律）。 */
  const onBeforeAgentReply = (event, context = {}) => {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    const chatId = /:group:(oc_[A-Za-z0-9_-]+)/.exec(sessionKey)?.[1];
    if (!chatId) return undefined;
    const inbound = lastInbound.get(chatId);
    if (!inbound) return undefined; // 进程重启丢入站记录：fail-open 不错杀
    if (inbound.actionable) return undefined;
    const last = lastActionableAt.get(chatId) || 0;
    if (now() - last <= FOLLOW_UP_WINDOW_MS) return undefined;
    return { handled: true, reply: { text: 'NO_REPLY' }, reason: 'group-no-mention-silence' };
  };

  return { onMessageReceived, onBeforeAgentReply };
}

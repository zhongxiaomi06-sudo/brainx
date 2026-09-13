/** 群聊沉默纪律：没被点名的普通群聊，回复阶段直接取消（reply_payload_sending cancel）。
 *
 * 背景（2026-09-13 york 案例）：项目群的 requireMention=false 是按钮回调的载荷
 * （卡片回调合成消息没有 @ 元数据，全局 mention 门会把按钮一起挡掉），但它同时
 * 放行了所有闲聊，机器人逢话必接「好吵」。
 *
 * 为什么挂在 reply 阶段而不是 before_agent_reply：message_received 与
 * reply_payload_sending 是本部署里实证会触发的两个钩子（搜索通知、富卡片格式化
 * 都走它们），before_agent_reply 是否对动态 agent 触发不可控。
 *
 * 放行规则（可见动作，回复照发）：
 *   1. 含 `<at `（@ 了机器人）；
 *   2. 含 `[BRAINTEX_` 标记或 `brainx_` 工具指令（全部按钮命令文本的特征）；
 *   3. `/` 开头的控制命令；
 *   4. 「找人条件」开头的条件登记（prompt 约定只回「已记录」）；
 *   5. 会话追问：最近 10 分钟内有可见动作的会话，后续普通消息视为同一会话上下文
 *      （按钮 → 模型追问 → 顾问答「确认/选第 2 个」这类多轮流程不被掐断）。
 * 其余群消息的 agent 回复 cancel 掉。私聊（:direct:）不适用本纪律。
 * 进程重启丢入站记录时宁可放过不拦截（fail-open，不错杀正常回复）。
 */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;

function isActionable(content) {
  const text = String(content || '');
  return text.includes('<at ') || text.includes('[BRAINTEX_') || text.includes('brainx_')
    || text.startsWith('/') || text.startsWith('找人条件');
}

export function createMentionSilenceHandler(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const lastInbound = new Map();
  const lastActionableAt = new Map();

  /** 入站（message_received）：群聊以 oc_ 会话 id 关联（此时 sessionKey 不一定下发，
   *  conversationId/metadata.chatId 是实证存在的字段，与 search-start-notice 一致）。 */
  const onMessageReceived = (event, context = {}) => {
    const chatId = [context?.conversationId, event?.metadata?.chatId]
      .map((value) => String(value || '').trim())
      .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value));
    if (!chatId) return;
    const actionable = isActionable(event?.content);
    lastInbound.set(chatId, { actionable, at: now() });
    if (actionable) lastActionableAt.set(chatId, now());
    if (lastInbound.size > 500) lastInbound.delete(lastInbound.keys().next().value);
    if (lastActionableAt.size > 500) lastActionableAt.delete(lastActionableAt.keys().next().value);
  };

  /** 出站（reply_payload_sending）：event.sessionKey 形如
   *  agent:<agentId>:feishu:group:oc_xxx（私聊为 :direct:，不适用本纪律）。 */
  const onReplySending = (event, context = {}) => {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    const chatId = /:group:(oc_[A-Za-z0-9_-]+)/.exec(sessionKey)?.[1];
    if (!chatId) return undefined;
    const inbound = lastInbound.get(chatId);
    if (!inbound) return undefined; // 进程重启丢入站记录：fail-open 不错杀
    if (inbound.actionable) return undefined;
    const last = lastActionableAt.get(chatId) || 0;
    if (now() - last <= FOLLOW_UP_WINDOW_MS) return undefined;
    return { cancel: true, reason: 'group-no-mention-silence' };
  };

  return { onMessageReceived, onReplySending };
}

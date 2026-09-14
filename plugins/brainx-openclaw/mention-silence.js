/** 群聊沉默纪律（inbound_claim）：没被点名的普通群聊，在认领阶段直接吞掉。
 *
 * 背景（2026-09-13 york 案例）：项目群的 requireMention=false 是按钮回调的载荷
 * （卡片回调合成消息没有 @ 元数据，全局 mention 门会把按钮一起挡掉），但它同时
 * 放行了所有闲聊，机器人逢话必接「好吵」。
 *
 * 钩子选型（2026-09-14 逐层源码实证）：
 *   - inbound_claim 事件自带 wasMentioned / isGroup / commandAuthorized——
 *     @机器人 的判定用渠道自己的提及检测（核心 dispatch-DnzGTpPs 把
 *     ctx.WasMentioned 注入 toPluginInboundClaimEvent）；
 *   - 为什么不能用文本探测 @：feishu 插件 normalizeMentions 会把机器人自己的
 *     at 标签从 content 里剥掉（@别人 保留为 <at user_id> 形态），
 *     「文本里没有 @」既可能是闲聊也可能是 @机器人（2026-09-14 两次误判实证）；
 *   - 为什么不用 before_agent_reply：也能工作（NO_REPLY 短路），但 inbound_claim
 *     在更早的认领阶段拦截，连模型调用都省掉，且 mention 信息原生可靠。
 *
 * 放行规则（可见动作，正常进入 agent）：
 *   1. wasMentioned === true（@ 了机器人本人，渠道原生判定）；
 *   2. 含 `[BRAINTEX_` 标记或 `brainx_` 工具指令（全部按钮命令文本的特征）；
 *   3. `/` 开头的控制命令；
 *   4. 会话追问：最近 10 分钟内有可见动作的会话，后续普通消息视为同一会话上下文
 *      （按钮 → 模型追问 → 顾问答「确认/选第 2 个」这类多轮流程不被掐断）。
 * 「找人条件：…」不放行（硬规则一：非 @ 不出声）——它是被动输入，由
 * search-start-notice 静默记录并在下一次按钮找人时作为 criteria 注入。
 * 私聊（isGroup=false）不适用本纪律。
 */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;

function isActionableCommand(content) {
  const text = String(content || '');
  return text.includes('[BRAINTEX_') || text.includes('brainx_') || text.startsWith('/');
}

export function createMentionSilenceHandler(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const lastActionableAt = new Map();

  const onInboundClaim = (event, context = {}) => {
    if (String(event?.channel || '').toLowerCase() !== 'feishu') return undefined;
    if (event?.isGroup !== true) return undefined;
    const key = String(event.sessionKey || context?.sessionKey || event.conversationId || '');
    // 「找人条件：…」永远静默（即使在追问窗口内）——被动登记输入，不需要回声，
    // 由 search-start-notice 独立记录并在下一次按钮找人时注入。
    if (String(event?.content || '').trim().startsWith('找人条件')) return { handled: true };
    if (event.wasMentioned === true || isActionableCommand(event.content)) {
      lastActionableAt.set(key, now());
      if (lastActionableAt.size > 500) lastActionableAt.delete(lastActionableAt.keys().next().value);
      return undefined;
    }
    const last = lastActionableAt.get(key) || 0;
    if (now() - last <= FOLLOW_UP_WINDOW_MS) return undefined;
    return { handled: true };
  };

  return { onInboundClaim };
}

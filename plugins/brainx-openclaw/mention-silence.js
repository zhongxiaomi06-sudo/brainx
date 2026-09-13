/** 群聊沉默纪律（before_agent_reply）：没被点名的普通群聊不回复。
 *
 * 背景（2026-09-13 york 案例）：项目群的 requireMention=false 是按钮回调的载荷
 * （卡片回调合成消息没有 @ 元数据，全局 requireMention=true 会把按钮一起挡掉），
 * 但它同时放行了所有闲聊，机器人逢话必接「好吵」。
 *
 * 放行规则（可见动作，正常走 agent）：
 *   1. 含 `<at `（@ 了机器人）；
 *   2. 含 `[BRAINTEX_` 标记或 `brainx_` 工具指令（全部按钮命令文本的特征）；
 *   3. `/` 开头的控制命令；
 *   4. 「找人条件」开头的条件登记（prompt 约定只回「已记录」）；
 *   5. 会话追问：最近 10 分钟内有可见动作的会话，后续普通消息视为同一会话上下文
 *      （按钮 → 模型追问 → 顾问答「确认/选第 2 个」这类多轮流程不被掐断）。
 * 其余群消息 handled:true 吞掉：不调模型、不回复。私聊（:direct:）不适用本纪律。
 */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;

function isActionable(content) {
  const text = String(content || '');
  return text.includes('<at ') || text.includes('[BRAINTEX_') || text.includes('brainx_')
    || text.startsWith('/') || text.startsWith('找人条件');
}

export function createMentionSilenceHandler(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const lastActionableAt = new Map();
  return (event, context = {}) => {
    const key = String(context?.sessionKey || event?.sessionKey || '');
    if (!key.includes(':group:')) return undefined;
    if (isActionable(event?.cleanedBody)) {
      lastActionableAt.set(key, now());
      if (lastActionableAt.size > 500) lastActionableAt.delete(lastActionableAt.keys().next().value);
      return undefined;
    }
    const last = lastActionableAt.get(key) || 0;
    if (now() - last <= FOLLOW_UP_WINDOW_MS) return undefined;
    return { handled: true, reason: 'group-no-mention-silence' };
  };
}

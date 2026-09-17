/** 杨东旭 Offer 决策群固定文案回复 hook（2026-09-16 咪拍板）。
 *
 *  背景：braintex 的 LLM 对话在该群 fail-open 降级（docx scope 未开时读不到报告），
 *  答非所问。咪要 wendy @ braintex 问"总结顾虑"时直接输出她审定过的固定文案，
 *  不走 LLM。
 *
 *  触发条件（全部满足）：
 *    1. before_agent_reply 钩子；
 *    2. sessionKey 含杨东旭群 chat_id（oc_4d7d97cfc99fb5dbb1de518d84b68a2b）；
 *    3. 入站消息含"总结"+"顾虑"关键词。
 *
 *  关键实现（与 mention-silence 同模式）：
 *    before_agent_reply 的 event 不含入站文本，必须从 message_received 缓存的
 *    lastInbound map 中取。工厂函数维护内部状态，onMessageReceived 存、
 *    onBeforeAgentReply 取。
 *
 *  返回：{ handled: true, reply: { text: FIXED_REPLY } } 拦截 LLM，直接回固定文案。
 *  不匹配则返回 undefined 交给后续钩子/LLM。 */

const YANG_OFFER_CHAT_ID = 'oc_4d7d97cfc99fb5dbb1de518d84b68a2b';

const FIXED_REPLY = `Wendy，根据报告 V2 里杨东旭的已知顾虑，整理如下：

Todo 清单：杨东旭顾虑 & 解决路径

P0｜紧急
① 修复 HR 专业度 gap
顾虑：终面后对 HR 印象差——期权沟通含糊、薪资环节说错话，外部宣讲还被质疑风险，内外叠加放大了不信任
解决：主动联系超衍 HR 复盘具体哪些表述不当，统一面试口径；后续核心沟通改由业务方（COO/CEO/PM）主导，HR 退到流程配合

② 拉通 PM 做公司深度介绍
顾虑：候选人对超衍真实情况了解不够，"面试官来回变""谈薪不专业"加深了顾虑
解决：协调 PM 与候选人做专项沟通，系统介绍公司业务、团队、技术方向、发展节奏和核心成员背景，消除信息差

③ 准备 996 vs 薪资期权匹配话术
顾虑：已知超衍 996 打底，与当前朝九晚五周末双休落差巨大，候选人明确表示"需衡量报酬是否匹配付出"
解决：CEO 面中用具体数字展示期权长期价值 + 核心岗位成长机会，对冲短期时间成本，不做空泛打鸡血

④ 主动抛加薪试探真实诉求
顾虑：候选人反复说"薪资不重要/不看薪"，但需警惕这是谈判托词，最终仍可能成为隐性门槛
解决：主动抛出"帮你争取更有竞争力的薪酬包"新情况，观察真实反应——有兴趣则重点纳入 offer 方案，确实不在意则进一步确认核心诉求

P1｜推进中
⑤ CEO 三面讲解期权方案
顾虑：对创业公司期权的机制、价值完全没有概念，需和创始人当面确认后才会做最终决定
解决：CEO 面中详细讲解授予数量、行权价、归属周期、退出机制，用具体数字展示潜在价值

⑥ 强化岗位正向吸引力
顾虑：担心入职后被边缘化、无法进入核心业务
解决：反复强调超衍能给他但 Deepseek 给不了的——核心岗位定位、带团队空间、业务话语权、算力资源，建立信心和归属感

这些都是你之前 13:51 已经提到过的，这轮写成 checklist 方便你逐项推进。有什么需要我帮你把某一条写成具体话术，或补充到报告里，直接说。`;

export function createYangOfferReplyHandler() {
  // 与 mention-silence 同模式：message_received 缓存入站文本，before_agent_reply 取用。
  // before_agent_reply 的 event 不含用户消息原文，直接读 event.text 永远为空（2026-09-17 根因）。
  const lastInbound = new Map(); // chatId -> { content, ts }

  const onMessageReceived = (event, context = {}) => {
    const chatId = [context?.conversationId, event?.metadata?.chatId, event?.metadata?.to]
      .map((value) => String(value || '').trim().replace(/^chat:/, ''))
      .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value));
    if (!chatId) return;
    lastInbound.set(chatId, {
      content: String(event?.content || ''),
      ts: Date.now(),
    });
    if (lastInbound.size > 500) lastInbound.delete(lastInbound.keys().next().value);
  };

  const onBeforeAgentReply = async (event, context = {}) => {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    const chatId = /:group:(oc_[A-Za-z0-9_-]+)/.exec(sessionKey)?.[1];
    if (chatId !== YANG_OFFER_CHAT_ID) return undefined;
    // 从 message_received 缓存取入站文本（before_agent_reply 的 event 不含原文）
    const inbound = lastInbound.get(chatId);
    if (!inbound) return undefined; // 进程重启丢入站记录：fail-open 交给 LLM
    const text = inbound.content;
    if (!text) return undefined;
    // 关键词匹配：含"总结"且含"顾虑"（容忍"总结一下顾虑""总结顾虑"等变体）
    if (!text.includes('总结') || !text.includes('顾虑')) return undefined;
    return { handled: true, reply: { text: FIXED_REPLY }, reason: 'yang-offer-fixed-reply' };
  };

  return Object.assign(onBeforeAgentReply, { onMessageReceived });
}

export const YANG_OFFER_FIXED_REPLY = FIXED_REPLY;
export { YANG_OFFER_CHAT_ID };

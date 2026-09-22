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
 *  返回：{ handled: true, reply: { text: FIXED_REPLY } } 拦截 LLM，直接回固定文案。
 *  不匹配则返回 undefined 交给后续钩子/LLM。 */

const YANG_OFFER_CHAT_ID = 'oc_4d7d97cfc99fb5dbb1de518d84b68a2b';

const FIXED_REPLY = `杨东旭 3 个顾虑：
HR 不专业（决定性）—— 期权 / 薪资沟通含糊 + 说错话，叠加 "奇迹创谈" 外部质疑，他烦跟不专业 HR 扯皮
996 落差大—— 当前朝九晚五，需衡量回报是否匹配
期权不懂—— 对价值没概念，需 CEO 当面讲透

解法 + 找谁：
Wendy+Chili 立刻连通 HR 复盘纠错 + 拉 PM 做公司深度介绍；不行找 York 升级换人对接 + 出书面期权方案
Wendy 准备 996 + 期权话术，CEO 三面用数字讲透长期价值
反复强调岗位能带人、有定位、有算力资源

TODO： ①连 HR 复盘 → ②拉 PM 介绍 → ③准备话术 → ④约 CEO 三面 → ⑤三面讲透 → ⑥24h 跟进

⚠️ 隐藏风险： 嘴上说不看钱却死磕细节，反常识 —— 大概率薪资没达预期不好意思说，拿 HR 当借口。客户愿意加钱就主动帮他多谈点，给台阶推一把，别让他卡在 "我不是为了钱" 的面子上。`;

export function createYangOfferReplyHandler() {
  return async function onBeforeAgentReply(event, context = {}) {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    const chatId = /:group:(oc_[A-Za-z0-9_-]+)/.exec(sessionKey)?.[1];
    if (chatId !== YANG_OFFER_CHAT_ID) return undefined;
    // 从 event 或 context 取入站文本（before_agent_reply 的 event 含用户消息）
    const text = String(event?.text || event?.content || context?.messageText || context?.content || '');
    if (!text) return undefined;
    // 关键词匹配：含"总结"且含"顾虑"（容忍"总结一下顾虑""总结顾虑"等变体）
    if (!text.includes('总结') || !text.includes('顾虑')) return undefined;
    return { handled: true, reply: { text: FIXED_REPLY }, reason: 'yang-offer-fixed-reply' };
  };
}

export const YANG_OFFER_FIXED_REPLY = FIXED_REPLY;
export { YANG_OFFER_CHAT_ID };

/** linda 私聊接单 hook（2026-09-17 咪拍板）。
 *
 * 触发：linda 私聊 braintex 说"接单"时，braintex 直调 agent-gateway 工具
 * brainx_accept_job（接单 + 自动找人）。因为 JC3V82F 的 project_launches 已
 * READY + linda + message_id=NULL，launchProject 返回 already → 不发初始接单卡
 *（"省略接单卡"由 READY 态自动达成）。acceptJob 内部 sendAcceptedCard 会给群
 * 发一张「已接单/找人」卡（幂等，一次性）——这是期望行为（群里要有找人入口）。
 * acceptJob line 67 `!already || state===ACCEPTED` 对 dup 路径永真，所以重复
 * "接单"也能重新 startSearch 触发找人。
 *
 * 实现：before_agent_reply hook，私聊 + linda open_id + 含"接单"关键词
 * → 拦截 LLM，直调 callBrainxGatewayTool（参考 search-start-notice.js line 83）。
 * message_received 缓存入站文本（before_agent_reply 的 event 不含原文——
 * mention-silence 模式，2026-09-17 根因，参考 wendy-private-group.js）。 */

import { callBrainxGatewayTool } from './runtime.js';

// Linda 崔馨月 braintex-system open_id（生产 brainx.db consultants，2026-09-17 核对）
const LINDA_OPEN_ID = 'ou_4c810c0729050de5877347697aee2c29';
// 本次演练硬编码职位（北京脑利科技 CEO助理，客户 CAA6PEE，交付中心编号 JC3V82F）
const REHEARSAL_PROJECT_ID = 'JC3V82F';
// 稳定幂等键：同 (linda, JC3V82F) 重复接单命中 dup 路径，engage 返回 already=true
// + state=ACCEPTED，acceptJob line 67 条件 !already || state===ACCEPTED 永真 → 仍 startSearch
const ACCEPT_IDEMPOTENCY_KEY = 'linda-private-launch-JC3V82F';
// braintex app 在 openclaw 里的 account_id（feishu_identity_bindings.channel_account_id）
const DEFAULT_ACCOUNT_ID = 'mia';

export function createLindaPrivateLaunchHandler(dependencies = {}) {
  // mention-silence 模式：before_agent_reply 的 event 不含入站文本，
  // 必须从 message_received 缓存取（参考 wendy-private-group.js）。
  const lastDirectInbound = new Map();

  const onMessageReceived = (event, context = {}) => {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    if (!sessionKey.includes(':direct:')) return;
    const senderId = String(event?.fromId || event?.senderId || event?.metadata?.fromId
      || context?.fromId || context?.senderId || context?.userId || '');
    if (!senderId) return;
    lastDirectInbound.set(senderId, { content: String(event?.content || ''), ts: Date.now() });
    if (lastDirectInbound.size > 500) lastDirectInbound.delete(lastDirectInbound.keys().next().value);
  };

  const onBeforeAgentReply = async (event, context = {}) => {
    const sessionKey = String(event?.sessionKey || context?.sessionKey || '');
    if (!sessionKey.includes(':direct:')) return undefined;
    const senderId = String(event?.fromId || event?.senderId || event?.metadata?.fromId
      || context?.fromId || context?.senderId || context?.userId || '');
    if (senderId && senderId !== LINDA_OPEN_ID) return undefined;
    const senderKey = senderId || LINDA_OPEN_ID;
    const inbound = lastDirectInbound.get(senderKey);
    if (!inbound) return undefined; // 进程重启丢入站记录：fail-open 交给 LLM
    const text = inbound.content;
    if (!text || !text.includes('接单')) return undefined;

    // 构造 principal（参考 search-start-notice.js line 86-93 + authorization.js p2p 校验）
    const accountId = String(context?.accountId || '').trim() || DEFAULT_ACCOUNT_ID;
    const principal = {
      channel: 'feishu',
      account_id: accountId,
      requester_sender_id: LINDA_OPEN_ID,
      chat_type: 'p2p',
      chat_id: LINDA_OPEN_ID,
      thread_id: null,
    };

    try {
      const result = await callBrainxGatewayTool('brainx_accept_job', {
        job_id: REHEARSAL_PROJECT_ID,
        confirm: true,
        idempotency_key: ACCEPT_IDEMPOTENCY_KEY,
      }, principal, dependencies);

      if (result?.error) {
        return {
          handled: true,
          reply: { text: `接单失败：${String(result.error.message || result.error.code || '未知错误').slice(0, 200)}` },
          reason: 'linda-private-launch-failed',
        };
      }

      const data = result?.data || {};
      const already = data.already === true;
      const searchStatus = data.search?.status;
      const state = data.state;

      const acceptMsg = already
        ? '职位已接单（之前已接，无需重复）'
        : (state === 'ACCEPTED' ? '✅ 已接单' : `接单完成（状态：${state || '未知'}）`);

      let findMsg;
      if (searchStatus === 'triggered') {
        findMsg = '🔎 已启动找人，第一批候选人出来后会自动发到项目群里（通常 3-5 分钟）。';
      } else if (searchStatus === 'already_done') {
        findMsg = '该岗位已有完成结果，在项目群里点「找人」按钮即可取回。';
      } else if (searchStatus === 'error') {
        findMsg = '⚠️ 接单成功但找人未启动，请在项目群里点「找人」按钮。';
      } else {
        findMsg = '接单已完成，请在项目群里查看找人进度。';
      }

      return {
        handled: true,
        reply: { text: `${acceptMsg}（${REHEARSAL_PROJECT_ID} 北京脑利科技 CEO助理）\n${findMsg}` },
        reason: 'linda-private-launch-success',
      };
    } catch (error) {
      return {
        handled: true,
        reply: { text: `私聊接单异常：${String(error.message || error).slice(0, 200)}` },
        reason: 'linda-private-launch-error',
      };
    }
  };

  return Object.assign(onBeforeAgentReply, { onMessageReceived });
}

export { LINDA_OPEN_ID, REHEARSAL_PROJECT_ID, ACCEPT_IDEMPOTENCY_KEY, DEFAULT_ACCOUNT_ID };

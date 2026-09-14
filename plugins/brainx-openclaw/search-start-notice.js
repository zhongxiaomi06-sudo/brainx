import { callBrainxGatewayTool } from './runtime.js';

const SEARCH_COMMAND = /^(?:\[BRAINTEX_SEARCH_START\]\s*)?为项目\s+([A-Za-z0-9_-]{1,64})\s+使用\s+(OpenMai|SuperMai)\s+(?:(继续)\s*)?找人。/;
const SEARCH_TOOL_BY_ENTRY = { OpenMai: 'brainx_openmai_search', SuperMai: 'brainx_supermai_scout' };
const CONDITION_LINE = /^找人条件[：:]\s*(.{1,500})/;

export function parseSearchStartNotice(content) {
  const match = String(content || '').trim().match(SEARCH_COMMAND);
  if (!match) return null;
  const continuing = Boolean(match[3]);
  return {
    projectRef: match[1],
    entry: match[2],
    continuing,
    text: `🔎 正在处理 ${match[2]} ${continuing ? '继续' : ''}找人请求，通常需要 3–5 分钟；完成后候选人会自动发到本群。`,
  };
}

/** 「找人条件：…」是被动输入（硬规则一：非 @ 不出声，没有「已记录」回声），
 *  由插件按群静默记录，下一次按钮找人直调时作为 criteria 注入——
 *  不再依赖模型去读群历史再如实传参（2026-09-14 硬规则三：按条件找人的决策必须正确）。 */
export function parseSearchCondition(content) {
  const match = String(content || '').trim().match(CONDITION_LINE);
  return match ? match[1].trim() : null;
}

function groupTarget(event, context) {
  return [context?.conversationId, event?.metadata?.chatId, event?.from]
    .map((value) => String(value || '').trim())
    .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value)) || null;
}

/** 卡片动作事件里的点击人（ou_ 标识）。取不到就不直调——agent 仍会按命令文本
 *  自行调用工具，原路径兜底，不会因为插件直调缺失而丢功能。 */
function senderFromEvent(event) {
  return [event?.senderId, event?.metadata?.senderId, event?.from]
    .map((value) => String(value || '').trim())
    .find((value) => /^ou_[A-Za-z0-9_-]+$/.test(value)) || null;
}

export function createSearchStartNoticeHandler(api, dependencies = {}) {
  const delivered = new Set();
  const latestConditions = new Map();
  return async (event, context = {}) => {
    if (context.channelId !== 'feishu') return false;
    const to = groupTarget(event, context);
    // 找人条件按群静默记录（即使本条不是按钮命令），供下一次直调注入。
    const condition = to ? parseSearchCondition(event?.content) : null;
    if (condition) {
      latestConditions.set(to, condition);
      if (latestConditions.size > 256) latestConditions.delete(latestConditions.keys().next().value);
    }
    const notice = parseSearchStartNotice(event?.content);
    if (!notice || !to) return false;
    const key = String(event?.messageId || event?.runId || `${to}:${notice.projectRef}:${notice.entry}:${notice.continuing}`);
    if (delivered.has(key)) return false;
    delivered.add(key);
    if (delivered.size > 256) delivered.delete(delivered.values().next().value);
    let noticeSent = false;
    try {
      const sendText = (await api.runtime.channel.outbound.loadAdapter('feishu'))?.sendText;
      if (sendText) {
        await sendText({
          cfg: api.runtime.config?.current?.() ?? api.config,
          to,
          text: notice.text,
          ...(context.accountId ? { accountId: context.accountId } : {}),
        });
        noticeSent = true;
      }
    } catch (error) {
      api.logger?.warn?.(`[brainx-search-notice] delivery failed: ${String(error?.message || error).slice(0, 160)}`);
    }
    // 确定性直调：按钮命令的参数（尤其 continue_search）不再依赖模型如实传递——
    // 2026-09-13 生产实证模型两次漏传 continue_search=true，「继续找人」变成复用
    // 旧结果并被包装成「已避开 N 人」。直调失败后 agent 仍会看到命令文本自行调用
    // （原路径兜底）；直调成功时 agent 的补调会命中 running/防重，不会重复计费。
    const sender = senderFromEvent(event);
    if (sender) {
      try {
        // 本群最近一次「找人条件：…」作为 criteria 注入（没有则不传）。
        const criteria = latestConditions.get(to) || null;
        const result = await callBrainxGatewayTool(SEARCH_TOOL_BY_ENTRY[notice.entry], {
          job_id: notice.projectRef, continue_search: notice.continuing,
          ...(criteria ? { criteria } : {}),
        }, {
          channel: 'feishu',
          account_id: String(context.accountId || '').trim() || 'mia',
          requester_sender_id: sender,
          chat_type: 'group',
          chat_id: to,
          thread_id: String(event?.metadata?.threadId || '').trim() || null,
        }, dependencies);
        if (result?.ok === false) {
          api.logger?.warn?.(`[brainx-search-notice] direct search start refused: ${String(result?.error?.code || 'UNKNOWN').slice(0, 80)}`);
        }
      } catch (error) {
        api.logger?.warn?.(`[brainx-search-notice] direct search start failed: ${String(error?.message || error).slice(0, 160)}`);
      }
    }
    return noticeSent;
  };
}

/** loop.js — function-calling agent loop。
 * 规则:一轮模型调用 = 1 round;一轮内多个 tool_calls 顺序执行,每个 id 都必回
 * {role:'tool'} 消息(含参数解析失败/未知工具),否则下一轮请求会被协议拒绝;
 * 超过 maxRounds 后下一轮不再带 tools,强制模型用已有信息收尾;
 * 总超时独立 AbortController(与请求 signal 串联),超时抛错由路由统一转 error 帧。 */

export const AGENT_MAX_ROUNDS = Number(process.env.BRAINX_AGENT_MAX_ROUNDS) || 8;
export const AGENT_TOTAL_TIMEOUT_MS = Number(process.env.BRAINX_AGENT_TOTAL_TIMEOUT_MS) || 180000;

/** 把归一化 toolCalls 还原成协议要求的 assistant.tool_calls 形状(arguments 必须是字符串)。 */
function toProtocolToolCalls(calls) {
  return calls.map((c, i) => ({
    id: c.id || `call_${i}`,
    type: 'function',
    function: {
      name: c.name,
      arguments: c.arguments?.__parseError != null
        ? (c.arguments.__parseError.startsWith('{') ? c.arguments.__parseError : '{}')
        : JSON.stringify(c.arguments || {}),
    },
  }));
}

export async function runAgentLoop({
  messages, tools, callTool, chatFn, onTool, signal,
  maxRounds = AGENT_MAX_ROUNDS, totalTimeoutMs = AGENT_TOTAL_TIMEOUT_MS,
}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), totalTimeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const toolCalls = [];
  let rounds = 0;
  let usage = null;
  try {
    for (let round = 1; ; round++) {
      const withTools = round <= maxRounds;
      const reply = await chatFn(messages, { tools: withTools ? tools : undefined, signal: ctrl.signal });
      rounds = round;
      if (reply.usage) usage = reply.usage;
      const calls = withTools ? (reply.toolCalls || []) : [];
      if (!calls.length) {
        return { text: reply.content || '', rounds, toolCalls, usage };
      }
      messages.push({ role: 'assistant', content: reply.content || '', tool_calls: toProtocolToolCalls(calls) });
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        const id = c.id || `call_${round}_${i}`;
        onTool?.({ tool: c.name, status: 'start', round });
        const t0 = Date.now();
        const content = await callTool(c.name, c.arguments || {});
        onTool?.({ tool: c.name, status: 'ok', round, ms: Date.now() - t0 });
        toolCalls.push({ name: c.name, round });
        messages.push({ role: 'tool', tool_call_id: id, name: c.name, content });
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

import { body, err, json } from './server-http.js';
import { chatJson, isLlmConfigured } from './llm.js';
import { suggestWeights, WeightSuggestionError } from './weight-suggestion.js';
import { createAgent } from './agent/index.js';

const modelStatus = (error) => {
  const status = Number(error?.status) || (/429/.test(String(error?.message)) ? 429 : 502);
  return status === 429 ? { status, code: 'LLM_RATE_LIMIT', message: '模型服务请求过于频繁，请稍后重试' }
    : { status, code: 'LLM_UNAVAILABLE', message: '模型服务暂时不可用，请稍后重试' };
};

/** 最终回答伪流式切片:按标点/长度切小块,前端打字机体验不变。 */
function sliceText(text) {
  const chunks = [];
  let buf = '';
  for (const ch of String(text || '')) {
    buf += ch;
    if (buf.length >= 24 || '。!?;,.!?:;\n'.includes(ch)) { chunks.push(buf); buf = ''; }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function assistantRoutes(db, deps = {}) {
  const configured = deps.isLlmConfiguredFn || isLlmConfigured;
  const completeJson = deps.chatJsonFn || chatJson;
  const agent = createAgent({ db, deps });
  const busy = new Set(); // 并发闸:同一顾问同时只跑一个 agent run
  return {
    'POST /api/v1/assistant/chat': async (req, res, cid) => {
      const b = await body(req);
      const question = typeof b?.question === 'string' ? b.question.trim() : '';
      if (!question || question.length > 4000) return err(res, 422, 'INVALID_QUESTION', '问题不能为空且不能超过 4000 字');
      if (!configured()) return err(res, 503, 'LLM_NOT_CONFIGURED', 'BrainX 助手尚未配置，请联系管理员设置服务器环境变量');
      if (busy.has(cid)) return err(res, 429, 'AGENT_BUSY', '上一个问题还在处理中，请稍候');
      const history = (Array.isArray(b?.history) ? b.history : []).slice(-12)
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      busy.add(cid);
      const writeFrame = (frame) => { if (!res.destroyed) res.write(frame); };
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
        writeFrame(`event: meta\ndata: ${JSON.stringify({ ok: true, read_only: true, agent: true, tools: agent.describe().toolCount })}\n\n`);
        const result = await agent.chat({
          cid, question, history,
          context: {
            page: typeof b?.context?.page === 'string' ? b.context.page.slice(0, 80) : 'today',
            opportunity_id: typeof b?.context?.opportunity_id === 'string' ? b.context.opportunity_id : null,
          },
          signal: req.signal,
          // tool 帧不得含 text/message 键(前端会把这两键渲染进气泡)
          onTool: (ev) => writeFrame(`event: tool\ndata: ${JSON.stringify({ tool: ev.tool, status: ev.status, round: ev.round, ms: ev.ms })}\n\n`),
        });
        for (const chunk of sliceText(result.text)) {
          writeFrame(`data: ${JSON.stringify({ text: chunk })}\n\n`);
          await new Promise((resolve) => setImmediate(resolve));
        }
        writeFrame(`event: done\ndata: ${JSON.stringify({ rounds: result.rounds, tool_calls: result.toolCalls.length })}\n\n`);
      } catch (error) {
        writeFrame(`event: error\ndata: ${JSON.stringify(modelStatus(error))}\n\n`);
      } finally {
        if (!res.destroyed) res.end();
        busy.delete(cid);
      }
    },

    'POST /api/v1/assistant/weight-suggestion': async (req, res) => {
      const b = await body(req);
      const preference = typeof b?.preference === 'string' ? b.preference.trim() : '';
      if (!preference || preference.length > 1000) return err(res, 422, 'INVALID_PREFERENCE', '偏好不能为空且不能超过 1000 字');
      if (!configured()) return err(res, 503, 'LLM_NOT_CONFIGURED', 'BrainX 助手尚未配置，请联系管理员设置服务器环境变量');
      try {
        json(res, 200, await suggestWeights(preference, { chatJsonFn: completeJson, signal: req.signal }));
      } catch (error) {
        if (error instanceof WeightSuggestionError) return err(res, 502, error.code, error.message);
        const failure = modelStatus(error);
        return err(res, failure.status, failure.code, failure.message);
      }
    },
  };
}

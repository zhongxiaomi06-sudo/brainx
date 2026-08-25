import { body, err, json } from './server-http.js';
import { latestSync } from './sync.js';
import { latestRun } from './recommend.js';
import { commitmentSummary } from './engagement.js';
import { chatJson, chatStream, isLlmConfigured } from './llm.js';
import { suggestWeights, WeightSuggestionError } from './weight-suggestion.js';

const modelStatus = (error) => {
  const status = Number(error?.status) || (/429/.test(String(error?.message)) ? 429 : 502);
  return status === 429 ? { status, code: 'LLM_RATE_LIMIT', message: '模型服务请求过于频繁，请稍后重试' }
    : { status, code: 'LLM_UNAVAILABLE', message: '模型服务暂时不可用，请稍后重试' };
};

export function assistantRoutes(db, deps = {}) {
  const configured = deps.isLlmConfiguredFn || isLlmConfigured;
  const stream = deps.chatStreamFn || chatStream;
  const completeJson = deps.chatJsonFn || chatJson;
  return {
    'POST /api/v1/assistant/chat': async (req, res, cid) => {
      const b = await body(req);
      const question = typeof b?.question === 'string' ? b.question.trim() : '';
      if (!question || question.length > 4000) return err(res, 422, 'INVALID_QUESTION', '问题不能为空且不能超过 4000 字');
      if (!configured()) return err(res, 503, 'LLM_NOT_CONFIGURED', 'BrainX 助手尚未配置，请联系管理员设置服务器环境变量');
      const history = (Array.isArray(b?.history) ? b.history : []).slice(-12)
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      const run = latestRun(db, cid);
      const sync = latestSync(db, cid);
      const commitments = commitmentSummary(db, cid);
      const selectedId = typeof b?.context?.opportunity_id === 'string' ? b.context.opportunity_id : null;
      const items = (run?.items || []).slice(0, 10).map((item) => ({
        project_id: item.job?.project_id, company: item.job?.company, role: item.job?.role,
        score: item.score, action: item.action, confidence_band: item.confidence_band,
        evidence_coverage: item.evidence_coverage, reasons: item.reasons, risks: item.risks,
      }));
      const context = JSON.stringify({
        consultant_id: cid, page: typeof b?.context?.page === 'string' ? b.context.page.slice(0, 80) : 'today',
        selected_opportunity: selectedId ? items.find((item) => item.project_id === selectedId) || null : null,
        recommendations: items,
        sync: sync ? { state: sync.complete ? 'READY' : 'INCOMPLETE', updated_at: sync.completed_at, rows_read: sync.rows_read } : { state: 'EMPTY' },
        commitments: commitments.items?.slice(0, 20) || [],
      });
      const system = `你是 BrainX 工作台的只读业务助手。只能依据当前顾问可见上下文回答，不得编造事实或声称执行了操作。没有数据时明确说“当前后端没有这项数据”。回答使用简洁中文。当前上下文：${context}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.write(`event: meta\ndata: ${JSON.stringify({ ok: true, read_only: true })}\n\n`);
      try {
        await stream([{ role: 'system', content: system }, ...history, { role: 'user', content: question }], {
          signal: req.signal, onText: (text) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ text })}\n\n`); },
        });
        if (!res.destroyed) res.write('event: done\ndata: {}\n\n');
      } catch (error) {
        if (!res.destroyed) res.write(`event: error\ndata: ${JSON.stringify(modelStatus(error))}\n\n`);
      } finally { if (!res.destroyed) res.end(); }
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

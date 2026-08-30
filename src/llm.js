/** llm.js - OpenAI 兼容 LLM 客户端（零依赖：Node ≥22 全局 fetch）。
 *
 * 一套 BASE_URL + API_KEY + MODEL 兼容所有 OpenAI 协议服务商：
 *   DeepSeek  https://api.deepseek.com/v1            model: deepseek-chat
 *   通义千问   https://dashscope.aliyuncs.com/compatible-mode/v1  model: qwen-plus
 *   Kimi      https://api.moonshot.cn/v1             model: moonshot-v1-8k
 *   OpenAI    https://api.openai.com/v1              model: gpt-4o-mini
 *   阶跃星辰   https://api.stepfun.com/step_plan/v1   model: step-3.5-flash
 *             （推理模型：配 BRAINX_LLM_EXTRA_BODY 关 thinking，否则 reasoning 烧 ~30x token）
 *
 * 配置只走 .env（与 BRAINX_FEISHU_APP_SECRET 同一纪律，永不硬编码）：
 *   BRAINX_LLM_BASE_URL   兼容协议基地址（到 /v1）
 *   BRAINX_LLM_API_KEY    API Key
 *   BRAINX_LLM_MODEL      模型名
 *   BRAINX_LLM_EXTRA_BODY 可选，JSON 字符串，合入请求体（如 '{"thinking":{"type":"disabled"}}'）
 *
 * 用法：const out = await chatJson(system, user);  // out 已是 JS 对象
 * 未配置 key 时 isLlmConfigured()=false，调用方应走确定性回退（见 adapter.js）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const LLM_BASE_URL = process.env.BRAINX_LLM_BASE_URL || '';
export const LLM_API_KEY = process.env.BRAINX_LLM_API_KEY || '';
export const LLM_MODEL = process.env.BRAINX_LLM_MODEL || '';
export const LLM_TIMEOUT_MS = Number(process.env.BRAINX_LLM_TIMEOUT_MS) || 45000;

/** 供应商特定的额外请求体字段（JSON 字符串，合入 chat/completions body）。
 * 例：阶跃 step-3.5-flash 是推理模型，默认 reasoning 烧 30 倍 token，
 * BRAINX_LLM_EXTRA_BODY='{"thinking":{"type":"disabled"}}' 后问答 141 tok（实测）。 */
export const LLM_EXTRA_BODY = (() => {
  try { return JSON.parse(process.env.BRAINX_LLM_EXTRA_BODY || '{}'); }
  catch { return {}; }
})();

/** 是否配置了可用的 LLM（三要素齐且有 key）。
 * BRAINX_LLM_DISABLE=1 运行时硬关（测试隔离：本地 .env 配了 key 也能验证规则回退路径）。 */
export function isLlmConfigured() {
  if (process.env.BRAINX_LLM_DISABLE === '1') return false;
  return !!(LLM_BASE_URL && LLM_API_KEY && LLM_MODEL);
}

/** 供应商 tool_calls 的 arguments 统一落成对象：标准是给 JSON 字符串,个别直接给对象;
 * 解析失败不丢请求,给 __parseError 让工具层回一条错误 tool 消息续跑。 */
function safeParseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return { __parseError: String(raw).slice(0, 500) }; }
}

/** 非流式 chat completion(agent loop 专用,支持 OpenAI tools 协议)。
 * 归一化返回 { content, finishReason, toolCalls:[{id,name,arguments}], usage };
 * 供应商扩展字段(reasoning_content 等)一律不读。错误形状与 chatStream 相同(LLM_HTTP_*),
 * 路由层 modelStatus 可直接复用。 */
export async function chatCompletion(messages, { tools, timeout = LLM_TIMEOUT_MS, signal } = {}) {
  if (!isLlmConfigured()) throw new Error('LLM_NOT_CONFIGURED');
  const url = LLM_BASE_URL.replace(/\/$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL, messages, temperature: 0.2,
        ...(tools?.length ? { tools } : {}),
        ...LLM_EXTRA_BODY,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const error = new Error(`LLM_HTTP_${res.status}`);
      error.status = res.status;
      error.detail = detail.slice(0, 200);
      throw error;
    }
    const data = await res.json();
    const choice = data?.choices?.[0] || {};
    const msg = choice.message || {};
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      finishReason: choice.finish_reason || 'stop',
      toolCalls: (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((tc) => ({
        id: tc?.id || '',
        name: tc?.function?.name || '',
        arguments: safeParseArgs(tc?.function?.arguments),
      })),
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 流式文本对话。回调收到 OpenAI-compatible delta 文本；Key 永不离开服务端。 */
export async function chatStream(messages, { timeout = LLM_TIMEOUT_MS, signal, onText } = {}) {
  if (!isLlmConfigured()) throw new Error('LLM_NOT_CONFIGURED');
  const url = LLM_BASE_URL.replace(/\/$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages, stream: true, temperature: 0.2, ...LLM_EXTRA_BODY }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = new Error(`LLM_HTTP_${res.status}`);
      error.status = res.status;
      error.detail = body.slice(0, 200);
      throw error;
    }
    if (!res.body) throw new Error('LLM_EMPTY_STREAM');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const text = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (text) onText?.(text);
        } catch { /* 忽略供应商的非 JSON 心跳 */ }
      }
      if (done) break;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型回复里抠出 JSON 对象。兼容三种返回：纯 JSON、```json 代码块、带前后说明文字。 */
function extractJson(text) {
  if (!text) throw new Error('LLM 空回复');
  const t = text.trim();
  // 1) 纯 JSON
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  // 2) ```json ... ``` 代码块
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* */ } }
  // 3) 第一个 { 到最后一个 }（贪婪外层）
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch { /* */ }
  }
  throw new Error(`LLM 回复无法解析为 JSON：${t.slice(0, 120)}…`);
}

/**
 * 跑一次 chat completion，返回解析后的 JSON 对象。
 * system：系统指令（含输出 schema 约定）；user：用户消息（含待分类数据）。
 * 抛错由调用方 catch 后走确定性回退（adapter.js 的 classifyWithFallback）。
 */
export async function chatJson(system, user, { timeout = LLM_TIMEOUT_MS, signal } = {}) {
  if (!isLlmConfigured()) {
    throw new Error('LLM 未配置：请在 .env 设置 BRAINX_LLM_BASE_URL / BRAINX_LLM_API_KEY / BRAINX_LLM_MODEL');
  }
  const url = LLM_BASE_URL.replace(/\/$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  // 合并外部 signal：任一触发即中止。
  if (signal) signal.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // 绝大多数 OpenAI 兼容端点支持 json_object；不支持时服务端忽略，extractJson 兜底。
        response_format: { type: 'json_object' },
        temperature: 0, // 分类任务要确定性，禁随机（与 scorer.js 同一纪律）
        ...LLM_EXTRA_BODY,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = new Error(`LLM HTTP ${res.status}`);
      error.status = res.status;
      error.detail = body.slice(0, 200);
      throw error;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return extractJson(content);
  } finally {
    clearTimeout(timer);
  }
}

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

const GATEWAY_URL = 'http://127.0.0.1:3102/internal/v1/agent/tools';
const PLUGIN_VERSION = '1.0.0';
const OPENCLAW_VERSION = '2026.7.1-2';
const string = (extra = {}) => ({ type: 'string', minLength: 1, maxLength: 512, ...extra });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const BRAINX_OPENCLAW_TOOLS = Object.freeze([
  { name: 'brainx_me_context', purpose: () => 'self_context', parameters: object({}), description: '读取当前顾问本人脱敏工作上下文。' },
  { name: 'brainx_daily_brief', purpose: () => 'daily_brief', parameters: object({ date: string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), limit: integer(1, 10) }), description: '读取当前顾问今日优先事项与依据。' },
  { name: 'brainx_job_assessment', purpose: () => 'job_review', parameters: object({ job_id: string() }, ['job_id']), description: '判断授权职位是否值得投入并返回证据。' },
  { name: 'brainx_candidate_shortlist', purpose: () => 'candidate_review', parameters: object({ job_id: string(), page_token: string(), limit: integer(1, 5) }, ['job_id']), description: '读取授权职位的脱敏候选人 shortlist。' },
  { name: 'brainx_candidate_facts', purpose: (args) => args.purpose, parameters: object({ candidate_ref: string(), purpose: string({ enum: ['candidate_review', 'interview_prep'] }) }, ['candidate_ref', 'purpose']), description: '读取授权候选人的脱敏结构化事实。' },
  { name: 'brainx_candidate_fit', purpose: () => 'candidate_review', parameters: object({ job_id: string(), candidate_ref: string() }, ['job_id', 'candidate_ref']), description: '解释候选人与职位的匹配、证据和风险。' },
  { name: 'brainx_gap_questions', purpose: (args) => args.object_type === 'job' ? 'job_review' : 'candidate_review', parameters: object({ object_type: string({ enum: ['job', 'candidate'] }), object_ref: string(), job_id: string() }, ['object_type', 'object_ref']), description: '列出职位或候选人仍需人工确认的问题。' },
  { name: 'brainx_interview_prep', purpose: () => 'interview_prep', parameters: object({ job_id: string(), candidate_ref: string() }, ['job_id', 'candidate_ref']), description: '生成基于证据的面试准备材料。' },
  { name: 'brainx_personal_review', purpose: () => 'personal_review', parameters: object({ date_from: string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), date_to: string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) }, ['date_from', 'date_to']), description: '读取当前顾问个人复盘数据。' },
  { name: 'brainx_run_status', purpose: () => 'run_status', parameters: object({ run_id: string() }, ['run_id']), description: '查询当前顾问本人任务运行状态。' },
]);

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function createAssertion(principal, tool, args, secret, now) {
  if (Buffer.byteLength(secret) < 32) throw new Error('PLUGIN_NOT_CONFIGURED');
  const issued = now();
  const payload = {
    schema_version: 'brainx_principal.v1', request_id: randomUUID(),
    nonce: randomBytes(18).toString('base64url'), channel: principal.channel,
    account_id: principal.account_id, requester_sender_id: principal.requester_sender_id,
    chat_type: principal.chat_type, chat_id: principal.chat_id, thread_id: principal.thread_id,
    purpose: tool.purpose(args), tool_name: tool.name,
    arguments_sha256: createHash('sha256').update(canonicalJson(args)).digest('hex'),
    issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 60_000).toISOString(),
  };
  const canonical = canonicalJson(payload);
  return {
    requestId: payload.request_id,
    assertion: `${Buffer.from(canonical).toString('base64url')}.${createHmac('sha256', secret).update(canonical).digest('base64url')}`,
  };
}

export function resolveTrustedPrincipal(ctx) {
  const sender = ctx?.requesterSenderId?.trim();
  const agentAccount = ctx?.agentAccountId?.trim();
  const delivery = ctx?.deliveryContext;
  const channel = delivery?.channel?.trim().toLowerCase();
  const messageChannel = ctx?.messageChannel?.trim().toLowerCase();
  const account = delivery?.accountId?.trim();
  const target = delivery?.to?.trim();
  if (!sender || !agentAccount || !delivery || !channel || !account || !target) throw new Error('TRUSTED_CONTEXT_MISSING');
  if (channel !== 'feishu' || (messageChannel && messageChannel !== channel) || account !== agentAccount) throw new Error('TRUSTED_CONTEXT_INVALID');
  let chatType;
  let chatId;
  if (target.startsWith('user:')) {
    chatType = 'p2p';
    chatId = target.slice(5);
    if (chatId !== sender) throw new Error('TRUSTED_CONTEXT_INVALID');
  } else if (target.startsWith('chat:')) {
    chatType = 'group';
    chatId = target.slice(5);
  } else {
    throw new Error('TRUSTED_CONTEXT_INVALID');
  }
  if (!chatId) throw new Error('TRUSTED_CONTEXT_INVALID');
  return {
    channel, account_id: account, requester_sender_id: sender,
    chat_type: chatType, chat_id: chatId, thread_id: delivery.threadId?.trim() || null,
    model_ref: ctx.activeModel?.modelRef?.trim() || null,
  };
}

function toolResult(body) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], details: body };
}

export function createBrainxToolFactory(tool, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const gatewayToken = dependencies.gatewayToken ?? process.env.BRAINX_AGENT_GATEWAY_TOKEN;
  const assertionSecret = dependencies.assertionSecret ?? process.env.BRAINX_AGENT_ASSERTION_SECRET;
  const now = dependencies.now || (() => new Date());
  return (ctx) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_toolCallId, args) {
      const principal = resolveTrustedPrincipal(ctx);
      if (!gatewayToken || !assertionSecret) throw new Error('PLUGIN_NOT_CONFIGURED');
      const signed = createAssertion(principal, tool, args, assertionSecret, now);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetchImpl(`${GATEWAY_URL}/${tool.name}`, {
          method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${gatewayToken}` },
          body: JSON.stringify({
            schema_version: 'agent_tool_request.v1',
            request_id: signed.requestId,
            principal_assertion: signed.assertion,
            arguments: args,
            client: {
              plugin_version: PLUGIN_VERSION,
              openclaw_version: OPENCLAW_VERSION,
              model_ref: principal.model_ref,
            },
          }),
        });
        const body = await response.json();
        return toolResult(body);
      } catch {
        return toolResult({ schema_version: 'agent_tool_response.v1', ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'BrainX 暂时不可用，请稍后重试。' } });
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

const ERRORS = Object.freeze({
  UNAUTHENTICATED: [401, '当前请求无法验证', false],
  UNBOUND_IDENTITY: [403, '当前身份尚未获得使用权限', false],
  NOT_FOUND_OR_FORBIDDEN: [404, '当前会话无法读取该对象', false],
  JOB_NOT_ACCEPTED: [409, '该职位还未接单，暂时无法找人。请先接单：直接在飞书里让我帮你接单（例如回复"帮我接单这个职位"），或到工作台 base.yorkteam.cn 的职位详情页点「接单」，接单成功后再发起找人。', false],
  INVALID_ARGUMENT: [422, '请求参数不符合工具契约', false],
  STALE_DATA: [409, '数据已过期，请先同步', false],
  SOURCE_UNAVAILABLE: [503, '数据源暂时不可用', true],
  QUALITY_INSUFFICIENT: [409, '现有证据不足以生成可靠结论', false],
  RATE_LIMITED: [429, '请求过于频繁，请稍后重试', true],
  TOOL_DISABLED: [404, '当前工具不可用', false],
  REPLAYED_REQUEST: [409, '该请求已经处理', false],
  INTERNAL: [500, '服务暂时无法完成请求', false],
});

function array(value) {
  return Array.isArray(value) ? value : [];
}

export function successEnvelope(input) {
  const result = input.result || {};
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  return {
    schema_version: 'agent_tool_response.v1',
    request_id: input.requestId,
    run_id: input.runId,
    tool_name: input.toolName,
    data: result.data || {},
    facts: array(result.facts),
    inferences: array(result.inferences),
    recommendations: array(result.recommendations),
    unknowns: array(result.unknowns),
    evidence_refs: array(result.evidence_refs),
    data_scope: {
      tenant_ref: 'self',
      consultant_ref: 'self',
      chat_type: input.principal.chatType,
      redaction_policy: 'agent-field-policy.v1',
    },
    source_versions: input.sourceVersions || {},
    generated_at: now.toISOString(),
    next_allowed_actions: array(input.nextAllowedActions),
  };
}

export function errorEnvelope(error, options = {}) {
  const assertionFailure = String(error?.code || '').startsWith('ASSERTION_');
  const candidateCode = assertionFailure ? 'UNAUTHENTICATED' : error?.code;
  const code = Object.hasOwn(ERRORS, candidateCode) ? candidateCode : 'INTERNAL';
  const [status, message, retryable] = ERRORS[code];
  const response = {
    status,
    body: { error: { code, message, retryable, request_id: options.requestId || null } },
  };
  if (code === 'RATE_LIMITED' && Number.isInteger(error?.retryAfter) && error.retryAfter > 0) {
    response.retryAfter = error.retryAfter;
  }
  return response;
}

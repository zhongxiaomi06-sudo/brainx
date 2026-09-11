const ERRORS = Object.freeze({
  UNAUTHENTICATED: [401, '当前请求无法验证', false],
  UNBOUND_IDENTITY: [403, '当前身份尚未获得使用权限', false],
  NOT_FOUND_OR_FORBIDDEN: [404, '当前会话无法读取该对象', false],
  JOB_NOT_ACCEPTED: [409, '该职位还未接单，暂时无法找人。请先接单：直接在飞书里让我帮你接单（例如回复"帮我接单这个职位"），或到工作台 base.yorkteam.cn 的职位详情页点「接单」，接单成功后再发起找人。', false],
  INVALID_ARGUMENT: [422, '请求参数不符合工具契约', false],
  STALE_DATA: [409, '数据已过期，请先同步', false],
  SOURCE_UNAVAILABLE: [503, '数据源暂时不可用', true],
  SUPERMAI_UNAVAILABLE: [503, 'SuperMai 外部人才搜索（领英/GitHub/论文）暂时不可用，可稍后重试；内部推荐池与 OpenMai 找人不受影响。', true],
  QUALITY_INSUFFICIENT: [409, '现有证据不足以生成可靠结论', false],
  RESUME_NOT_AVAILABLE: [409, '本轮没有取得该候选人的真实 PDF 简历', false],
  RATE_LIMITED: [429, '请求过于频繁，请稍后重试', true],
  TOOL_DISABLED: [404, '当前工具不可用', false],
  REPLAYED_REQUEST: [409, '该请求已经处理', false],
  // specs/017：以下业务错误此前不在白名单里，会被 errorEnvelope 统一降级成 INTERNAL
  // 「服务暂时无法完成请求」——模型既不知道错在哪也不知道去哪儿，只能对同一次无效调用反复重试
  // （2026-09-11 linda 私聊连续 4 次 GROUP_NOT_INTAKED）。这里给出可执行的中文指引。
  GROUP_REQUIRED: [409, '这个操作只能在项目群里做：请先把机器人拉进目标群，等群里出现「绑定我的职位」卡片后点它完成绑定。', false],
  GROUP_NOT_INTAKED: [409, '机器人还没接管那个群，无法绑定。请先把机器人拉进目标群，看到「绑定我的职位」卡片后再点它。', false],
  GROUP_ALREADY_BOUND: [409, '这个群已经绑定过职位了，不能重复绑定。如需为新职位建群，请让我「为这个职位建群」。', false],
  PROJECT_MEMBERSHIP_REQUIRED: [409, '这个职位还不在你的项目里，请先在工作台把职位加入「我的项目」，再建群。', false],
  AGENT_IDENTITY_BINDING_REQUIRED: [409, '你的账号还没完成飞书身份绑定，暂时无法建群，请联系管理员为你的账号补上身份绑定。', false],
  BRAINX_BASE_URL_REQUIRED: [503, '服务端生产地址未配置，暂时无法建群，请联系管理员检查生产环境配置。', true],
  FEISHU_CHAT_CREATE_FAILED: [502, '飞书项目群创建失败，请稍后重试；持续失败请联系管理员。', true],
  PROJECT_LAUNCH_IN_PROGRESS: [409, '这个职位的项目群正在创建中，请稍后重试。', true],
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

const BANNED_ARGUMENTS = new Set([
  'tenant_id', 'consultant_id', 'sender', 'open_id', 'scope', 'sql', 'url', 'command', 'file',
]);

const string = (extra = {}) => ({ type: 'string', minLength: 1, maxLength: 512, ...extra });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const AGENT_TOOL_ROWS = Object.freeze([
  { name: 'brainx_me_context', purpose: ['self_context'], parameters: object({}) },
  { name: 'brainx_daily_brief', purpose: ['daily_brief'], parameters: object({
    date: string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), limit: integer(1, 10),
  }) },
  { name: 'brainx_job_assessment', purpose: ['job_review'], parameters: object({ job_id: string() }, ['job_id']), projectKey: 'job_id' },
  { name: 'brainx_candidate_shortlist', purpose: ['candidate_review'], parameters: object({
    job_id: string(), page_token: string(), limit: integer(1, 5),
  }, ['job_id']), projectKey: 'job_id' },
  { name: 'brainx_candidate_facts', purpose: ['candidate_review', 'interview_prep'], groupRequiresProject: true, purposeKey: 'purpose', parameters: object({
    candidate_ref: string(), purpose: string({ enum: ['candidate_review', 'interview_prep'] }),
  }, ['candidate_ref', 'purpose']) },
  { name: 'brainx_candidate_fit', purpose: ['candidate_review'], parameters: object({
    job_id: string(), candidate_ref: string(),
  }, ['job_id', 'candidate_ref']), projectKey: 'job_id' },
  { name: 'brainx_gap_questions', purpose: ['job_review', 'candidate_review'], groupRequiresProject: true, parameters: object({
    object_type: string({ enum: ['job', 'candidate'] }), object_ref: string(), job_id: string(),
  }, ['object_type', 'object_ref']), resolveProject: (args) => (
    args.object_type === 'job' ? args.object_ref : args.job_id || null
  ) },
  { name: 'brainx_interview_prep', purpose: ['interview_prep'], parameters: object({
    job_id: string(), candidate_ref: string(),
  }, ['job_id', 'candidate_ref']), projectKey: 'job_id' },
  { name: 'brainx_personal_review', purpose: ['personal_review'], parameters: object({
    date_from: string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    date_to: string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  }, ['date_from', 'date_to']) },
  { name: 'brainx_run_status', purpose: ['run_status'], parameters: object({ run_id: string() }, ['run_id']) },
]);

export class AgentToolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AgentToolError';
    this.code = code;
  }
}

function invalid() {
  throw new AgentToolError('INVALID_ARGUMENT');
}

function validateValue(value, schema) {
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0)
        || value.length > (schema.maxLength || Infinity)) invalid();
    if (schema.enum && !schema.enum.includes(value)) invalid();
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) invalid();
    return;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) invalid();
  }
}

function validateArguments(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.some((key) => BANNED_ARGUMENTS.has(key) || !Object.hasOwn(schema.properties, key))) invalid();
  if (schema.required.some((key) => !Object.hasOwn(value, key))) invalid();
  for (const key of keys) validateValue(value[key], schema.properties[key]);
}

export function createToolRegistry(options = {}) {
  const handlers = options.handlers || {};
  const rows = new Map(AGENT_TOOL_ROWS.map((row) => [row.name, row]));
  return Object.freeze({
    version: 'agent-tools.v1',
    names: () => [...rows.keys()],
    has: (name) => rows.has(name),
    schema: (name) => rows.get(name)?.parameters || null,
    projectRef(name, args) {
      const row = rows.get(name);
      if (row?.resolveProject) return row.resolveProject(args);
      return row?.projectKey && typeof args?.[row.projectKey] === 'string' ? args[row.projectKey] : null;
    },
    requiresGroupProject(name) {
      return rows.get(name)?.groupRequiresProject === true;
    },
    async execute(name, args, context) {
      const row = rows.get(name);
      if (!row) throw new AgentToolError('TOOL_DISABLED');
      validateArguments(args, row.parameters);
      if (row.purposeKey && args[row.purposeKey] !== context.principal.purpose) invalid();
      const handler = handlers[name];
      if (typeof handler !== 'function') throw new AgentToolError('TOOL_DISABLED');
      return handler(args, context);
    },
  });
}

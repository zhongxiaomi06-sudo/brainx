const ALWAYS_FORBIDDEN_KEY = /(^|_)(phone|mobile|email|resume_raw|raw_resume|raw_text|access_token|refresh_token|secret|password|open_id|union_id)($|_)/i;
const GROUP_FORBIDDEN_KEY = /(^|_)(private_note|private_notes|candidate_salary|compensation|contact|feedback)($|_)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const CN_MOBILE = /(?:^|\D)1[3-9]\d{9}(?:\D|$)/;

export class AgentProjectionError extends Error {
  constructor() {
    super('PROJECTION_REJECTED');
    this.name = 'AgentProjectionError';
    this.code = 'INTERNAL';
  }
}

function reject() {
  throw new AgentProjectionError();
}

export function assertSafeAgentProjection(result, principal) {
  let visited = 0;
  const inspect = (value, depth) => {
    visited += 1;
    if (visited > 10_000 || depth > 16) reject();
    if (typeof value === 'string') {
      if (value.length > 30_000 || EMAIL.test(value) || CN_MOBILE.test(value)) reject();
      return;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') reject();
    for (const [key, child] of Object.entries(value)) {
      if (ALWAYS_FORBIDDEN_KEY.test(key)
          || (principal.chatType === 'group' && GROUP_FORBIDDEN_KEY.test(key))) reject();
      inspect(child, depth + 1);
    }
  };
  inspect(result, 0);
  return result;
}

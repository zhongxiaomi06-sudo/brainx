const OBJECT_TYPES = new Set(['opportunity', 'replay']);

export function productionBaseUrl(explicit) {
  const raw = explicit || process.env.BRAINX_BASE_URL;
  if (!raw) throw new Error('BRAINX_BASE_URL_REQUIRED');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('BRAINX_BASE_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('BRAINX_BASE_URL_INVALID');
  }
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function safeRef(value, code) {
  const text = String(value || '').trim();
  if (!text || text.length > 256 || /[\u0000-\u001f]/.test(text)) throw new Error(code);
  return text;
}

export function buildBrainxDeepLink({ baseUrl, objectType, objectRef, candidateRef }) {
  if (!OBJECT_TYPES.has(objectType)) throw new Error('DEEP_LINK_TYPE_INVALID');
  const target = productionBaseUrl(baseUrl);
  target.searchParams.set('open', `${objectType}:${safeRef(objectRef, 'DEEP_LINK_REF_INVALID')}`);
  if (candidateRef) target.searchParams.set('candidate', safeRef(candidateRef, 'CANDIDATE_REF_INVALID'));
  return target.href;
}

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const MAX_TTL_MS = 120_000;
const FUTURE_SKEW_MS = 5_000;
const PAYLOAD_KEYS = [
  'schema_version', 'request_id', 'nonce', 'channel', 'account_id',
  'requester_sender_id', 'chat_type', 'chat_id', 'thread_id', 'purpose',
  'tool_name', 'arguments_sha256', 'issued_at', 'expires_at',
];

export class PrincipalAssertionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PrincipalAssertionError';
    this.code = code;
  }
}

function fail(code) {
  throw new PrincipalAssertionError(code);
}

function assertSecret(secret) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ''), 'utf8');
  if (value.length < 32) fail('ASSERTION_INVALID');
  return value;
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('ASSERTION_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === undefined) fail('ASSERTION_INVALID');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('ASSERTION_INVALID');
  return `{${Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) fail('ASSERTION_INVALID');
    return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
  }).join(',')}}`;
}

export function hashArguments(argumentsValue) {
  return createHash('sha256').update(canonicalJson(argumentsValue)).digest('hex');
}

function parseDate(value) {
  if (typeof value !== 'string') fail('ASSERTION_INVALID');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) fail('ASSERTION_INVALID');
  return parsed;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('ASSERTION_INVALID');
  if (Object.keys(payload).sort().join('|') !== [...PAYLOAD_KEYS].sort().join('|')) {
    fail('ASSERTION_INVALID');
  }
  const nonEmpty = [
    'request_id', 'nonce', 'account_id', 'requester_sender_id', 'chat_id',
    'purpose', 'tool_name',
  ];
  if (payload.schema_version !== 'brainx_principal.v1' || payload.channel !== 'feishu') {
    fail('ASSERTION_INVALID');
  }
  if (!['p2p', 'group'].includes(payload.chat_type)) fail('ASSERTION_INVALID');
  if (nonEmpty.some((key) => typeof payload[key] !== 'string' || !payload[key])) {
    fail('ASSERTION_INVALID');
  }
  if (nonEmpty.some((key) => payload[key].length > 512)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.request_id)) {
    fail('ASSERTION_INVALID');
  }
  if (payload.thread_id !== null && (typeof payload.thread_id !== 'string' || !payload.thread_id)) {
    fail('ASSERTION_INVALID');
  }
  if (!/^[A-Za-z0-9_-]{16,}$/.test(payload.nonce)) fail('ASSERTION_INVALID');
  if (!/^[a-f0-9]{64}$/.test(payload.arguments_sha256)) fail('ASSERTION_INVALID');
  const issuedAt = parseDate(payload.issued_at);
  const expiresAt = parseDate(payload.expires_at);
  const ttl = expiresAt.getTime() - issuedAt.getTime();
  if (ttl <= 0 || ttl > MAX_TTL_MS) fail('ASSERTION_INVALID');
  return { issuedAt, expiresAt };
}

export function createPrincipalAssertion(input, options = {}) {
  const secret = assertSecret(options.secret);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const ttlSeconds = options.ttlSeconds ?? 60;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds * 1000 > MAX_TTL_MS) {
    fail('ASSERTION_INVALID');
  }
  const payload = {
    schema_version: 'brainx_principal.v1',
    request_id: input.request_id,
    nonce: input.nonce || randomBytes(18).toString('base64url'),
    channel: input.channel,
    account_id: input.account_id,
    requester_sender_id: input.requester_sender_id,
    chat_type: input.chat_type,
    chat_id: input.chat_id,
    thread_id: input.thread_id ?? null,
    purpose: input.purpose,
    tool_name: input.tool_name,
    arguments_sha256: hashArguments(input.arguments),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  validatePayload(payload);
  const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(canonicalJson(payload)).digest('base64url');
  return { assertion: `${encoded}.${signature}`, payload };
}

export function verifyPrincipalAssertion(assertion, options = {}) {
  const secret = assertSecret(options.secret);
  if (typeof assertion !== 'string' || assertion.length > 12_000) fail('UNAUTHENTICATED');
  const parts = assertion.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    fail('UNAUTHENTICATED');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    fail('UNAUTHENTICATED');
  }
  let canonical;
  try {
    canonical = canonicalJson(payload);
  } catch {
    fail('UNAUTHENTICATED');
  }
  if (Buffer.from(canonical).toString('base64url') !== parts[0]) fail('UNAUTHENTICATED');
  const expected = createHmac('sha256', secret).update(canonical).digest();
  const received = Buffer.from(parts[1], 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    fail('UNAUTHENTICATED');
  }
  const { issuedAt, expiresAt } = validatePayload(payload);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (issuedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) fail('ASSERTION_NOT_YET_VALID');
  if (expiresAt.getTime() <= now.getTime()) fail('ASSERTION_EXPIRED');
  if (payload.request_id !== options.requestId || payload.tool_name !== options.toolName
      || payload.arguments_sha256 !== hashArguments(options.arguments)) {
    fail('ASSERTION_MISMATCH');
  }
  return payload;
}

export function consumePrincipalNonce(db, payload, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  validatePayload(payload);
  try {
    db.prepare(`INSERT INTO agent_nonces (nonce, request_id, expires_at, consumed_at)
      VALUES (?, ?, ?, ?)`).run(payload.nonce, payload.request_id, payload.expires_at, now.toISOString());
    return true;
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE constraint')) fail('REPLAYED_REQUEST');
    throw error;
  }
}

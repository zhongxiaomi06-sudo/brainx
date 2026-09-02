import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { verifyPrincipalAssertion, consumePrincipalNonce } from './assertion.js';
import { authorizePrincipal } from './authorization.js';
import { beginAgentRun, authorizeAgentRun, beginToolCall, finishAgentRun, finishToolCall } from './audit.js';
import { successEnvelope, errorEnvelope } from './envelopes.js';
import { consumeRateLimit } from './rate-limit.js';
import { assertSafeAgentProjection } from './projection.js';

const BODY_LIMIT = 64 * 1024;
const TOOL_PATH = /^\/internal\/v1\/agent\/tools\/([a-z0-9_]+)$/;

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function tokenMatches(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) oversized = true;
    else chunks.push(chunk);
  }
  if (oversized) throw coded('BODY_TOO_LARGE');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw coded('INVALID_ARGUMENT');
  }
}

function validateRequestBody(value) {
  const exact = ['arguments', 'client', 'principal_assertion', 'request_id', 'schema_version'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('|') !== exact.sort().join('|')
      || value.schema_version !== 'agent_tool_request.v1'
      || typeof value.request_id !== 'string' || typeof value.principal_assertion !== 'string'
      || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)
      || !value.client || typeof value.client !== 'object' || Array.isArray(value.client)) {
    throw coded('INVALID_ARGUMENT');
  }
  const clientKeys = Object.keys(value.client);
  if (clientKeys.some((key) => !['plugin_version', 'openclaw_version', 'model_ref'].includes(key))
      || typeof value.client.plugin_version !== 'string'
      || typeof value.client.openclaw_version !== 'string') throw coded('INVALID_ARGUMENT');
  return value;
}

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function sendError(res, error, requestId) {
  if (error?.code === 'BODY_TOO_LARGE') {
    send(res, 413, { error: { code: 'INVALID_ARGUMENT', message: '请求体超过 64 KiB', retryable: false, request_id: requestId || null } });
    return;
  }
  const normalized = errorEnvelope(error, { requestId });
  const headers = normalized.retryAfter ? { 'retry-after': String(normalized.retryAfter) } : {};
  send(res, normalized.status, normalized.body, headers);
}

export function createAgentGatewayServer(config) {
  for (const value of [config.gatewayToken, config.assertionSecret, config.auditKey]) {
    if (Buffer.byteLength(String(value || ''), 'utf8') < 32) throw coded('GATEWAY_CONFIG_INVALID');
  }
  const appHashes = config.feishuAppKeyHashes || {};
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (pathname === '/internal/v1/agent/health') {
      if (req.method !== 'GET') return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      try {
        config.db.prepare('SELECT 1').get();
        return send(res, 200, { status: 'ready', sqlite: 'ready', tool_catalog_version: config.registry.version, tools: config.registry.names() });
      } catch {
        return send(res, 503, { status: 'unavailable', sqlite: 'unavailable', tool_catalog_version: config.registry.version, tools: config.registry.names() });
      }
    }
    const match = pathname.match(TOOL_PATH);
    if (!match) return sendError(res, coded('TOOL_DISABLED'));
    if (req.method !== 'POST') return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } }, { allow: 'POST' });
    if (!tokenMatches(req.headers.authorization, config.gatewayToken)) return sendError(res, coded('UNAUTHENTICATED'));
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return send(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    }
    const toolName = match[1];
    if (!config.registry.has(toolName)) return sendError(res, coded('TOOL_DISABLED'));
    let requestId = null;
    let runId = null;
    let toolCallId = null;
    try {
      const body = validateRequestBody(await readBody(req));
      requestId = body.request_id;
      const payload = verifyPrincipalAssertion(body.principal_assertion, {
        secret: config.assertionSecret, requestId, toolName, arguments: body.arguments,
      });
      consumePrincipalNonce(config.db, payload);
      runId = beginAgentRun(config.db, payload, {
        auditKey: config.auditKey, modelRef: body.client.model_ref,
        skillVersion: body.client.plugin_version,
      });
      const principal = authorizePrincipal(config.db, payload, {
        feishuAppKeyHash: appHashes[payload.account_id],
        projectRef: config.registry.projectRef(toolName, body.arguments),
        requireProjectScope: config.registry.requiresGroupProject(toolName),
        requireP2p: config.registry.requiresP2p(toolName),
      });
      authorizeAgentRun(config.db, runId, principal);
      consumeRateLimit(config.db, principal, toolName, {
        auditKey: config.auditKey, limit: config.rateLimit || 20,
        windowSeconds: config.rateLimitWindowSeconds || 60,
      });
      toolCallId = beginToolCall(config.db, {
        runId, toolName, toolVersion: config.registry.version, arguments: body.arguments,
        policyVersion: 'agent-auth.v1',
      });
      const result = await config.registry.execute(toolName, body.arguments, { principal, requestId, runId });
      assertSafeAgentProjection(result, principal);
      finishToolCall(config.db, toolCallId, {
        status: 'SUCCEEDED', dataVersions: result.source_versions,
        evidenceRefs: result.evidence_refs,
      });
      finishAgentRun(config.db, runId, { status: 'SUCCEEDED' });
      const envelope = successEnvelope({
        requestId, runId, toolName, principal, result,
        sourceVersions: result.source_versions, nextAllowedActions: result.next_allowed_actions,
      });
      return send(res, 200, envelope);
    } catch (error) {
      try {
        if (toolCallId) finishToolCall(config.db, toolCallId, { status: 'FAILED', errorCode: error.code || 'INTERNAL' });
        if (runId) finishAgentRun(config.db, runId, {
          status: ['UNBOUND_IDENTITY', 'NOT_FOUND_OR_FORBIDDEN', 'RATE_LIMITED'].includes(error.code) ? 'REFUSED' : 'FAILED',
          errorCode: error.code || 'INTERNAL',
        });
      } catch { /* 原错误优先；审计状态异常不向调用方泄露 */ }
      return sendError(res, error, requestId);
    }
  });
}

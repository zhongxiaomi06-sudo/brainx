/** baseline 推荐运行配置；集中校验既有环境变量，不引入新开关。 */
export const DEFAULT_RECOMMENDATION_CONFIG = Object.freeze({
  throttleMs: 2 * 60 * 60 * 1000,
  skipAuditMs: 60 * 60 * 1000,
  persistLimit: 200,
});

function integer(env, name, fallback, minimum) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw new Error(`RECOMMENDATION_CONFIG_INVALID:${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`RECOMMENDATION_CONFIG_INVALID:${name}`);
  }
  return value;
}

export function recommendationConfigFromEnv(env = process.env) {
  return Object.freeze({
    throttleMs: integer(env, 'BRAINX_RECOMMEND_THROTTLE_MS',
      DEFAULT_RECOMMENDATION_CONFIG.throttleMs, 0),
    skipAuditMs: integer(env, 'BRAINX_SKIP_AUDIT_MS',
      DEFAULT_RECOMMENDATION_CONFIG.skipAuditMs, 0),
    persistLimit: integer(env, 'BRAINX_RECOMMEND_PERSIST_LIMIT',
      DEFAULT_RECOMMENDATION_CONFIG.persistLimit, 1),
  });
}

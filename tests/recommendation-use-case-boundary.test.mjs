import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import {
  DEFAULT_RECOMMENDATION_CONFIG,
  recommendationConfigFromEnv,
} from '../src/recommendation-config.js';
import { createRecommendationUseCase } from '../src/recommendation-use-case.js';
import { recommendationRoutes } from '../src/recommendation-routes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path) => readFileSync(join(ROOT, path), 'utf8');

test('推荐配置集中保留缺省值并对非法数值失败关闭', () => {
  assert.deepEqual(recommendationConfigFromEnv({}), DEFAULT_RECOMMENDATION_CONFIG);
  assert.deepEqual(recommendationConfigFromEnv({
    BRAINX_RECOMMEND_THROTTLE_MS: '60000',
    BRAINX_SKIP_AUDIT_MS: '30000',
    BRAINX_RECOMMEND_PERSIST_LIMIT: '50',
  }), { throttleMs: 60000, skipAuditMs: 30000, persistLimit: 50 });
  for (const env of [
    { BRAINX_RECOMMEND_THROTTLE_MS: '-1' },
    { BRAINX_SKIP_AUDIT_MS: 'NaN' },
    { BRAINX_RECOMMEND_PERSIST_LIMIT: '0' },
    { BRAINX_RECOMMEND_PERSIST_LIMIT: '1.5' },
  ]) assert.throws(() => recommendationConfigFromEnv(env), /RECOMMENDATION_CONFIG_INVALID/);
});

test('唯一用例覆盖生成、读取、顾问与上下文，兼容结果保持 baseline-1.1', () => {
  const db = openDb(':memory:');
  try {
    runSync(db, { source: 'fixture', consultant_id: 'felix' });
    const recommendations = createRecommendationUseCase(db);
    const facade = recommend(db, 'felix', { top: 5, dry_run: true });
    const direct = recommendations.run('felix', { top: 5, dry_run: true });
    assert.deepEqual(direct.items.map((item) => [item.job.project_id, item.score]),
      facade.items.map((item) => [item.job.project_id, item.score]));
    const output = recommendations.run('felix', { top: 5 });
    assert.equal(output.policy_version, 'baseline-1.1');
    assert.equal(output.items.length, 5);
    const latest = recommendations.latest('felix');
    assert.equal(latest.run.run_id, output.run_id);
    assert.deepEqual(latest.items.slice(0, 5).map((item) => item.job.project_id),
      output.items.map((item) => item.job.project_id));
    assert.equal(recommendations.readRun('felix', output.run_id).items.length,
      latest.items.length);
    assert.ok(recommendations.consultants().some((item) => item.consultant_id === 'felix'));
    assert.equal(recommendations.buildContext('felix', null).consultant_id, 'felix');
  } finally {
    db.close();
  }
});

test('用例在组装时校验 repository port，不把缺依赖拖到运行期', () => {
  assert.throws(() => createRecommendationUseCase({}, { repository: {} }),
    /RECOMMENDATION_REPOSITORY_INVALID:consultants/);
});

test('API、CLI、scheduler 与 worker 只依赖推荐用例，领域编排不含 SQL', () => {
  const entrypoints = [
    'src/server.js',
    'src/scheduler.js',
    'src/worker.js',
    'bin/brainx-recommend.mjs',
    'bin/brainx-push.mjs',
    'mcp/server.mjs',
  ];
  for (const path of entrypoints) {
    const text = source(path);
    assert.doesNotMatch(text, /from ['"][^'"]*recommend\.js['"]/,
      `${path} 不得绕过推荐用例`);
    assert.match(text, /recommendation-use-case\.js/,
      `${path} 必须组装或接收推荐用例`);
  }
  const useCase = source('src/recommendation-use-case.js');
  assert.doesNotMatch(useCase, /\.prepare\(|\.exec\(|\b(?:decision_runs|recommendations|job_facts)\b/);
  assert.doesNotMatch(useCase, /from ['"]\.\/recommend\.js['"]/);
  assert.doesNotMatch(source('src/recommendation-repository.js'), /recommendation-use-case\.js/);
  assert.match(source('src/recommend.js'), /recommendation-use-case\.js/);
});

test('推荐 route factory 完整拥有原路由并由 server 组装', () => {
  const routes = recommendationRoutes({}, {
    recommendations: { run: () => ({ blocked: false }) },
  });
  assert.deepEqual(Object.keys(routes).sort(), [
    'GET /api/v1/feedback/quick',
    'GET /api/v1/recommendations',
    'GET /api/v1/recommendations/pick-tray',
    'POST /api/v1/recommendations/feedback',
    'POST /api/v1/recommendations/feedback/undo',
    'POST /api/v1/recommendations/next-batch',
    'POST /api/v1/recommendations/run',
  ]);
  const server = source('src/server.js');
  assert.match(server, /\.\.\.recommendationRoutes\(db,/);
  assert.doesNotMatch(server, /['"]POST \/api\/v1\/recommendations\/run['"]\s*:/);
});

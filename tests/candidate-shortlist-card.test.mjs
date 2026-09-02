import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateShortlistCard } from '../src/candidate-shortlist-card.js';

test('候选推荐卡片：展示 Agent 判断并提供 BrainX 查询按钮', () => {
  const card = buildCandidateShortlistCard({
    jobName: '沐仞科技 HR岗',
    jobId: 'job-hr-1',
    candidateRef: 'cand-opaque-1',
    analysisMarkdown: '**一句话判断**：先看郭*，重点核实基础人事经验。',
    publicBaseUrl: 'https://base.yorkteam.cn/',
    sourceLabel: 'reloop 结构化事实 · OpenClaw 分析',
  });
  assert.match(card.header.title.content, /沐仞科技 HR岗/);
  assert.match(card.elements[0].content, /一句话判断/);
  const action = card.elements.find((element) => element.tag === 'action');
  assert.equal(action.actions[0].text.content, '打开 BrainX 查询');
  const target = new URL(action.actions[0].multi_url.url);
  assert.equal(target.origin, 'https://base.yorkteam.cn');
  assert.equal(target.searchParams.get('open'), 'opportunity:job-hr-1');
  assert.equal(target.searchParams.get('candidate'), 'cand-opaque-1');
});

test('候选推荐卡片：拒绝联系方式与非 HTTP 深链', () => {
  assert.throws(() => buildCandidateShortlistCard({
    jobName: '职位', jobId: 'job-1', analysisMarkdown: '联系 13800000000', publicBaseUrl: 'https://base.yorkteam.cn/',
  }), /SENSITIVE_DATA/);
  assert.throws(() => buildCandidateShortlistCard({
    jobName: '职位', jobId: 'job-1', analysisMarkdown: '安全内容', publicBaseUrl: 'http://127.0.0.1:3000',
  }), /BRAINX_BASE_URL_INVALID/);
});

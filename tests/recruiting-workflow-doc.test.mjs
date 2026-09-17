import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../docs/design/braintex-ai-recruiting-os.html', import.meta.url), 'utf8');
const nodes = [...html.matchAll(/<details class="node[^"]*">([\s\S]*?)<\/details>/g)].map((hit) => hit[1]);

test('工作流四阶段十六节点均有默认折叠的技术栈、机制与答疑', () => {
  assert.equal((html.match(/class="stage"/g) || []).length, 4);
  assert.equal(nodes.length, 16);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
  for (const node of nodes) {
    assert.match(node, /<summary>[\s\S]*<h3>[^<]+<\/h3>[\s\S]*<\/summary>/);
    assert.match(node, /class="tech-status">[^<]+</);
    assert.match(node, /class="tech-stack" aria-label="技术栈">(?:\s*<li>[^<]+<\/li>){3}\s*<\/ul>/);
    assert.match(node, /class="tech-mechanism">[^<]+</);
    assert.match(node, /class="tech-boundary"><span>Q&amp;A<\/span>[^<]+</);
  }
});

test('工作流答疑保留算法、写入范围与未验收边界', () => {
  for (const text of [
    '不是 LLM 直接打分', '不是当前正式排序', '不是自动训练',
    '两者共用上游 completions 接口', 'RDS 人才库', '不能据此承诺已同步',
    '未接自动拨号', '条件缓存为进程内存', '没有调用 LLM 做独立 Offer 评分',
    '待目标环境验证', '尚未自动回写知识库',
  ]) assert.ok(html.includes(text), `缺少边界：${text}`);
});

test('工作流锚点完整且不引入外部脚本或远端资源', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((hit) => hit[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(target), target);
  assert.doesNotMatch(html, /<script\b|(?:src|href)="https?:/);
});

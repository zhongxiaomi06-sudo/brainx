#!/usr/bin/env node
/** brainx-fact-agent — 字段补全 Agent CLI（specs/023 施工序③，FR-5 三重开关之一）。
 *
 * 模式（显式传参，缺省 dry-run）：
 *   --dry-run    只跑解析+预筛并输出统计（零 token、零落库；第一轮数据验证入口）
 *   --backfill   存量信号消息回填（GLM 抽取 + 落库）
 *   --since=Nd   增量抽取（近 N 天滚动窗口，幂等键天然去重）
 *   --limit=N    候选扫描上限（默认 5000）
 *   --json       统计以单行 JSON 输出（供 systemd/脚本消费）
 *
 * 开关（FR-5）：BRAINX_FACT_AGENT=1 才允许 --backfill/--since 走 GLM+落库；
 * 未开时显式传 --backfill/--since 会降级 dry-run 并打印一行提示（禁止静默失败）。
 * LLM 配置（走既有个人模型配置体系，specs/004）：FACT_AGENT_KEY（或 ZHIPU_API_KEY）、
 * GLM_BASE_URL（缺省 https://open.bigmodel.cn/api/paas/v4）、GLM_MODEL（缺省 glm-4-flash）。
 *
 * 用法：node bin/brainx-fact-agent.mjs [--dry-run|--backfill|--since=Nd] [--limit=N] [--json]
 *   成功 stdout 统计（--json 单行 JSON）；失败 stderr + 退出码 1。
 */
import '../src/env.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runFactAgentPipeline } from '../src/fact-agent-extract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { mode: 'dry-run', limit: 5000, since: null, json: false };
  for (const a of argv) {
    if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--backfill') args.mode = 'backfill';
    else if (a.startsWith('--since=')) {
      const m = a.slice(8).match(/^(\d+)d$/);
      if (!m) { console.error('--since 只支持 Nd 形式（如 --since=7d）'); process.exit(1); }
      args.since = new Date(Date.now() - Number(m[1]) * 86400000).toISOString();
      args.mode = 'since';
    } else if (a.startsWith('--limit=')) args.limit = Number(a.slice(8)) || 5000;
    else if (a === '--json') args.json = true;
    else { console.error(`未知参数: ${a}`); process.exit(1); }
  }
  return args;
}

/** GLM 端点解析（specs/004 模型配置体系；key 不进 Git，只走 .env）。 */
function resolveLlm() {
  const apiKey = process.env.FACT_AGENT_KEY || process.env.ZHIPU_API_KEY || '';
  const baseUrl = (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
  const model = process.env.GLM_MODEL || 'glm-4-flash';
  if (!apiKey) return { llm: null, model, reason: 'LLM_KEY_MISSING' };
  const llm = async ({ system, user }) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' }, temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`FACT_AGENT_HTTP_${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  };
  return { llm, model };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const killSwitchOn = process.env.BRAINX_FACT_AGENT === '1';

  // FR-5：kill-switch 关闭 → 一律 dry-run（显式提示，不静默降级）
  if (args.mode !== 'dry-run' && !killSwitchOn) {
    console.error('[fact-agent] --backfill/--since 需要 BRAINX_FACT_AGENT=1（当前未开），按 dry-run 执行');
    args.mode = 'dry-run';
  }

  const dbPath = process.env.BRAINX_DB_PATH || join(ROOT, 'data', 'brainx.db');
  const db = new DatabaseSync(dbPath);

  let llm = null;
  let modelName = 'glm-fact-agent-v1';
  if (args.mode !== 'dry-run') {
    const r = resolveLlm();
    if (!r.llm) {
      console.error(`[fact-agent] LLM 未配置（${r.reason}）：.env 需 FACT_AGENT_KEY（或 ZHIPU_API_KEY）`);
      db.close();
      process.exit(1);
    }
    llm = r.llm;
    modelName = `${process.env.GLM_MODEL || 'glm-4-flash'}-fact-agent-v1`;
  }

  try {
    const { stats } = await runFactAgentPipeline(db, {
      llm, modelName, since: args.since, limit: args.limit,
    });
    const out = { mode: args.mode, since: args.since, ...stats };
    if (args.json) console.log(JSON.stringify(out));
    else {
      console.log('[fact-agent] 本轮统计：');
      console.log(`  模式=${out.mode}  扫描=${stats.scanned}  预筛命中=${stats.candidates}`);
      console.log(`  GLM 批次=${stats.llmBatches}(失败${stats.llmFailures})  抽出=${stats.extracted}`);
      console.log(`  落库=${stats.inserted}(重复${stats.duplicates} 不合格${stats.invalid})`);
      console.log(`  字段分布=${JSON.stringify(stats.byField)}  消歧=${JSON.stringify(stats.fork)}`);
      console.log(`  低置信(<0.7 不进合成)=${stats.belowThreshold}  丢弃原因=${JSON.stringify(stats.dropReasons)}`);
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(`[fact-agent] 执行失败: ${e?.message || e}`);
  process.exit(1);
});

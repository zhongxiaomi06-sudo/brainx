#!/usr/bin/env node
/** brainx-profile-init — 顾问画像首初始化（冷启动画像补齐）。
 *
 * 对 profile_keywords 为空（或 --force 指定）的顾问：gatherProfileEvidence 汇总业务证据 →
 * LLM（agent 算法）评估产出建议关键词 → dry-run 打印提案 + 覆盖率评估；--write 经
 * updateProfile 落库（合并保留既有键，下一轮 recommend 即生效）。
 * 用法：node bin/brainx-profile-init.mjs --consultant linda [--write|--force] [--json]
 *       node bin/brainx-profile-init.mjs --all-empty [--write]
 */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { updateProfile } from '../src/roster.js';
import { chatJson, isLlmConfigured } from '../src/llm.js';
import {
  gatherProfileEvidence, buildProfilePrompt, parseProfileProposal, evaluateProposal,
} from '../src/profile-init.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : null; };
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

function targets(db) {
  if (arg('consultant')) return [arg('consultant')];
  if (process.argv.includes('--all-empty')) {
    // 在 JS 侧判空（profile_json 是自由 JSON，SQL LIKE 不可靠）
    return db.prepare('SELECT consultant_id, profile_json FROM consultants WHERE active=1').all()
      .filter((r) => !(JSON.parse(r.profile_json || '{}').profile_keywords || []).length)
      .map((r) => r.consultant_id);
  }
  console.error('用法：--consultant <id> 或 --all-empty'); process.exit(64);
}

async function main() {
  const db = openDb();
  if (!isLlmConfigured()) { console.error('LLM 未配置（BRAINX_LLM_*）'); process.exit(1); }
  const results = [];
  for (const cid of targets(db)) {
    const cur = db.prepare('SELECT profile_json FROM consultants WHERE consultant_id=? AND active=1').get(cid);
    if (!cur) { results.push({ consultant: cid, skipped: 'not_found' }); continue; }
    const hasKeywords = (JSON.parse(cur.profile_json || '{}').profile_keywords || []).length > 0;
    if (hasKeywords && !FORCE) { results.push({ consultant: cid, skipped: 'profile_exists' }); continue; }

    const evidence = gatherProfileEvidence(db, cid);
    if (!evidence.job_count && !evidence.own_job_count) {
      results.push({ consultant: cid, skipped: 'no_evidence',
        note: '无群关联职位且无策展/主做职位——先接入群或承接职位再建档' });
      continue;
    }
    const { system, user } = buildProfilePrompt(evidence);
    const raw = await chatJson(system, user);
    const proposal = parseProfileProposal(raw);
    if (!proposal.ok) { results.push({ consultant: cid, skipped: proposal.error }); continue; }
    const evaluation = evaluateProposal(db, cid, proposal.profile_keywords);
    const entry = { consultant: cid, evidence_jobs: evidence.job_count, own_jobs: evidence.own_job_count,
      proposal, evaluation };
    if (WRITE) {
      const r = updateProfile(db, cid, proposal);
      entry.written = r.ok === true;
      if (!r.ok) entry.error = r.error;
    }
    results.push(entry);
  }
  console.log(JSON.stringify(results, null, 2));
  if (!WRITE) console.error('（dry-run，加 --write 落库；只补空白画像，--force 才覆盖）');
}

main().catch((e) => { console.error(e); process.exit(1); });

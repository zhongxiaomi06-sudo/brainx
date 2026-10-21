/** 链路完整性回放：生产最近 25 条 job_facts 过 spec 040 全链解析，逐级核对传导。
 * 样本文件：/tmp/jf-samples.json（从生产 brainx.db 只读导出，见 docs/AGENT_COMMIT_LOG 2026-10-21）。
 * 用法：node --test 无关；直接 node tests/replay-chain-1021.mjs（在仓库根目录）。
 * 只读样本；DB 相关环节用内存库，不碰生产。 */
import { readFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import {
  jobNotesText, sanitizeJdNotes, parseExperienceRange, cleanPipeline, buildAutoSearchCriteria,
} from '../src/auto-search.js';
import { compileSearchCriteria, readCompiledCriteria, buildCriteriaText } from '../src/criteria-compile.js';

const samples = JSON.parse(readFileSync('/tmp/jf-samples.json', 'utf8'));
const issues = [];
const stats = { notes: { col: 0, raw: 0, none: 0 }, years: { explicit: 0, fallback: 0 }, llmPath: 0, rulesPath: 0 };

const AGE_RESIDUE = [/年龄限制/, /\d{2}\s*岁以[内下]/, /(女|男)生?优先/, /限(女|男)性/];
const hasResidue = (t) => AGE_RESIDUE.some((re) => re.test(t));

for (const job of samples) {
  const pid = job.project_id;

  // L1 取值层
  const source = job.notes && String(job.notes).trim() ? 'notes列'
    : (() => { try { const r = JSON.parse(job.raw_json || '{}'); return r.notes ? 'raw_json.notes' : (r.requirements ? 'raw_json.requirements' : '无'); } catch { return 'raw_json损坏'; } })();
  if (source === 'notes列') stats.notes.col += 1; else if (source.startsWith('raw_json')) stats.notes.raw += 1; else stats.notes.none += 1;
  const rawNotes = jobNotesText(job);

  // L2 净化层：出参不得残留歧视模式
  const sanitized = sanitizeJdNotes(rawNotes);
  if (sanitized && hasResidue(sanitized)) issues.push(`[L2-残留] ${pid} 净化后仍含歧视条件: ${sanitized.slice(0, 80)}`);
  if (sanitized && sanitized.length > 500) issues.push(`[L2-超长] ${pid} 净化后 ${sanitized.length} 字 > 500`);

  // L3 年限层：显式年限 vs 兜底
  const years = parseExperienceRange(sanitized);
  if (years) stats.years.explicit += 1; else stats.years.fallback += 1;
  if (sanitized) {
    const reM = sanitized.match(/(?<!\d)(\d{1,2})\s*[-–~至]\s*(\d{1,2})\s*年/g);
    if (reM && !years) issues.push(`[L3-漏解析] ${pid} 原文含区间 "${reM[0]}" 但解析为 null`);
  }

  // L4 漏斗清洗层
  const pipe = cleanPipeline(job.pipeline);
  if (pipe && /Interview|Offer|Recommendation|Sourcing|Onboarding|Hired|Shortlist|Screening/.test(pipe)) {
    issues.push(`[L4-漏斗残留] ${pid} pipeline 清洗后仍含漏斗词: ${pipe.slice(0, 60)}`);
  }

  // L5 判据组装层
  const criteria = buildAutoSearchCriteria(job);
  if (!criteria) { issues.push(`[L5-无判据] ${pid} role/company 均缺`); continue; }
  if (job.role && !criteria.includes(job.role)) issues.push(`[L5-丢role] ${pid}`);
  if (job.city && !criteria.includes(job.city)) issues.push(`[L5-丢city] ${pid}`);
  if (job.company && !criteria.includes(`（招聘方：${job.company}）`)) issues.push(`[L5-丢招聘方] ${pid}`);
  if (hasResidue(criteria)) issues.push(`[L5-歧视入判据] ${pid}`);
  if (/Interview×|Offer×|Recommendation×/.test(criteria)) issues.push(`[L5-漏斗入判据] ${pid}`);
  if (!/\d-\d+ 年工作经验|年以上工作经验/.test(criteria)) issues.push(`[L5-无年限段] ${pid}: ${criteria.slice(0, 60)}`);
}

// L6 编译+回读链（mock LLM）：写入事件 → readCompiledCriteria 回读字段一致性
const db = openDb(':memory:');
const at = now();
db.prepare(`INSERT INTO sync_runs (sync_id,consultant_id,source,as_of,rows_expected,rows_read,complete,errors,input_hash,started_at,completed_at)
  VALUES ('sync-r','felix','test',?,1,1,1,'[]','h',?,?)`).run(at, at, at);
db.prepare(`INSERT INTO job_facts (project_id,company,role,city,hc,active_state,captured_at,sync_id,raw_json,updated_at)
  VALUES ('P-REPLAY','回放公司','回放岗位','北京市',1,'OPEN',?,'sync-r','{}',?)`).run(at, at);

for (const [i, job] of samples.slice(0, 10).entries()) {
  const pid = `P-REPLAY-${i}`;
  const mockReply = {
    role_focus: `${job.role || '岗位'}（回放编译）`,
    hard_requirements: ['硬条件A', '硬条件B'],
    preferences: ['偏好A'], exclusions: ['排除A'],
    years_range: '3-8', city_override: null, city_source: null,
  };
  const out = await compileSearchCriteria(db, job, {
    projectId: pid, round: 1,
    dependencies: { isLlmConfigured: () => true, chatJson: async () => mockReply },
  });
  if (out.criteria_source !== 'llm_compiled') { issues.push(`[L6-编译失败] ${pid} source=${out.criteria_source}`); continue; }
  stats.llmPath += 1;
  if (!out.criteria.includes('硬条件A') || !out.criteria.includes('排除A')) issues.push(`[L6-字段丢失] ${pid}`);
  if (hasResidue(out.criteria)) issues.push(`[L6-歧视入编译判据] ${pid}`);
  // 回读一致性
  const back = readCompiledCriteria(db, pid);
  if (!back) { issues.push(`[L6-回读null] ${pid}`); continue; }
  if (back.criteria_source !== 'llm_compiled') issues.push(`[L6-回读source错] ${pid}`);
  if (JSON.stringify(back.hard_requirements) !== JSON.stringify(mockReply.hard_requirements)) issues.push(`[L6-回读硬条件不一致] ${pid}`);
  if (back.years_range !== '3-8') issues.push(`[L6-回读年限不一致] ${pid}`);
  // S3 场景模拟：rules 兜底事件（compiled=null）回读应为 null（S3 静默跳过）
  const rulesOut = await compileSearchCriteria(db, job, { projectId: `${pid}-R`, round: 1, dependencies: { isLlmConfigured: () => false } });
  stats.rulesPath += 1;
  if (rulesOut.criteria_source !== 'rules') issues.push(`[L6-rules路径错] ${pid}`);
  if (readCompiledCriteria(db, `${pid}-R`) !== null) issues.push(`[L6-rules回读应null] ${pid}`);
}

// L7 盲区攻击：变体歧视表述 + 年限变体（预期暴露 sanitize 正则盲区）
const blindSpots = [
  ['不超过35岁', /不超过35岁/], ['90后优先', /90后/], ['只要男的', /只要男的/],
  ['男性为佳', /男性为佳/], ['35岁以下', null], ['女生优先', null], ['限男性', null],
];
const yearVariants = [
  ['3-8年', '3-8 年'], ['3~5年', '3-5 年'], ['5 年以上', '5 年以上'],
  ['3 - 5 年', '3-5 年'], ['三年以上经验', null], ['2024-2025年项目', null],
];
console.log('=== L7 净化盲区攻击 ===');
for (const [phrase, expectLeak] of blindSpots) {
  const out = sanitizeJdNotes(`岗位职责若干。${phrase}。其他要求待定。`);
  const leaked = out && out.includes(phrase.replace(/优先|为佳/g, ''));
  const strictLeak = out && out.includes(phrase);
  if (expectLeak ? strictLeak : strictLeak) {
    console.log(`  ❌ 漏剥: "${phrase}" → 净化后: "${out}"`);
    issues.push(`[L7-漏剥] "${phrase}"`);
  } else {
    console.log(`  ✅ 已剥: "${phrase}" → "${out}"`);
  }
}
console.log('=== L7 年限变体 ===');
for (const [text, expect] of yearVariants) {
  const got = parseExperienceRange(`岗位要求：${text}，其他若干。`);
  const ok = expect ? got === expect : got === null;
  console.log(`  ${ok ? '✅' : '❌'} "${text}" → ${got ?? 'null'}${expect ? `（期望 ${expect}）` : '（期望 null）'}`);
  if (!ok) issues.push(`[L7-年限] "${text}" → ${got}`);
}

console.log('\n=== 回放汇总（25 条生产 JD） ===');
console.log(`L1 取值来源: notes列=${stats.notes.col} raw_json=${stats.notes.raw} 无=${stats.notes.none}`);
console.log(`L3 年限: 显式=${stats.years.explicit} 兜底3-5年=${stats.years.fallback}`);
console.log(`L6 编译链: llm_compiled=${stats.llmPath} rules=${stats.rulesPath}`);
console.log(`\n发现问题 ${issues.length} 条:`);
issues.forEach((s) => console.log('  ' + s));

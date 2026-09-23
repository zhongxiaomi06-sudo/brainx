#!/usr/bin/env node
/** brainx-draft-cleanup — 草稿 GLM 语义清洗管线（specs/003 延伸，云端运行）。
 *
 * 设计给 ECS 上跑：直接读写 /opt/brainx/data/brainx.db，工作文件留在
 * BRAINX_DRAFT_CLEANUP_DIR（缺省 data/draft-cleanup，随数据盘），本地零拷贝。
 *
 * 阶段：
 *   extract   全量导出待洗清单：A 批 = 全部 rejected（不抽样）+ 消息原文；
 *             B 批 = 全部 pending。零 LLM、零网络。
 *   classify  调 GLM 批量语义分类/拆稿建议（A 批三分类，B 批多职位拆分）。
 *             断点续跑：结果 JSONL 按 draft_id 去重追加。
 *   apply     默认 dry-run；--apply 才写库：A 批 REAL_JOB → 新 pending（source='llm-recovery'，
 *             按 message_id 幂等）；B 批 → 拆稿 pending（source='llm-split'）+ 原稿转 rejected 留底。
 *             复活/拆稿一律 pending 等人工确认，绝不直接转正；不发评审事件。
 *   report    GLM 判定 vs 规则版对账 → 规则缺口清单 markdown。
 *
 * env：BRAINX_DB_PATH、BRAINX_DRAFT_CLEANUP_DIR、ZHIPU_API_KEY（classify/apply 必需）、
 *      GLM_MODEL（缺省 glm-5.3）、GLM_BASE_URL（缺省 https://open.bigmodel.cn/api/paas/v4）、
 *      GLM_CONCURRENCY（缺省 4）、BRAINX_LLM_CLEANUP（=1 才允许 classify/apply，kill-switch）。
 * 用法：node bin/brainx-draft-cleanup.mjs <extract|classify|apply|report> [--batch N] [--apply]
 *   成功 stdout 一行 JSON 摘要；失败 stderr + 退出码（锁占用=75，其余=1）。
 */
import '../src/env.js';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { now } from '../src/db.js';
import {
  buildSplitDrafts, diffAgainstRules, parseClassifyResponse, parseJobsResponse, recoveryUpdateOf,
} from '../src/draft-cleanup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_EXIT_CODE = 75;
const LOCK_FILE = '.draft-cleanup.lock';
const A_SUFFIX = 'rejected-all.jsonl';   // A 批清单（全量 rejected）
const B_SUFFIX = 'pending-all.jsonl';    // B 批清单（全量 pending）
const A_RESULT = 'classify-recovered.jsonl';
const B_RESULT = 'classify-pending.jsonl';

let db; // 进程内单连接

// node:sqlite 顶层导入，同步打开
import { DatabaseSync } from 'node:sqlite';

function openDbSync(readOnly = false) {
  if (db) return db;
  const dbPath = process.env.BRAINX_DB_PATH || join(ROOT, 'data', 'brainx.db');
  db = new DatabaseSync(dbPath, { readOnly });
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

function workDir() {
  const dir = process.env.BRAINX_DRAFT_CLEANUP_DIR || join(ROOT, 'data', 'draft-cleanup');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function acquireLock(dir) {
  const lockPath = join(dir, LOCK_FILE);
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e?.code === 'EEXIST') throw new LockHeld(lockPath);
    throw e;
  }
  return () => {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  };
}

class LockHeld extends Error {
  constructor(p) { super(`另一清洗实例正在运行（${p}）`); this.code = 'LOCK_HELD'; }
}

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim());
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function readJsonlIds(path) {
  if (!existsSync(path)) return new Set();
  const set = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { set.add(JSON.parse(line).draft_id); } catch { /* skip */ }
  }
  return set;
}

/** extract：A 批全量 rejected + B 批全量 pending，join lark_messages 原文（超龄已归档的记 missing）。 */
function phaseExtract() {
  const d = openDbSync(true); // extract 全程只读，零写入
  const dir = workDir();
  const counts = { a: 0, a_missing_text: 0, b: 0, b_missing_text: 0 };
  const dump = (status, suffix, counter, missCounter) => {
    const out = createWriteStream(join(dir, suffix));
    const rows = d.prepare(`SELECT dr.draft_id, dr.event_id, dr.message_id, dr.chat_id, dr.company, dr.company_evidence,
        dr.role, dr.role_evidence, dr.city, dr.city_evidence, dr.pipeline_stage, dr.pipeline_evidence,
        dr.hc, dr.hc_evidence, dr.active_state, dr.state_evidence,
        dr.origin, dr.raw_json, lm.text AS raw_text
      FROM job_facts_drafts dr
      LEFT JOIN lark_messages lm ON lm.message_id = dr.message_id
      WHERE dr.status = ?`).iterate(status);
    for (const r of rows) {
      out.write(JSON.stringify({ ...r, raw_text: r.raw_text ?? null }) + '\n');
      counts[counter] += 1;
      if (r.raw_text == null) counts[missCounter] += 1;
    }
    out.end();
  };
  dump('rejected', A_SUFFIX, 'a', 'a_missing_text');
  dump('pending', B_SUFFIX, 'b', 'b_missing_text');
  return { ok: true, phase: 'extract', dir, ...counts };
}

/** GLM chat 调用（OpenAI 兼容格式）。 */
async function glmChat(messages) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) throw new Error('缺 ZHIPU_API_KEY');
  const base = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const model = process.env.GLM_MODEL || 'glm-5.3';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 500 }),
  });
  if (!res.ok) throw new Error(`GLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j?.choices?.[0]?.message?.content || '';
}

const A_PROMPT = (item) => [
  { role: 'system', content: '你是招聘群消息的语义分析器。只输出一个 JSON 对象，不要输出其他内容。' },
  { role: 'user', content: `以下是猎头客户群的一条消息与规则引擎抽取结果。判断这条消息是否包含真实的招聘岗位：\n`
      + `REAL_JOB=明确在招岗位；SUSPECTED=疑似招聘但信息不足；NOT_JOB=寒暄/通知/会议/其他。\n`
      + `REAL_JOB 时用 role_hint 从原文提炼岗位名（120 字内）。\n`
      + `输出格式：{"verdict":"REAL_JOB|SUSPECTED|NOT_JOB","reason":"一句话依据","role_hint":"仅 REAL_JOB 时给"}\n\n`
      + `规则抽取结果：company=${item.company || '无'}，role=${item.role || '无'}，city=${item.city || '无'}\n`
      + `消息原文：\n${String(item.raw_text || '').slice(0, 1500)}` },
];

const B_PROMPT = (item) => [
  { role: 'system', content: '你是招聘群消息的语义分析器。只输出一个 JSON 对象，不要输出其他内容。' },
  { role: 'user', content: `以下是猎头客户群的一条消息与现有草稿。这条消息可能实际包含多个职位的混排。请按职位逐个拆出结构化字段（company=公司名；role=岗位名；city；pipeline_stage=OFFER/INTERVIEW/SCREENING/SOURCING/OPEN/未知留空；hc=招聘人数数字；active_state=OPEN/CLOSED/UNKNOWN；各 *_evidence=原文依据短语）。没有的职位不要编造。\n`
      + `输出格式：{"jobs":[{...}, ...]}\n\n`
      + `现有草稿字段：company=${item.company || '无'}，role=${item.role || '无'}\n`
      + `消息原文：\n${String(item.raw_text || '').slice(0, 2500)}` },
];

async function phaseClassify(kind) {
  if (process.env.BRAINX_LLM_CLEANUP !== '1') {
    throw new Error('kill-switch 未开：需 BRAINX_LLM_CLEANUP=1');
  }
  const dir = workDir();
  const release = acquireLock(dir);
  try {
    const listPath = join(dir, kind === 'a' ? A_SUFFIX : B_SUFFIX);
    const resultPath = join(dir, kind === 'a' ? A_RESULT : B_RESULT);
    const items = await readJsonl(listPath);
    const done = readJsonlIds(resultPath);
    let todo = items.filter((it) => !done.has(it.draft_id));
    const limitIx = process.argv.indexOf('--limit');
    if (limitIx !== -1 && Number(process.argv[limitIx + 1]) > 0) {
      todo = todo.slice(0, Number(process.argv[limitIx + 1])); // 冒烟用：只跑前 N 条
    }
    const conc = Math.max(1, Math.min(16, Number(process.env.GLM_CONCURRENCY) || 4));
    let ok = 0, failed = 0, idx = 0;
    const worker = async () => {
      while (idx < todo.length) {
        const it = todo[idx++];
        try {
          const content = await glmChat(kind === 'a' ? A_PROMPT(it) : B_PROMPT(it));
          const parsed = kind === 'a' ? parseClassifyResponse(content) : parseJobsResponse(content);
          if (!parsed) { failed += 1; continue; }
          await appendFile(resultPath, JSON.stringify({ draft_id: it.draft_id, message_id: it.message_id, result: parsed }) + '\n');
          ok += 1;
        } catch (e) {
          failed += 1;
          console.error(`[cleanup] ${it.draft_id} 分类失败：${String(e?.message || e).slice(0, 200)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    return { ok: true, phase: 'classify', kind, total: items.length, already_done: items.length - todo.length, ok, failed };
  } finally {
    release();
  }
}

/** apply：写库。A 批复活、B 批拆稿+原稿留底。默认 dry-run，--apply 才写。 */
function phaseApply({ apply }) {
  if (process.env.BRAINX_LLM_CLEANUP !== '1') {
    throw new Error('kill-switch 未开：需 BRAINX_LLM_CLEANUP=1');
  }
  const d = openDbSync();
  const dir = workDir();
  const release = acquireLock(dir);
  try {
    const summary = { ok: true, phase: 'apply', apply, a: { recovered: 0, skipped_existing: 0, skipped_verdict: 0, failed_parse: 0 }, b: { split_drafts: 0, originals_retired: 0, skipped_existing: 0, failed_parse: 0 } };
    const nowIso = now();
    if (apply) d.exec('BEGIN');

    // —— A 批复活：UPDATE 原行（message_id 部分唯一索引，不插新行）——
    const aItems = new Map((existsSync(join(dir, A_SUFFIX)) ? readJsonlSync(join(dir, A_SUFFIX)) : []).map((x) => [x.draft_id, x]));
    const aResults = existsSync(join(dir, A_RESULT)) ? readJsonlSync(join(dir, A_RESULT)) : [];
    for (const r of aResults) {
      if (r.result?.verdict !== 'REAL_JOB') { summary.a.skipped_verdict += 1; continue; }
      const src = aItems.get(r.draft_id);
      if (!src) { summary.a.failed_parse += 1; continue; }
      const upd = recoveryUpdateOf(src, r.result, { nowIso });
      if (!upd) { summary.a.skipped_verdict += 1; continue; }
      if (apply) {
        const res = d.prepare(`UPDATE job_facts_drafts
          SET role=?, role_evidence=?, source=?, status='pending', raw_json=?, extracted_at=?
          WHERE draft_id=? AND status='rejected'`)
          .run(upd.role, upd.role_evidence, upd.source, upd.raw_json, upd.extracted_at, src.draft_id);
        if (res.changes > 0) summary.a.recovered += 1;
        else summary.a.skipped_existing += 1; // 已被复活/处置过（幂等）
      } else {
        summary.a.recovered += 1;
      }
    }

    // —— B 批拆稿：多职位必须多行（group 来源不撞 p2p 部分唯一索引；p2p 原稿跳过转人工）——
    const bItems = new Map((existsSync(join(dir, B_SUFFIX)) ? readJsonlSync(join(dir, B_SUFFIX)) : []).map((x) => [x.draft_id, x]));
    const bResults = existsSync(join(dir, B_RESULT)) ? readJsonlSync(join(dir, B_RESULT)) : [];
    for (const r of bResults) {
      const jobs = r.result;
      if (!Array.isArray(jobs) || !jobs.length) { summary.b.failed_parse += 1; continue; }
      const exists = d.prepare(`SELECT 1 FROM job_facts_drafts WHERE raw_json LIKE ? LIMIT 1`).get(`%llm_split_of":"${r.draft_id}"%`);
      if (exists) { summary.b.skipped_existing += 1; continue; }
      const src = bItems.get(r.draft_id);
      if (!src) { summary.b.failed_parse += 1; continue; }
      if (src.origin === 'p2p_jd') { summary.b.skipped_p2p = (summary.b.skipped_p2p || 0) + 1; continue; }
      const drafts = buildSplitDrafts(src, jobs, { nowIso, newId: () => `dclr_${randomUUID()}` });
      if (!apply) { summary.b.split_drafts += drafts.length; summary.b.originals_retired += 1; continue; }
      for (const draft of drafts) insertDraft(d, draft);
      const raw = JSON.stringify({ ...safeParse(src.raw_json), llm_superseded_by: drafts.map((x) => x.draft_id) });
      d.prepare(`UPDATE job_facts_drafts SET status='rejected', raw_json=? WHERE draft_id=?`).run(raw, src.draft_id);
      summary.b.split_drafts += drafts.length;
      summary.b.originals_retired += 1;
    }

    if (apply) d.exec('COMMIT');
    return summary;
  } catch (e) {
    if (apply && db) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
    throw e;
  } finally {
    release();
  }
}

function readJsonlSync(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function insertDraft(d, draft) {
  d.prepare(`INSERT INTO job_facts_drafts
    (draft_id, event_id, message_id, chat_id, project_id, company, company_evidence, role, role_evidence,
     city, city_evidence, pipeline_stage, pipeline_evidence, hc, hc_evidence, active_state, state_evidence,
     source, status, raw_json, extracted_at, origin)
    VALUES (@draft_id, @event_id, @message_id, @chat_id, @project_id, @company, @company_evidence, @role, @role_evidence,
     @city, @city_evidence, @pipeline_stage, @pipeline_evidence, @hc, @hc_evidence, @active_state, @state_evidence,
     @source, @status, @raw_json, @extracted_at, @origin)`).run({ project_id: null, ...draft });
}

function safeParse(json) {
  try { return JSON.parse(json || '{}') || {}; } catch { return {}; }
}

/** report：规则缺口对账 → markdown 清单。 */
async function phaseReport() {
  const dir = workDir();
  const aItems = new Map((await readJsonl(join(dir, A_SUFFIX))).map((x) => [x.draft_id, x]));
  const aResults = await readJsonl(join(dir, A_RESULT));
  const kinds = {};
  const roleHints = [];
  for (const r of aResults) {
    const diff = diffAgainstRules(aItems.get(r.draft_id) || {}, r.result);
    kinds[diff.kind] = (kinds[diff.kind] || 0) + 1;
    if (diff.kind === 'role_missed_by_rules' && r.result?.role_hint) roleHints.push(r.result.role_hint);
  }
  const lines = [
    '# 草稿清洗：规则缺口清单（GLM vs 规则版对账）', '',
    `- 对账样本：${aResults.length} 条（A 批全量 rejected）`,
    `- 差异分布：${JSON.stringify(kinds)}`, '',
    '## 规则漏抓的岗位名（role_missed_by_rules 样例，Top 40）', '',
    ...roleHints.slice(0, 40).map((h) => `- ${h}`), '',
  ];
  const reportPath = join(dir, 'rule-gap-report.md');
  await writeFile(reportPath, lines.join('\n'));
  return { ok: true, phase: 'report', report: reportPath, kinds, role_hint_count: roleHints.length };
}

// —— 入口 ——
const phase = process.argv[2];
const APPLY = process.argv.includes('--apply');
const DIR = workDir();
let release;
try {
  if (phase === 'extract') {
    release = acquireLock(DIR);
    console.log(JSON.stringify(phaseExtract()));
  } else if (phase === 'classify') {
    const kind = process.argv.includes('--b') ? 'b' : 'a';
    console.log(JSON.stringify(await phaseClassify(kind)));
  } else if (phase === 'apply') {
    console.log(JSON.stringify(phaseApply({ apply: APPLY })));
  } else if (phase === 'report') {
    console.log(JSON.stringify(await phaseReport()));
  } else {
    console.error('用法：brainx-draft-cleanup.mjs <extract|classify [--b]|apply [--apply]|report>');
    process.exit(1);
  }
  } catch (e) {
    if (e instanceof LockHeld) {
      console.error(`[cleanup] ${e.message}（退出码 ${LOCK_EXIT_CODE}）`);
      process.exit(LOCK_EXIT_CODE);
    }
    console.error(`[cleanup] 失败：${e?.message || e}`);
    process.exit(1);
  } finally {
    release?.(); // extract 等同步阶段也要释放锁（2026-09-23 实测：漏调导致残留锁阻塞后续阶段）
  }

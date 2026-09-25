#!/usr/bin/env node
/** brainx-client-metrics-import — 客户健康报告快照导入 client_metrics（specs/022 FR-2 第一批）。
 *
 * 输入：报告 HTML（内嵌 allClientsData + bm 两个 JSON 变量）。
 * 幂等：chat_id 主键 upsert，重跑同 source 覆盖同值；benchmarks 按 anchor_version 冻结。
 * 纪律（brainx-ops）：默认 dry-run 打印汇总，--write 才落库。
 * 用法：node bin/brainx-client-metrics-import.mjs <报告.html> [--write] [--db <path>]
 */
import { readFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';

export const REPORT_SOURCE = 'report-snapshot-2026-09-18';
export const ANCHOR_VERSION = 'ltr-feat-v2-anchor-2026-09-18';

/** 报告字段 → client_metrics 列。 */
const FIELD_MAP = {
  c_speed: 'c_feedback_hours', c_dec: 'c_decision_days',
  o_resp: 'o_resp_hours', o_gap: 'o_gap_days', o_max_gap: 'o_max_gap_days',
  o_cand: 'o_intent_coverage', o_push: 'o_push_freq',
};

/** bm 指标键 → benchmarks.metric_key。 */
const BM_MAP = {
  c_speed: 'c_feedback_hours', o_resp: 'o_resp_hours', o_gap: 'o_gap_days',
  o_max_gap: 'o_max_gap_days', o_cand: 'o_intent_coverage', o_push: 'o_push_freq',
};

/** 从 HTML 中提取 `name = <JSON>` 赋值（括号配平 + 字符串感知，正则截断不可靠）。 */
function extractVar(src, name) {
  const m = src.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*`));
  if (!m) return null;
  let i = m.index + m[0].length;
  const open = src[i];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return null;
}

/** 解析报告 HTML → { clients, benchmarks }（纯函数，可单测）。 */
export function parseReport(html) {
  const rawClients = extractVar(html, 'allClientsData');
  const rawBm = extractVar(html, 'bm');
  if (!rawClients || !rawBm) throw new Error('报告缺少 allClientsData 或 bm 数据块');
  const clientsRaw = JSON.parse(rawClients);
  const bm = JSON.parse(rawBm);
  const clients = clientsRaw.map((c) => {
    const row = {
      chat_id: c.chat_id, client_name: c.name,
      rec_count: c.rec_count ?? 0, cand_unique: c.cand_unique ?? 0, msg_total: c.msg_total ?? 0,
      stage: c.stage, health_badge: c.final_badge ?? null,
    };
    for (const [from, to] of Object.entries(FIELD_MAP)) row[to] = c[from] ?? null;
    return row;
  });
  const benchmarks = Object.entries(BM_MAP)
    .filter(([k]) => bm[k])
    .map(([k, key]) => ({ metric_key: key, p25: bm[k].p25, p50: bm[k].p50, p75: bm[k].p75 }));
  return { clients, benchmarks };
}

/** 幂等导入。返回 { clients, benchmarks } 计数。 */
export function importReport(db, { clients, benchmarks }, { source = REPORT_SOURCE, anchorVersion = ANCHOR_VERSION } = {}) {
  const ts = now();
  const upsertClient = db.prepare(`INSERT INTO client_metrics
    (chat_id, client_name, c_feedback_hours, c_decision_days, o_resp_hours, o_gap_days,
     o_max_gap_days, o_intent_coverage, o_push_freq, rec_count, cand_unique, msg_total,
     stage, health_badge, window_days, source, computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,90,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET
      client_name=excluded.client_name, c_feedback_hours=excluded.c_feedback_hours,
      c_decision_days=excluded.c_decision_days, o_resp_hours=excluded.o_resp_hours,
      o_gap_days=excluded.o_gap_days, o_max_gap_days=excluded.o_max_gap_days,
      o_intent_coverage=excluded.o_intent_coverage, o_push_freq=excluded.o_push_freq,
      rec_count=excluded.rec_count, cand_unique=excluded.cand_unique, msg_total=excluded.msg_total,
      stage=excluded.stage, health_badge=excluded.health_badge, window_days=excluded.window_days,
      source=excluded.source, computed_at=excluded.computed_at`);
  const upsertBm = db.prepare(`INSERT INTO client_metric_benchmarks
    (metric_key, anchor_version, p25, p50, p75, computed_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(metric_key, anchor_version) DO UPDATE SET
      p25=excluded.p25, p50=excluded.p50, p75=excluded.p75, computed_at=excluded.computed_at`);
  db.exec('BEGIN');
  try {
    for (const c of clients) {
      upsertClient.run(c.chat_id, c.client_name, c.c_feedback_hours, c.c_decision_days,
        c.o_resp_hours, c.o_gap_days, c.o_max_gap_days, c.o_intent_coverage, c.o_push_freq,
        c.rec_count, c.cand_unique, c.msg_total, c.stage, c.health_badge, source, ts);
    }
    for (const b of benchmarks) upsertBm.run(b.metric_key, anchorVersion, b.p25, b.p50, b.p75, ts);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw err;
  }
  return { clients: clients.length, benchmarks: benchmarks.length };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const file = process.argv.find((a, i) => i > 1 && !a.startsWith('--'));
  if (!file) {
    console.error('用法：node bin/brainx-client-metrics-import.mjs <报告.html> [--write] [--db <path>]');
    process.exit(64);
  }
  const { clients, benchmarks } = parseReport(readFileSync(file, 'utf8'));
  const stages = {};
  for (const c of clients) stages[c.stage] = (stages[c.stage] || 0) + 1;
  console.log(`解析：${clients.length} 家客户，benchmarks ${benchmarks.length} 项，分档 ${JSON.stringify(stages)}`);
  if (!process.argv.includes('--write')) {
    console.error('（dry-run，加 --write 才落库）');
    process.exit(0);
  }
  const argI = process.argv.indexOf('--db');
  const db = openDb(argI > -1 ? process.argv[argI + 1] : undefined);
  const r = importReport(db, { clients, benchmarks });
  console.log(`已导入：client_metrics ${r.clients} 行，benchmarks ${r.benchmarks} 行（${ANCHOR_VERSION}）`);
}

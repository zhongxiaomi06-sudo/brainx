#!/usr/bin/env node
/** pull-cloud-data — 拉取云端生产库为本地只读训练副本 + 打标现状审计（2026-08-24 Phase 0）。
 *
 * 背景：云端 ECS（Docker volume）是生产库，与本机 data/brainx.db 互不回流。
 * 训练/诊断必须用云端真数据。本脚本：
 *   1. ssh 到云端，优先在运行中的 brainx 容器内 `sqlite3 .backup`（WAL 一致性安全），
 *      兜底宿主机直读 /opt/brainx/data/brainx.db；gzip 后拉回本地；
 *   2. 解压为 data/brainx-cloud.db（绝不覆盖本机生产 data/brainx.db）；
 *   3. 以 readOnly 模式打开副本，输出打标现状审计：各顾问 feedback/outcome/人类事件
 *      计数 + 最新一轮 Top20 的标签覆盖缺口矩阵（打标任务下发的直接输入）。
 *
 * 用法：node scripts/pull-cloud-data.mjs [--host root@47.110.93.137] [--audit-only]
 *   --audit-only：跳过拉取，只对已有 data/brainx-cloud.db 重跑审计。
 */
import '../src/env.js';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'brainx-cloud.db');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const host = arg('host', 'root@47.110.93.137');
const auditOnly = process.argv.includes('--audit-only');

// —— 1. 拉取（VACUUM INTO 是在线一致快照；生产是 systemd 宿主机实例，无容器内 sqlite3）——
function pull() {
  const remoteSh = [
    'set -e',
    'node -e "const {DatabaseSync}=require(\'node:sqlite\');const db=new DatabaseSync(\'/opt/brainx/data/brainx.db\',{readOnly:true});db.exec(\\"VACUUM INTO \'/tmp/brainx-pull.db\'\\");db.close()"',
    'gzip -f -1 /tmp/brainx-pull.db',
  ].join(' && ');
  execFileSync('ssh', ['-o', 'ConnectTimeout=10', host, remoteSh], { stdio: 'inherit' });
  execFileSync('scp', ['-q', `${host}:/tmp/brainx-pull.db.gz`, `${OUT}.gz`], { stdio: 'inherit' });
  writeFileSync(OUT, gunzipSync(readFileSync(`${OUT}.gz`)));
  console.error(`[pull] 已拉取 → ${OUT}`);
}

// —— 2. 打标现状审计（readOnly 直连，绕开 openDb 的 WAL/migrate/seed 写副作用）——
export function audit(db) {
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const consultants = q(`SELECT consultant_id, display_name FROM consultants WHERE active=1`);

  const feedback = Object.fromEntries(q(`SELECT consultant_id, COUNT(*) n FROM recommendation_feedback GROUP BY consultant_id`).map((r) => [r.consultant_id, r.n]));
  const outcomes = Object.fromEntries(q(`SELECT consultant_id, COUNT(*) n FROM job_outcomes GROUP BY consultant_id`).map((r) => [r.consultant_id, r.n]));
  const humanEvents = Object.fromEntries(q(`SELECT actor, COUNT(*) n FROM decision_events
    WHERE event_type != 'RECOMMENDED' GROUP BY actor`).map((r) => [r.actor, r.n]));

  // 缺口矩阵：每位顾问最新一轮 Top20 中，有多少已带任意标签/行为
  const gap = consultants.map((c) => {
    const run = db.prepare(`SELECT run_id FROM decision_runs WHERE consultant_id=?
      AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`).get(c.consultant_id);
    if (!run) return { consultant_id: c.consultant_id, top20: 0, labeled: 0, unlabeled: 0 };
    const items = q(`SELECT project_id FROM recommendations WHERE run_id=? AND rank<=20`, run.run_id);
    let labeled = 0;
    for (const it of items) {
      const has = db.prepare(`SELECT 1 FROM recommendation_feedback WHERE consultant_id=? AND project_id=? LIMIT 1`)
        .get(c.consultant_id, it.project_id)
        || db.prepare(`SELECT 1 FROM job_outcomes WHERE consultant_id=? AND project_id=? LIMIT 1`)
        .get(c.consultant_id, it.project_id)
        || db.prepare(`SELECT 1 FROM decision_events WHERE actor=? AND project_id=? AND event_type != 'RECOMMENDED' LIMIT 1`)
        .get(c.consultant_id, it.project_id);
      if (has) labeled++;
    }
    return { consultant_id: c.consultant_id, display_name: c.display_name,
             top20: items.length, labeled, unlabeled: items.length - labeled };
  });

  return {
    db_snapshot_at: new Date().toISOString(),
    totals: {
      recommendation_feedback: q(`SELECT COUNT(*) n FROM recommendation_feedback`)[0].n,
      job_outcomes: q(`SELECT COUNT(*) n FROM job_outcomes`)[0].n,
      human_events: q(`SELECT COUNT(*) n FROM decision_events WHERE event_type != 'RECOMMENDED'`)[0].n,
      decision_runs: q(`SELECT COUNT(*) n FROM decision_runs`)[0].n,
      recommendations: q(`SELECT COUNT(*) n FROM recommendations`)[0].n,
    },
    by_consultant: consultants.map((c) => ({
      consultant_id: c.consultant_id, display_name: c.display_name,
      feedback: feedback[c.consultant_id] || 0,
      outcomes: outcomes[c.consultant_id] || 0,
      human_events: humanEvents[c.consultant_id] || 0,
    })),
    top20_label_gap: gap,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!auditOnly) pull();
  else if (!existsSync(OUT)) { console.error(`[audit-only] 找不到 ${OUT}，先不带 --audit-only 拉取一次`); process.exit(2); }
  const db = new DatabaseSync(OUT, { readOnly: true });
  const report = audit(db);
  console.log(JSON.stringify(report, null, 2));
  const g = report.top20_label_gap;
  console.error(`[audit] 标签总量: feedback=${report.totals.recommendation_feedback} outcomes=${report.totals.job_outcomes} 人类事件=${report.totals.human_events}`);
  console.error(`[audit] Top20 缺口: ${g.map((r) => `${r.consultant_id} ${r.labeled}/${r.top20}`).join(' · ')}`);
}

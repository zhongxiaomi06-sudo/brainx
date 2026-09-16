import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { openDb } from '../src/db.js';

const SEED = new URL('../scripts/demo-offer-seed.mjs', import.meta.url).pathname;

function prepareDb() {
  const dir = mkdtempSync(join(tmpdir(), 'demo-offer-seed-'));
  const dbPath = join(dir, 'test.db');
  const db = openDb(dbPath);
  const at = '2026-09-16T00:00:00.000Z';
  // 新库自带 consultants 种子（wendy/miya/frankie 均含 open_id），无需处理。
  // job_facts.sync_id 有外键，先补一行 sync_runs。
  db.prepare(`INSERT INTO sync_runs (sync_id,consultant_id,source,as_of,input_hash,started_at)
    VALUES ('demo-seed-test','wendy','fixture',?,'demo',?)`).run(at, at);
  for (const jobId of ['J69JWW1', 'JSV8VOH', 'JBZ1NSL']) {
    db.prepare(`INSERT INTO job_facts (project_id,company,role,active_state,captured_at,sync_id,raw_json,updated_at)
      VALUES (?,?,'岗位','ACTIVE',?,'demo-seed-test','{}',?)`).run(jobId, `公司-${jobId}`, at, at);
  }
  db.close();
  return { dir, dbPath };
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SEED, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `CLI 失败: ${result.stderr}`);
  return result.stdout;
}

test('demo-offer-seed：三人灌入就绪、幂等、电话纪要可入决策群', () => {
  const { dir, dbPath } = prepareDb();
  try {
    const first = runCli(['seed', '--db', dbPath, '--tenant', 'tenant-t', '--account', 'mia']);
    assert.match(first, /曹国鸿/); assert.match(first, /杨东旭/); assert.match(first, /从容地/);
    const status = runCli(['status', '--db', dbPath, '--tenant', 'tenant-t']);
    for (const name of ['曹国鸿', '杨东旭', '从容地']) {
      assert.match(status, new RegExp(`${name} .*launch=READY@oc_demo_src_`));
      assert.match(status, new RegExp(`${name} .*focus=FOCUSED`));
    }
    // 幂等：重复灌入不得报错、不得覆盖。
    const second = runCli(['seed', '--db', dbPath, '--tenant', 'tenant-t', '--account', 'mia']);
    assert.match(second, /已存在 ACTIVE 绑定/);
    assert.match(second, /已存在 launch\(READY\)，未覆盖/);
    // 来源群讨论已灌入（决策群迁移摘要的输入）。
    const db = openDb(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM lark_messages WHERE chat_id='oc_demo_src_TTC-260915-CGH'")
      .get().n, 4);
    db.close();
    // 决策群建成后灌电话纪要（报告 V2「新增证据」的输入，生产 OpenClaw 不落 lark_messages）。
    runCli(['seed-offer-msg', '--db', dbPath, '--chat', 'oc_offer_x', '--ref', 'TTC-260915-CGH']);
    const db2 = openDb(dbPath);
    assert.equal(db2.prepare("SELECT COUNT(*) n FROM lark_messages WHERE chat_id='oc_offer_x'").get().n, 2);
    db2.close();
    // 未知候选人引用必须失败。
    const bad = spawnSync(process.execPath,
      [SEED, 'seed-offer-msg', '--db', dbPath, '--chat', 'oc_x', '--ref', 'TTC-NOPE'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

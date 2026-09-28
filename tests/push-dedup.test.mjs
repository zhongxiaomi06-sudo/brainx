/** push-dedup.test.mjs — pushedProjectIdsOnDay：再推去重的职位提取（2026-09-28 指令）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { pushedProjectIdsOnDay } from '../src/push.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-pd-')), 't.db'));

const CARD = JSON.stringify({ elements: [
  { tag: 'markdown', content: 'x' },
  { tag: 'action', actions: [
    { multi_url: { url: 'https://x/api/v1/feedback/quick?consultant=felix&project=JAAA111&action=launch' } },
    { multi_url: { url: 'https://x/?open=opportunity%3AJBBB222' } },
  ] },
] });

test('提取今日已推职位：quickLink project= 与 opportunity 深链两种形态', () => {
  const db = newDb();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const ts = new Date(`${today}T02:00:00+08:00`).toISOString(); // 今晨 2 点（UTC 昨晚）
  db.prepare(`INSERT INTO push_log (push_id, consultant_id, kind, run_id, card_json, target, status, created_at)
    VALUES ('p1', 'felix', 'DAILY_TOP3', 'r1', ?, 'ou_x', 'SENT', ?)`).run(CARD, ts);
  const seen = pushedProjectIdsOnDay(db, 'felix', today);
  assert.ok(seen.has('JAAA111'));
  assert.ok(seen.has('JBBB222'));
  assert.equal(seen.size, 2);
});

test('边界：昨日推送不计入；他人推送不计入；无记录返回空集', () => {
  const db = newDb();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO push_log (push_id, consultant_id, kind, run_id, card_json, target, status, created_at)
    VALUES ('p1', 'felix', 'DAILY_TOP3', 'r1', ?, 'ou_x', 'SENT', '2020-01-01T00:00:00Z'),
           ('p2', 'mia', 'DAILY_TOP3', 'r1', ?, 'ou_y', 'SENT', ?)`)
    .run(CARD, CARD, new Date().toISOString());
  const seen = pushedProjectIdsOnDay(db, 'felix', today);
  assert.equal(seen.size, 0, '昨日 + 他人记录都不应计入');
});

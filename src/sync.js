/** sync.js — 同步批次 + project_id 去重 + 关系落位（补全文档 §13.4、PRD §4）。
 *
 * source=fixture：读 fixtures/ttc_jobs_felix.json（真实导出衍生）。
 * source=feishu：经 lark-cli 直读职位盘点 Bitable（L2 源，无 project_id →
 *   按硬约束进 errors，不落 job_facts——架构后果见补全文档 §17.2）。
 * 重复同步：job_facts UPSERT（project_id PRIMARY KEY），行数不增。
 *
 * 2026-08-10 框架修正（事实/关系分离纪律统一）：
 *   - fixture 是 Felix 个人策展导出（文件名即属主）：只有 consultant_id 属主本人
 *     同步时才写关系行——修正前 mia/york 跑 fixture 同步会把 Felix 的 MY_JOB
 *     继承成自己的关系（数据污染）；
 *   - fetchFeishuJobs 改为 relation=null（与 bridge 同一纪律）——修正前它给每个
 *     同步者写 TEAM_SHARED，会把该顾问既有策展关系（MY_JOB/PRIMARY_PM）到期冲掉；
 *   - captured_at 只在事实字段（公司/职位/城市/pipeline/HC/状态）变化时前进——
 *     修正前每轮桥接 UPSERT 都回刷 captured_at，scorer 新鲜度维度恒为满分、失去意义。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now, uuid } from './db.js';
import { BITABLE_BASE, BITABLE_TABLE, flatLark, parseBitableRecord } from './bitable.js';
import { splitFixtureJob } from './fixture_split.js';
import { larkProfileArgs } from './env.js';
import { buildTtcFieldReport, recordTtcFieldReport } from './ttc-field-report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** fixture 属主：Felix 个人策展导出。关系行只许属主本人同步时落位。 */
export const FIXTURE_OWNER = 'felix';

export function loadFixture() {
  const f = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'ttc_jobs_felix.json'), 'utf8'));
  return { as_of: f.exported_at, jobs: f.jobs, consultant_owner: f.consultant_id || FIXTURE_OWNER };
}

/** lark-cli 读职位盘点 Bitable（L2 飞书源实测通道）。
 * 解析层 = src/bitable.js（与 bridge 同一权威）：公司×单职能展开、priority 结构化、
 * relation=null（事实/关系分离——防止 TEAM_SHARED 把同步者既有策展关系冲掉）。 */
export function fetchFeishuJobs() {
  const out = execFileSync('lark-cli', [
    ...larkProfileArgs(),
    'base', '+record-list', '--base-token', BITABLE_BASE,
    '--table-id', BITABLE_TABLE, '--page-size', '100', '--format', 'json',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        timeout: 60000, killSignal: 'SIGKILL' }); // lark-cli 实测会无限 hang——手动同步入口也要有上限
  const d = JSON.parse(out.slice(out.indexOf('{'))).data;
  return {
    as_of: now(),
    jobs: d.data.flatMap((cells, i) => {
      const rec = Object.fromEntries(d.fields.map((c, j) => [c, cells[j]]));
      return parseBitableRecord(rec, d.record_id_list[i], flatLark);
    }),
  };
}

const hashInput = (jobs) => {
  const h = createHash('sha256');
  const stable = jobs.map((j) => ({ ...j, raw_json: undefined }))
    .sort((a, b) => String(a.project_id).localeCompare(String(b.project_id)));
  h.update(JSON.stringify(stable));
  return h.digest('hex');
};

/**
 * 跑一次同步。返回 sync_runs 行。
 * 硬约束落实：缺 project_id / 缺客户或职位名 → 记 errors 且不入库。
 * payload：桥接器直接喂规范化职位（source='bridge'），跳过文件/CLI 读取。
 * 关系落位守卫：payload 声明了 consultant_owner 时，只有属主本人同步才写关系行。
 */
export function runSync(db, { source = 'fixture', consultant_id = 'felix', dry_run = false, payload = null } = {}) {
  const t0 = now();
  const loaded = payload ?? (source === 'feishu' ? fetchFeishuJobs() : loadFixture());
  const { as_of } = loaded;
  const jobs = loaded.jobs.flatMap(splitFixtureJob);
  const writeRels = !loaded.consultant_owner || loaded.consultant_owner === consultant_id;
  const errors = [];
  const warnings = [];
  const valid = [];
  const seen = new Set();
  for (const j of jobs) {
    if (!j.project_id) { errors.push(`缺 project_id：${j.company}/${j.role}`); continue; }
    if (!j.company || !j.role) { errors.push(`缺客户或职位名：${j.project_id}`); continue; }
    // 输入内重复 project_id：同一职位被源端重复投递（TTC 云有时同一职位返回两次，
    // 或桥接跨顾问团队池合并时偶发碰撞）。UPSERT 本就会按 project_id 主键合并，
    // 故这里「保留首条、丢弃冗余副本」而非整体判废——避免个别脏行拖垮整批同步、
    // 进而触发前端「本次同步不完整」阻断全部推荐。
    if (seen.has(j.project_id)) { warnings.push(`输入内重复 project_id（已去重保留首条）：${j.project_id}`); continue; }
    seen.add(j.project_id);
    j.company = j.company.replace(/[\n\r]/g, '').trim();
    j.role = j.role.replace(/[\n\r]/g, '').trim();
    valid.push(j);
  }
  const sync_id = uuid();
  const input_hash = hashInput(jobs);
  const complete = errors.length === 0 ? 1 : 0;

  if (dry_run) {
    return { sync_id: '(dry-run)', source, rows_expected: jobs.length, rows_read: valid.length,
             complete: !!complete, errors, warnings, input_hash, would_upsert: valid.length };
  }

  const completed_at = now();
  const fieldReport = source === 'ttc' ? buildTtcFieldReport(valid, {
    sync_id, consultant_id, rows_expected: jobs.length, rows_read: valid.length,
    complete: !!complete, errors, warnings, created_at: completed_at,
  }) : null;

  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO sync_runs
      (sync_id, consultant_id, source, as_of, rows_expected, rows_read, complete, errors, input_hash, started_at, completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sync_id, consultant_id, source, as_of, jobs.length, valid.length, complete,
           JSON.stringify(errors), input_hash, t0, completed_at);
    if (fieldReport) recordTtcFieldReport(db, fieldReport);

    // captured_at 语义 = 「事实最后变化时间」，不是「最后同步时间」：
    // 十二个事实字段任一变化（IS NOT = null 安全不等）才前进，否则保留原值。
    // chat_last_at/chat_msgs_7d 是桥接回写的计算列，不在此维护。
    const upsert = db.prepare(`INSERT INTO job_facts
      (project_id, company, role, city, pipeline, hc, active_state, priority, notes, company_type, owner_name, owner_unique_id, chat_id, source_url, captured_at, sync_id, raw_json, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET
        company=excluded.company, role=excluded.role, city=excluded.city,
        pipeline=excluded.pipeline, hc=excluded.hc, active_state=excluded.active_state,
        priority=excluded.priority, notes=excluded.notes, company_type=excluded.company_type,
        owner_name=excluded.owner_name, owner_unique_id=excluded.owner_unique_id,
        chat_id=excluded.chat_id, source_url=excluded.source_url,
        captured_at=CASE WHEN
            job_facts.company      IS NOT excluded.company      OR
            job_facts.role         IS NOT excluded.role         OR
            job_facts.city         IS NOT excluded.city         OR
            job_facts.pipeline     IS NOT excluded.pipeline     OR
            job_facts.hc           IS NOT excluded.hc           OR
            job_facts.active_state IS NOT excluded.active_state OR
            job_facts.priority     IS NOT excluded.priority     OR
            job_facts.notes        IS NOT excluded.notes        OR
            job_facts.company_type IS NOT excluded.company_type OR
            job_facts.owner_name   IS NOT excluded.owner_name   OR
            job_facts.chat_id      IS NOT excluded.chat_id
          THEN excluded.captured_at ELSE job_facts.captured_at END,
        sync_id=excluded.sync_id, raw_json=excluded.raw_json, updated_at=excluded.updated_at`);
    const upsertRel = db.prepare(`INSERT INTO job_memberships
      (consultant_id, project_id, relation, source, valid_from, valid_to)
      VALUES (?,?,?,?,?,NULL)
      ON CONFLICT(consultant_id, project_id, relation, valid_from) DO NOTHING`);
    const closeRel = db.prepare(`UPDATE job_memberships SET valid_to=?
      WHERE consultant_id=? AND project_id=? AND valid_to IS NULL AND relation != ?`);
    // F1（2026-08-24）：owner_name 回种策展层。0007 前 memberships 由 fixture 种子写入，
    // 2026-08-19 P-FIX 清理后全表归零，而 TTC/bridge/Bitable 同步 relation=null 结构性
    // 无法回种 → historical_texts（recommend.js buildCtx）断供。TTC owner 本就是
    // relations.js 推导的权威层（规则 2），这里把它落成 source='ttc-owner' 的 MY_JOB 行：
    // 只动 owner 本人的关系（他人策展行不被冲掉），已有活跃 MY_JOB 时跳过（幂等）。
    const ownerIds = new Map(db.prepare(`SELECT display_name, consultant_id FROM consultants
      WHERE active=1 AND display_name IS NOT NULL AND display_name != ''`).all()
      .map((r) => [r.display_name, r.consultant_id]));
    const activeRel = db.prepare(`SELECT relation FROM job_memberships
      WHERE consultant_id=? AND project_id=? AND valid_to IS NULL`);
    // B6（2026-08-24 修复）：owner 变更/移除时关闭残留的 ttc-owner MY_JOB 行——
    // 旧实现只增不减，owner A→B 后 A 的 MY_JOB 残留（deriveRelation 策展层优先 → 关系错误）。
    // 只动 source='ttc-owner' 的行，策展资产（fixture/manual）不受影响。
    const closeStaleOwner = db.prepare(`UPDATE job_memberships SET valid_to=?
      WHERE project_id=? AND relation='MY_JOB' AND source='ttc-owner'
        AND valid_to IS NULL AND consultant_id != ?`);

    for (const j of valid) {
      upsert.run(j.project_id, j.company, j.role, j.city, j.pipeline, j.hc,
                 j.active_state, j.priority ?? null, j.notes ?? null, j.company_type ?? null,
                 j.owner_name ?? null, j.owner_unique_id ?? null, j.chat_id ?? null,
                 j.source_url, j.captured_at || as_of, sync_id,
                 JSON.stringify(j), now());
      if (j.relation && writeRels) {
        closeRel.run(now(), consultant_id, j.project_id, j.relation); // 旧关系到期
        upsertRel.run(consultant_id, j.project_id, j.relation, source, j.captured_at || as_of);
      }
      const ownerId = j.owner_name ? ownerIds.get(j.owner_name) : null;
      if (ownerId && activeRel.get(ownerId, j.project_id)?.relation !== 'MY_JOB') {
        closeRel.run(now(), ownerId, j.project_id, 'MY_JOB'); // owner 本人旧关系到期
        upsertRel.run(ownerId, j.project_id, 'MY_JOB', 'ttc-owner', j.captured_at || as_of);
      }
      //  owner 不在花名册/为空时 ownerId=null → 关掉该项目全部 ttc-owner MY_JOB（保守回收）
      closeStaleOwner.run(now(), j.project_id, ownerId || '');
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { sync_id, consultant_id, source, as_of, rows_expected: jobs.length,
           rows_read: valid.length, complete: !!complete, errors, warnings, input_hash,
           field_report: fieldReport, started_at: t0, completed_at };
}

/** 最近一条 complete=1 的快照（推荐只允许用它）。 */
export function latestCompleteSnapshot(db, consultant_id) {
  return db.prepare(`SELECT sync_id, as_of, source, rows_read, completed_at FROM sync_runs
    WHERE consultant_id=? AND complete=1 ORDER BY completed_at DESC LIMIT 1`).get(consultant_id);
}

/** 最近一次同步（无论完整与否，给首屏状态胶囊用）。 */
export function latestSync(db, consultant_id) {
  return db.prepare(`SELECT sync_id, as_of, source, rows_expected, rows_read, complete, errors, completed_at
    FROM sync_runs WHERE consultant_id=? ORDER BY started_at DESC LIMIT 1`).get(consultant_id);
}

/** 最近一次真实数据源的同步（排除 bridge-error 观测行，2026-08-25）。
 * 背景：bridge-error 行（职位源失败的可观测记录）一度成为最新行 → latestSync
 * 恒 complete=0 → 推荐在上游限流期间被永久 fail-closed（最后完整快照被锁死）。
 * 阻断判定应只看真实同步；bridge-error 只驱动「降级警告」，不参与阻断。 */
export function latestRealSync(db, consultant_id) {
  return db.prepare(`SELECT sync_id, as_of, source, rows_expected, rows_read, complete, errors, completed_at
    FROM sync_runs WHERE consultant_id=? AND source != 'bridge-error'
    ORDER BY started_at DESC LIMIT 1`).get(consultant_id);
}

/** 最近一条 bridge-error（降级信号源）：比 afterIso 新才返回。
 * 2026-08-26：加 2h 时效——健康恢复后不再写新错误行，旧行若不过期会让
 * 「同步失败中」横幅永久残留（源畅通但零新增时 sync_runs 无新行可刷新基准）。 */
export function latestBridgeError(db, consultant_id, afterIso = '') {
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  return db.prepare(`SELECT errors, started_at FROM sync_runs
    WHERE consultant_id=? AND source='bridge-error' AND started_at > ? AND started_at > ?
    ORDER BY started_at DESC LIMIT 1`).get(consultant_id, afterIso || '', cutoff);
}

/** bridge-error 的面向用户文案（2026-08-25）：banner 不暴露内部错误原文
 * （顾问姓名/管道符拼接/截断半句）。已知错误模式映射为友好说明，
 * 原始细节进 detail 供排查（前端可选展开/悬停）。 */
export function friendlyBridgeError(errorsJson) {
  let first = '';
  try { first = JSON.parse(errorsJson || '[]')[0] || ''; } catch { /* 保持空 */ }
  const raw = String(first);
  const map = [
    [/90429|服务繁忙|限流/, 'TTC 系统限流中，已自动降频，恢复后自动刷新'],
    [/auth|凭据|令牌|reauth/i, 'TTC 登录凭据待更新'],
    [/bitable|Bitable/, '飞书职位盘点同步失败'],
  ];
  for (const [re, msg] of map) if (re.test(raw)) return { message: msg, detail: raw.slice(0, 200) };
  return { message: '职位源同步失败，展示最近完整快照', detail: raw.slice(0, 200) };
}

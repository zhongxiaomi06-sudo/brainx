/** talent-tag-backfill.js — 独立、可插拔的人才标签回填模块。
 *
 * 背景：RDS 人才池全员零标签（tag/talent_tag 为空）时，supply-match-v1 匹配只剩
 * 文本维、大量职位零召回（talent-match-run 上线验证发现）。本模块从两类既有数据
 * 回填标签，让人才匹配恢复技能/意向维信号：
 *   - 技能标签：每个 talent 最新一条 skills 非空的 READY candidate_fact_version
 *     （reloop 导入事实，candidate_fact_v1 口径）→ skills[].name → category='skill'，
 *     source='fact-backfill'。talent-match-run 自己写入的事实 skills 为空数组，
 *     会被自动跳过、继续回溯更早的 reloop 事实。
 *   - 意向标签：talent.summary（形如「公司 / 岗位」）取最后一个 '/' 或 '／' 之后的
 *     岗位段（无 '/' 用整条），tokenize → category='intention'，
 *     source='summary-backfill'。口径与 src/talent.js syncTalentsFromCsv 先例一致。
 *
 * 纪律：
 *   1) 不改动任何现有主流程文件；不使用 talent.js 的全局 backend() 连接——与
 *      talent-match-run 同一纪律，全部在同一注入连接（withConnection 风格）上读写。
 *   2) 全部 INSERT IGNORE + 表内固有唯一键去重（tag.uk(name,category)、
 *      talent_tag.uk(talent_id,tag_id)），可任意重跑；dryRun=true（默认）零写入。
 *   3) 同名多人（各自行）各自打标，不做任何合并。
 *
 * 调用方式（可插拔，模块自身不启动任何循环）：
 *   - CLI：node bin/brainx-talent-tag-backfill.mjs [--write] [--talent <id>]
 *   - 其他脚本：await runTalentTagBackfill({ dryRun: false });
 */
import { withMysql } from './db.js';
import { tokenize } from './scorer.js';

const SKILL_SOURCE = 'fact-backfill';
const INTENTION_SOURCE = 'summary-backfill';
const MAX_INTENTION_TAGS = 8;  // 与 syncTalentsFromCsv 先例一致
const MAX_SKILL_TAGS = 30;     // 与 candidate-shortlist 画像技能上限一致

const clean = (value, limit = 120) => String(value ?? '').trim().slice(0, limit);

const parseFacts = (value) => {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(String(value)); } catch { return null; }
};

/** summary → 意向标签名列表：最后一个 '/'/'／' 之后的岗位段（无则整条）分词。 */
export function intentionTagsFromSummary(summary, limit = MAX_INTENTION_TAGS) {
  const text = clean(summary, 1_000);
  if (!text) return [];
  const segments = text.split(/[\/／]/).map((s) => s.trim()).filter(Boolean);
  const roleText = segments.length ? segments.at(-1) : '';
  if (!roleText) return [];
  return [...tokenize(roleText)].slice(0, limit);
}

/** 单条 candidate_fact_v1 → 技能标签名列表（去重、保序）。 */
export function skillTagsFromFact(fact, limit = MAX_SKILL_TAGS) {
  const skills = Array.isArray(fact?.skills) ? fact.skills : [];
  return [...new Set(skills.map((s) => clean(s?.name, 120)).filter(Boolean))].slice(0, limit);
}

/** 读取人才清单（可选单人/限量；limit 已清洗为整数内联）。 */
async function loadTalents(conn, { talentId, limit }) {
  const lim = Math.max(1, Math.min(10_000, Number(limit) || 1_000));
  if (talentId) {
    const [rows] = await conn.execute(
      `SELECT id, name, summary FROM talent WHERE id = ? LIMIT 1`, [Number(talentId)]);
    return rows;
  }
  const [rows] = await conn.execute(`SELECT id, name, summary FROM talent ORDER BY id ASC LIMIT ${lim}`);
  return rows;
}

/**
 * 每个 talent 的最新 READY 事实（created_at 倒序拉取，在 JS 侧选每人的第一条）。
 * 技能维再从中挑「skills 非空」的最新一条——talent-match-run 写入的空 skills
 * 新事实不会遮蔽 reloop 导入的旧事实。
 */
async function loadLatestFacts(conn, { talentId }) {
  const sql = `SELECT talent_id, facts_json FROM candidate_fact_versions
    WHERE quality_status = 'READY' ${talentId ? 'AND talent_id = ?' : ''}
    ORDER BY created_at DESC, fact_version_id DESC`;
  const [rows] = talentId ? await conn.execute(sql, [Number(talentId)]) : await conn.execute(sql);
  const byTalent = new Map(); // talent_id -> { latestSkills: [..] } 首个非空即最新
  for (const row of rows) {
    const id = Number(row.talent_id);
    if (byTalent.has(id)) continue;
    const skills = skillTagsFromFact(parseFacts(row.facts_json));
    if (skills.length) byTalent.set(id, skills);
  }
  return byTalent;
}

/** 计划：每个 talent 应挂的 { skill: [...], intention: [...] } 标签名。 */
export function planBackfill(talents, factsByTalent) {
  return talents.map((talent) => ({
    talent_id: Number(talent.id),
    name: talent.name,
    skill: factsByTalent.get(Number(talent.id)) || [],
    intention: intentionTagsFromSummary(talent.summary),
  })).filter((entry) => entry.skill.length || entry.intention.length);
}

/** 单事务写入：tag 按 (name,category) 去重、talent_tag 按 (talent_id,tag_id) 去重。 */
async function writePlan(conn, plan) {
  const stats = { tag_rows: 0, talent_tag_rows: 0 };
  for (const entry of plan) {
    for (const [category, source, names] of [
      ['skill', SKILL_SOURCE, entry.skill],
      ['intention', INTENTION_SOURCE, entry.intention],
    ]) {
      for (const name of names) {
        const [ins] = await conn.execute(
          `INSERT IGNORE INTO tag (name, category) VALUES (?, ?)`, [name, category]);
        if (ins.affectedRows > 0) stats.tag_rows += 1;
        const [[tag]] = await conn.execute(
          `SELECT id FROM tag WHERE name = ? AND category = ? LIMIT 1`, [name, category]);
        const [link] = await conn.execute(
          `INSERT IGNORE INTO talent_tag (talent_id, tag_id, source) VALUES (?, ?, ?)`,
          [entry.talent_id, tag.id, source]);
        if (link.affectedRows > 0) stats.talent_tag_rows += 1;
      }
    }
  }
  return stats;
}

/**
 * 回填入口。
 * @param {object} input
 * @param {Function} [input.mysql]    withConnection 风格 (fn)=>fn(conn)，默认 withMysql。
 * @param {boolean} [input.dryRun]    默认 true：零写入，只返回报告。
 * @param {number|string} [input.talentId]  只回填该 talent。
 * @param {number} [input.limit]      处理人才数上限（默认 1000）。
 * @param {Date|string} [input.now]   时钟注入（报告时间戳；测试确定性用）。
 */
export async function runTalentTagBackfill(input = {}) {
  const dryRun = input.dryRun !== false;
  const connect = input.mysql || withMysql;
  const at = input.now ? new Date(input.now) : new Date();

  return connect(async (conn) => {
    const talents = await loadTalents(conn, input);
    const factsByTalent = talents.length ? await loadLatestFacts(conn, input) : new Map();
    const plan = planBackfill(talents, factsByTalent);

    const report = {
      dry_run: dryRun, ran_at: at.toISOString(),
      talents_scanned: talents.length,
      talents_with_fact_skills: factsByTalent.size,
      talents_to_tag: plan.length,
      skill_tag_links: plan.reduce((n, e) => n + e.skill.length, 0),
      intention_tag_links: plan.reduce((n, e) => n + e.intention.length, 0),
      distinct_tag_names: new Set(plan.flatMap((e) => [
        ...e.skill.map((n) => `skill:${n}`), ...e.intention.map((n) => `intention:${n}`),
      ])).size,
      samples: plan.slice(0, 5).map((e) => ({ talent_id: e.talent_id, name: e.name,
        skill: e.skill.slice(0, 5), intention: e.intention.slice(0, 5) })),
      written: null,
    };
    if (dryRun || !plan.length) return report;

    await conn.beginTransaction();
    try {
      report.written = await writePlan(conn, plan);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
    return report;
  });
}

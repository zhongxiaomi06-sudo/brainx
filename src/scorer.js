/** scorer.js — 六维评分 + 硬约束 + 确定性排序（PRD §6，补全文档 §17.1）。
 *
 * 纪律：
 * - 无随机数：探索位用 md5(project_id+日期+consultant) 确定性排序选取；
 * - 缺失维记 null，coverage = 可用维权重和，<0.5 强制 OBSERVE；
 * - 排序链固定：score↓ → coverage↓ → 新鲜度↓ → project_id↑。
 */
import { createHash } from 'node:crypto';
import { PRIORITY_LABEL } from './bitable.js';

export const WEIGHTS = {
  direction: 0.25,   // 职位方向匹配
  activity: 0.20,    // 项目活跃度与 Pipeline
  similarity: 0.15,  // 与历史项目相似度
  capacity: 0.15,    // 当前承接容量
  outcomes: 0.15,    // 历史行为与交付结果
  exploration: 0.10, // 探索额度
};

export const POLICY_VERSION = 'baseline-1.1'; // 1.1（2026-08-24）：活跃度连续衰减 + 反馈闭环（公司级记忆/僵尸降权/承接加权）
export const DIM_LABELS = {
  direction: '职位方向匹配', activity: '项目活跃度与 Pipeline', similarity: '与历史项目相似度',
  capacity: '当前承接容量', outcomes: '历史行为与交付结果', exploration: '探索额度',
};

/** 承接容量默认上限（顾问同时关注+接单的软上限）。可被 ctx.capacity_limit 覆盖。 */
export const CAPACITY_LIMIT = 10;

/** 硬约束（PRD §6）：命中即不得生成正式推荐。返回原因或 null。 */
export function hardBlock(job, relation, syncComplete) {
  if (!syncComplete) return '本轮同步不完整';
  if (!job.project_id) return '缺少 project_id';
  if (!job.company || !job.role) return '缺少客户或职位名称';
  if (['CLOSED', 'COMPLETED'].includes(job.active_state)) return '职位已关闭/完成';
  if (job.active_state === 'COOLING') return '职位处于冷却期';
  if (!relation || relation === 'UNKNOWN') return '关系 UNKNOWN';
  if (relation === 'NOT_JOINED') return '未加入该项目';
  return null;
}

const kwOverlap = (text, kws) => {
  if (!text || !kws.length) return 0;
  const hit = kws.filter((k) => text.toLowerCase().includes(k.toLowerCase())).length;
  return Math.min(100, Math.round((hit / Math.max(2, Math.ceil(kws.length / 2))) * 100));
};

/** 相似度分词（2026-08-10 框架修正）：
 * 修正前 `(?=[一-鿿])` 把中文逐字切开，而相似度只统计 length>1 的 token
 * → 纯中文职位（公司/职位名）相似度恒 0，该维度对中文名完全失效。
 * 现在：连续 CJK 段切 bigram（「增长负责人」→ 增长/长负/负责/责人），
 * 非 CJK 片段按空白整词保留；单字仍不入集（无区分度）。 */
export function tokenize(text) {
  const out = new Set();
  for (const piece of String(text || '').toLowerCase().split(/[\s,，、/|·;；:：()（）【】\-—_]+/)) {
    if (!piece) continue;
    const runs = piece.match(/[一-鿿]+/g) || [];
    for (const run of runs) {
      if (run.length < 2) continue;
      if (run.length === 2) { out.add(run); continue; }
      for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
    }
    for (const w of piece.split(/[一-鿿]+/)) if (w.length > 1) out.add(w);
  }
  return out;
}

function daysSince(iso, nowIso) {
  if (!iso) return 9999;
  return (Date.parse(nowIso) - Date.parse(iso)) / 86400000;
}

/** chat_last_at 多为 'YYYY-MM-DD HH:mm'（Asia/Shanghai 墙钟，fromMsg 产出）→ 显式 +08:00 解析。
 * 2026-08-24 修复：上游偶发 'HH:mm:ss' 带秒格式，旧实现拼出 '...ss:00+08:00' 非法串 →
 * NaN → cd=NaN → 比较全 false → 活跃基底静默掉到 20。先截断到分钟再拼时区；
 * 已是 ISO（含 T 或 Z）的输入直接解析。 */
const chatTs = (s) => {
  const str = String(s || '').trim();
  if (!str) return NaN;
  if (str.includes('T')) return Date.parse(str);
  const minute = str.slice(0, 16); // 'YYYY-MM-DD HH:mm'
  return Date.parse(minute.replace(' ', 'T') + ':00+08:00');
};

/** 顾问级权重覆盖校验与归一化（2026-08-25：规则页滑杆接真 policy）。
 * 接受 { direction, activity, similarity, capacity, outcomes, exploration } 的子集，
 * 值域 0–100（百分比）或 0–1（小数）；未给的维沿用 WEIGHTS 基线；最终归一化和为 1。
 * 返回 { ok, weights?, error? }——全零/负值/未知维度/非对象均拒绝。 */
export function normalizeWeights(input) {
  if (input == null) return { ok: true, weights: null }; // 未覆盖 → 用基线
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'weights 必须是对象' };
  const out = { ...WEIGHTS };
  let touched = false;
  for (const [k, v] of Object.entries(input)) {
    if (!(k in WEIGHTS)) return { ok: false, error: `未知维度 ${k}（可选：${Object.keys(WEIGHTS).join('/')}）` };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: `维度 ${k} 权重必须是非负数字` };
    out[k] = n > 1 ? n / 100 : n;
    touched = true;
  }
  if (!touched) return { ok: true, weights: null };
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ok: false, error: '六维权重不能全为 0' };
  for (const k of Object.keys(out)) out[k] = Math.round((out[k] / sum) * 1000) / 1000;
  return { ok: true, weights: out };
}

/** 探索位：确定性 md5 排序，当日该顾问的后 10% 职位得探索分 100，其余 50。 */
export function explorationScore(project_id, consultant_id, dayIso) {
  const h = createHash('md5').update(`${project_id}|${dayIso.slice(0, 10)}|${consultant_id}`).digest('hex');
  return parseInt(h.slice(0, 8), 16) % 10 === 0 ? 100 : 50;
}

/**
 * 给单个职位打分。ctx 需要：
 *  profile_keywords, historical_texts[](历史 MY_JOB 的公司+职位文本),
 *  watched_count, accepted_count, outcomes_avg(1-5|null), now
 */
export function scoreJob(job, relation, ctx) {
  const text = `${job.company} ${job.role} ${job.pipeline || ''}`;
  const dims = {};

  // 方向匹配 25%：三级降级，避免冷启动顾问被「画像为空」白扣分。
  //  ① 有画像关键词 → 关键词重合（主信号）。
  //  ② 无画像但有历史主做项目 → 用历史文本重合兜底（老顾问即便没配画像也有方向信号）。
  //  ③ 两者都无（纯冷启动）→ 记 null（缺失、不惩罚、不计入 coverage），而非 0 分硬扣 25% 权重。
  if (ctx.profile_keywords && ctx.profile_keywords.length) {
    dims.direction = kwOverlap(text, ctx.profile_keywords);
  } else if (ctx.historical_texts && ctx.historical_texts.length) {
    const a = tokenize(text);
    dims.direction = Math.min(100, Math.max(...ctx.historical_texts.map((h) => {
      const b = tokenize(h);
      let inter = 0;
      for (const t of b) if (a.has(t)) inter++;
      return inter * 12;
    })));
  } else {
    dims.direction = null; // 冷启动：无画像无历史，方向维缺失而非 0
  }
  // 顾问级“不感兴趣”只影响未来排序，不修改冻结快照或职位事实（仅在方向维已有分值时降权）。
  if (dims.direction != null && ctx.feedback_projects?.includes(job.project_id)) {
    dims.direction = Math.max(0, dims.direction - 20);
  }
  // 反馈闭环（baseline-1.1，2026-08-24）：公司级记忆。
  // 修正前只按 project_id 降权——同一客户换个职位重新进池就忘了顾问说过「不感兴趣」。
  // 负向：DISMISSED / ×不感兴趣 过的公司 -15；正向：承接（ACCEPTED）过的公司 +10。
  if (dims.direction != null && ctx.negative_companies?.includes(job.company)) {
    dims.direction = Math.max(0, dims.direction - 15);
  }
  if (dims.direction != null && ctx.positive_companies?.includes(job.company)) {
    dims.direction = Math.min(100, dims.direction + 10);
  }

  // 活跃度 20%：状态 + 优先级/pipeline + 新鲜度
  // 盘点源（Bitable）有结构化 priority（0007 起）；fixture 行用 pipeline 有无近似。
  // 0013 起：有驾驶舱群活跃数据的职位以「群活跃」为基底——今天还在聊的职位才是真活跃；
  // 30 天无消息的 OPEN 职位基底降到 20（活跃假象破除）；无群数据走原逻辑。
  const PRIORITY_BOOST = { HIGH: 25, NEW: 15, NORMAL: 10, STANDBY: 0 };
  let act = null;
  if (job.active_state === 'OPEN') {
    let base = 50;
    const chatMs = job.chat_last_at ? chatTs(job.chat_last_at) : NaN;
    if (Number.isFinite(chatMs)) {
      const cd = (Date.parse(ctx.now) - chatMs) / 86400000;
      // 连续指数衰减（baseline-1.1）：替代阶梯分档（65/60/55/45/35/20）。
      // 阶梯在边界跳变（昨天 65 今天 60），且平顶段无区分度；τ=14 拟合原档位：
      // d0≈65 d1≈62 d3≈56 d7≈47 d14≈36 d30≈25 d44≈22（>30 天渐近 20，活跃假象破除保留）。
      base = Math.round(20 + 45 * Math.exp(-cd / 14));
    }
    act = base;
    if (job.priority != null) act += PRIORITY_BOOST[job.priority] ?? 0;
    else if (job.pipeline) act += 25;
    const d = daysSince(job.captured_at, ctx.now);
    act += d <= 1 ? 25 : d <= 7 ? 18 : d <= 30 ? 8 : 0;
    if (act > 100) act = 100;
  }
  // 僵尸职位衰减（baseline-1.1）：同顾问 ≥3 轮推荐仍零互动 → 活跃 7 折。
  // 修正前高活跃僵尸职位可以无限霸榜 Top20（诊断：57% 行 score≥90 的天花板主因之一）。
  if (act != null && (ctx.rec_rounds?.[job.project_id] || 0) >= 3
      && !ctx.engaged_projects?.has(job.project_id)) {
    act = Math.round(act * 0.7);
  }
  dims.activity = act;

  // 历史相似 15%：与历史 MY_JOB 文本重合（含 CLOSED 历史，补全文档 §17.2-2）
  dims.similarity = ctx.historical_texts.length
    ? Math.max(...ctx.historical_texts.map((h) => {
        const a = tokenize(text);
        const b = tokenize(h);
        let inter = 0;
        for (const t of b) if (a.has(t)) inter++;
        return Math.min(100, inter * 12);
      }))
    : null;

  // 承接容量 15%：关注+接单占「上限」的反向比例。
  // 上限可配：ctx.capacity_limit（顾问级）> 默认 CAPACITY_LIMIT。修正前写死 /10，
  // 不同顾问产能不同会失真；高产能顾问被低估容量、低产能顾问被高估。
  const used = (ctx.watched_count || 0) + (ctx.accepted_count || 0);
  const limit = Number(ctx.capacity_limit) > 0 ? Number(ctx.capacity_limit) : CAPACITY_LIMIT;
  dims.capacity = Math.max(0, Math.round((1 - used / limit) * 100));

  // 历史结果 15%：有结果评分则 ×20，无则缺失
  dims.outcomes = ctx.outcomes_avg != null ? Math.round(ctx.outcomes_avg * 20) : null;

  // 探索 10%：确定性
  dims.exploration = explorationScore(job.project_id, ctx.consultant_id, ctx.now);

  // 顾问级权重覆盖（ctx.weights，经 normalizeWeights 归一）优先于全局基线
  const weights = ctx.weights || WEIGHTS;
  // NaN 护栏：脏输入（如坏的 chat_last_at/时间解析失败）算出非有限值的维一律
  // 记 null 按缺失处理——NaN != null 为真，若漏进 available 会把 score 算成 NaN，
  // INSERT recommendations(score REAL NOT NULL) 绑 NULL 整轮回滚，recommend 全灭。
  for (const k of Object.keys(dims)) if (dims[k] != null && !Number.isFinite(dims[k])) dims[k] = null;
  const available = Object.entries(weights).filter(([k]) => dims[k] != null);
  const coverage = available.reduce((s, [, w]) => s + w, 0);
  const score = available.reduce((s, [k, w]) => s + dims[k] * w, 0) / (coverage || 1);

  return {
    score: Math.round(score * 10) / 10,
    coverage: Math.round(coverage * 100) / 100,
    breakdown: Object.entries(weights).map(([k, w]) => ({ dim: k, label: DIM_LABELS[k], weight: w,
      score: dims[k], weighted_score: dims[k] == null ? null : Math.round(dims[k] * w * 100) / 100,
      status: dims[k] == null ? 'missing' : 'available' })),
  };
}

export function actionOf(score, coverage) {
  if (coverage < 0.5) return 'OBSERVE'; // 硬规则：证据不足只观察
  if (score >= 75) return 'RECOMMEND_ACCEPT';
  if (score >= 55) return 'RECOMMEND_WATCH';
  return 'OBSERVE';
}

export function bandOf(coverage) {
  return coverage >= 0.85 ? 'HIGH' : coverage >= 0.6 ? 'MEDIUM' : 'LOW';
}

/** 确定性排序（PRD §6）：score↓ → coverage↓ → 新鲜度↓ → project_id↑。 */
export function sortRecs(a, b) {
  return b.score - a.score
      || b.evidence_coverage - a.evidence_coverage
      || String(b.job.captured_at).localeCompare(String(a.job.captured_at))
      || String(a.job.project_id).localeCompare(String(b.job.project_id));
}

/** 事实理由与风险（≥2 条理由，禁止裸分数）。 */
export function explain(job, relation, scored, ctx) {
  const b = Object.fromEntries(scored.breakdown.map((d) => [d.dim, d.score]));
  const reasons = [];
  const relLabel = { MY_JOB: '我的职位', PRIMARY_PM: '我是主 PM', TEAM_SHARED: '团队共享', OTHER_CONSULTANT: '其他顾问主做' }[relation] || relation;
  reasons.push(`关系：${relLabel}${job.pipeline ? `；${job.pipeline}` : ''}`);
  if (b.direction != null) {
    // B13：画像为空时方向分来自历史文本兜底，文案不能出现「画像关键词（）等」
    reasons.push(ctx.profile_keywords.length
      ? `方向匹配 ${b.direction} 分：与你画像关键词（${ctx.profile_keywords.slice(0, 3).join('/')}等）的重合度`
      : `方向匹配 ${b.direction} 分：与你历史主做项目文本的重合度（画像未配置）`);
  }
  if (b.activity != null) reasons.push(`活跃度 ${b.activity} 分：状态 ${job.active_state}${job.priority ? `，优先级${PRIORITY_LABEL[job.priority] || job.priority}` : job.pipeline ? '，Pipeline 有进展记录' : ''}${job.chat_last_at ? `，群活跃 ${String(job.chat_last_at).slice(5, 16)}（近7天 ${job.chat_msgs_7d ?? 0} 条）` : ''}，最近变化 ${String(job.captured_at).slice(0, 10)}`);
  if (b.similarity != null && b.similarity > 0) reasons.push(`历史相似 ${b.similarity} 分：与你历史主做项目存在重合特征`);
  if (ctx.positive_companies?.includes(job.company)) reasons.push(`你曾承接该公司项目，方向维加权`);
  const risks = [];
  if (ctx.negative_companies?.includes(job.company)) risks.push(`该公司此前被你标记不感兴趣/暂不考虑，方向维已降权`);
  const zombieRounds = (ctx.rec_rounds?.[job.project_id] || 0);
  if (zombieRounds >= 3 && !ctx.engaged_projects?.has(job.project_id)) risks.push(`已连续 ${zombieRounds} 轮推荐未互动，活跃度降权防霸榜`);
  const capLimit = Number(ctx.capacity_limit) > 0 ? Number(ctx.capacity_limit) : CAPACITY_LIMIT;
  if ((ctx.watched_count || 0) >= Math.max(3, Math.floor(capLimit * 0.7))) {
    risks.push(`关注榜已 ${ctx.watched_count}/${capLimit}，接近上限`);
  }
  if (job.hc != null && job.hc <= 1) risks.push('HC 仅剩 1，窗口小');
  if (job.hc == null) risks.push('HC 未知（飞书源无此字段，待 ATS 补齐）');
  if (b.outcomes == null) risks.push('历史结果维度缺失：冷启动期，证据覆盖率被拉低');
  if (relation === 'TEAM_SHARED') risks.push('团队共享职位：需先确认无人已接单');
  if (relation === 'OTHER_CONSULTANT') risks.push('其他顾问主做：可作机会发现，接单后请及时与对方沟通协调');
  const evidence_refs = [];
  if (job.source_url) evidence_refs.push({ type: 'source', ref: job.source_url, excerpt: `${job.company}/${job.role}` });
  evidence_refs.push({ type: 'sync', ref: ctx.snapshot_id || '', excerpt: `快照 ${ctx.snapshot_id || 'N/A'} · ${String(job.captured_at).slice(0, 10)}` });
  return { reasons: reasons.slice(0, 4), risks: risks.slice(0, 3), evidence_refs };
}

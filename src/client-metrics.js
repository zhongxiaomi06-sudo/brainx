/** client-metrics.js — 客户健康指标只读取数 + 生命周期推送策略（specs/022 US6 第一批）。
 *
 * 权威契约: specs/022-client-feedback-signals/spec.md §US6 + docs/2026-09-25-first-batch-push.md。
 * 数据源：client_metrics / client_metric_benchmarks（0058；第一批=报告快照导入，
 * US2 日常化计算器落地后由 bin/brainx-client-metrics.mjs 增量更新）。
 * 红线：休眠档完全静默（SC-6）；策略映射进常量表而非散落硬编码；本模块只读。
 */

/** 生命周期 → 推送策略。silent=true 时该客户名下职位不得进任何自动推送。 */
export const PUSH_POLICIES = Object.freeze({
  mature:      { silent: false, tag: null },
  calibration: { silent: false, tag: null },
  cold_start:  { silent: false, tag: '破冰优先' },
  dormant:     { silent: true,  tag: null }, // US6 红线：休眠完全静默，另出 BD 移交清单
});

const DEFAULT_POLICY = { silent: false, tag: null };

/** 纯函数：stage → 推送策略（未知 stage 不静默——宁推勿漏，缺失数据不等于休眠）。 */
export function pushPolicyFor(stage) {
  return PUSH_POLICIES[stage] || DEFAULT_POLICY;
}

/** 单客户指标行。 */
export function getClientMetrics(db, chatId) {
  return db.prepare('SELECT * FROM client_metrics WHERE chat_id = ?').get(chatId) || null;
}

/** 项目 → 客户指标（经 job_facts.chat_id 关联；无关联或无指标行返回 null）。 */
export function metricsForProject(db, projectId) {
  return db.prepare(`SELECT m.* FROM client_metrics m
    JOIN job_facts j ON j.chat_id = m.chat_id
    WHERE j.project_id = ?`).get(projectId) || null;
}

/** 第一批顾问集合：consultant_chats ⋈ client_metrics，附每顾问覆盖的客户分档计数。 */
export function listFirstBatchConsultants(db) {
  return db.prepare(`SELECT c.consultant_id, u.display_name, u.open_id,
      COUNT(DISTINCT m.chat_id) AS client_count,
      SUM(CASE WHEN m.stage='dormant' THEN 1 ELSE 0 END) AS dormant_count,
      SUM(CASE WHEN m.stage='cold_start' THEN 1 ELSE 0 END) AS cold_start_count
    FROM consultant_chats c
    JOIN client_metrics m ON m.chat_id = c.chat_id
    JOIN consultants u ON u.consultant_id = c.consultant_id AND u.active = 1
    GROUP BY c.consultant_id
    ORDER BY client_count DESC`).all();
}

/** 分位锚点（特征层 US4 的归一化来源；按 anchor_version 冻结）。 */
export function getBenchmarks(db, anchorVersion) {
  const rows = db.prepare(`SELECT metric_key, p25, p50, p75 FROM client_metric_benchmarks
    WHERE anchor_version = ?`).all(anchorVersion);
  return Object.fromEntries(rows.map((r) => [r.metric_key, r]));
}

/** 对一顾问的推荐项应用生命周期策略（纯呈现层，不改冻结推荐）：
 * dormant 客户名下职位剔除；cold_start 在 reasons 头部注入「破冰优先」标注。
 * 返回 { items, dropped, tagged }。 */
export function applyLifecyclePolicy(db, items) {
  const kept = [];
  let dropped = 0;
  const tagged = [];
  for (const r of items) {
    const m = metricsForProject(db, r.job?.project_id);
    const policy = pushPolicyFor(m?.stage);
    if (policy.silent) { dropped++; continue; }
    if (policy.tag && m) {
      tagged.push({ project_id: r.job.project_id, stage: m.stage, client: m.client_name });
      r.reasons = [`「${policy.tag}」客户处于冷启动期，优先推进首个推荐闭环`, ...(r.reasons || [])];
    }
    kept.push(r);
  }
  return { items: kept, dropped, tagged };
}

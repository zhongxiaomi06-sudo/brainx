import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRadarPositionType,
  directionOf,
  eligibilityOf,
  factsOf,
  groupOf,
  getRadar,
  getTtcFieldReport,
  mapClientRow,
  mapEvents,
  mapOutcomes,
  mapRadarRow,
  mapRecommendation,
  mapReplayData,
  mapSyncStatus,
  BrainxApiError,
} from "../app/brainx-api.ts";
import { mergeOpportunityDetail, newestEvents, toDecisionJobDetail, toRadarJobDetail } from "../app/job-detail-data.ts";
import { projectToDecisionJob } from "../app/brainx-projects-api.ts";
import { mapRecommendationPage } from "../app/brainx-recommendation-pages-api.ts";
import { openmaiToHtml } from "../app/openmai-markdown.ts";

const sampleRec = {
  decision_id: "d-1",
  rank: 1,
  action: "RECOMMEND_ACCEPT",
  score: 79.9,
  confidence_band: "HIGH",
  evidence_coverage: 0.85,
  reasons: ["关系：我是主 PM；有，正常招/常年招", "方向匹配 25 分：与画像关键词重合"],
  risks: ["HC 未知（飞书源无此字段，待 ATS 补齐）"],
  evidence_refs: [
    { type: "source", ref: "feishu://base/xxx", excerpt: "Rockflow/产品、工程、运营增长（多岗）" },
    { type: "sync", ref: "snap-1", excerpt: "快照 snap-1 · 2026-08-07" },
  ],
  breakdown: [
    { dim: "direction", weight: 0.25, score: 25 },
    { dim: "activity", weight: 0.2, score: 68 },
    { dim: "similarity", weight: 0.15, score: 36 },
    { dim: "capacity", weight: 0.15, score: 100 },
    { dim: "outcomes", weight: 0.15, score: null },
    { dim: "exploration", weight: 0.1, score: 50 },
  ],
  job: {
    project_id: "P-FIX-E5FC611B",
    company: "Rockflow",
    role: "产品、工程、运营增长（多岗）",
    city: "北京",
    pipeline: "有，正常招/常年招",
    hc: null,
    active_state: "OPEN",
    priority: null,
    notes: null,
    company_type: null,
    source_url: "feishu://base/RR5N/record",
    captured_at: "2026-08-07T08:40:00+08:00",
    relation: "PRIMARY_PM",
  },
};

const samplePresentation = {
  decision_tier: "VERIFY",
  decision_tier_reason: { code: "FACTS_REQUIRE_VERIFICATION", text: "关键事实不足，先核验再推进" },
  data_confidence: {
    band: "INSUFFICIENT",
    rule_version: "data-confidence-1.0",
    missing_fields: ["HC", "当前阶段"],
    latest_fact_at: "2026-08-07T00:40:00.000Z",
    age_days: 22,
    stale: false,
    reasons: [{ code: "CRITICAL_FACTS_MISSING", text: "HC、当前阶段待确认" }],
    primary_risk: "HC、当前阶段待确认，推进前请先核验。",
  },
  recent_activity: {
    type: "JOB_FACT_UPDATED", label: "职位事实更新",
    occurred_at: "2026-08-07T00:40:00.000Z", source: "SYNC", detail: null,
  },
  presentation_version: "recommendation-presentation-1.0",
  presentation_source: "FROZEN",
};

test("decision trail keeps only the newest three events", () => {
  const ordered = newestEvents([
    { id: "old", at: "08/30 12:42" },
    { id: "latest", at: "08/30 17:49" },
    { id: "middle", at: "08/30 17:16" },
    { id: "older", at: "08/30 13:52" },
  ]);
  assert.deepEqual(ordered.map(event => event.id), ["latest", "middle", "older"]);
});

test("maps a backend recommendation into a workbench decision job", () => {
  const job = mapRecommendation(sampleRec);
  assert.equal(job.id, "P-FIX-E5FC611B");
  assert.equal(job.company, "Rockflow");
  assert.equal(job.rank, 1);
  assert.equal(job.finalScore, 79.9);
  assert.equal(job.globalScore, 68); // activity 维
  assert.equal(job.explorationScore, 50); // exploration 维
  assert.equal(job.personalScore, 25); // direction 维
  assert.equal(job.evidenceCoverage, 85);
  assert.equal(job.group, "ACTIVE_ADVANCEMENT");
  assert.equal(job.eligibility, "ELIGIBLE");
  assert.equal(job.sourceMode, "MARKET_ONLY"); // 无 source_mode 字段时按职位市场（与后端隔离判定一致）
  assert.equal(job.scoreNotes.length, 2);
  assert.equal(job.evidence.length, 2);
  assert.equal(job.actions[0].kind, "advance");
});

test("source_mode 透出：COCKPIT_CONTEXT 不再被前端硬编码吞掉（2026-08-30 事故回归）", () => {
  // 后端自 2026-08-30 起逐 item 透出 source_mode/membership_status，
  // 前端曾硬编码 MARKET_ONLY，导致驾驶舱职位在「数据来源」筛选下永远不可见。
  const cockpit = mapRecommendation({ ...sampleRec, source_mode: "COCKPIT_CONTEXT", membership_status: "UNCONFIRMED" });
  assert.equal(cockpit.sourceMode, "COCKPIT_CONTEXT");
  const market = mapRecommendation({ ...sampleRec, source_mode: "MARKET_ONLY", membership_status: null });
  assert.equal(market.sourceMode, "MARKET_ONLY");
});

test("maps run-bound recommendation page metadata and legal state", () => {
  const page = mapRecommendationPage({
    blocked: false,
    run_id: "run-1",
    snapshot_id: "snapshot-1",
    policy_version: "baseline-1.1",
    generated_at: "2026-08-29T08:00:00Z",
    evaluated_count: 5313,
    total_count: 45,
    page_size: 20,
    sort: "recent",
    next_cursor: "cursor-20",
    new_run_available: false,
    items: [{ ...sampleRec, ...samplePresentation,
      engagement_state: "WATCHED", legal_actions: ["VIEW", "UNWATCH", "ACCEPT"] }],
  });
  assert.equal(page.runId, "run-1");
  assert.equal(page.totalCount, 45);
  assert.equal(page.evaluatedCount, 5313);
  assert.equal(page.nextCursor, "cursor-20");
  assert.equal(page.sort, "recent");
  assert.equal(page.engagement["P-FIX-E5FC611B"], "WATCHED");
  assert.deepEqual(page.jobs[0].brainxLegal, ["UNWATCH", "ACCEPT"]);
  assert.equal(page.jobs[0].facts["决策层级"], "VERIFY");
  assert.equal(page.jobs[0].facts["事实可信度"], "INSUFFICIENT");
  assert.equal(page.jobs[0].facts["事实可信度规则"], "data-confidence-1.0");
  assert.equal(page.jobs[0].facts["最近活动"], "职位事实更新");
  assert.equal(page.jobs[0].facts["最近活动时间"], "2026-08-07T00:40:00.000Z");
});

test("treats null HC as UNKNOWN, never as 0", () => {
  const job = mapRecommendation(sampleRec);
  assert.equal(job.facts["剩余 HC"], "UNKNOWN");
  assert.equal(job.facts["职位关系"], "我是主 PM");
  assert.equal(job.facts["当前阶段"], "招聘中");
  assert.equal(job.facts["最近活动"], "2026-08-07");
  assert.match(job.recentSignal, /证据覆盖 85%/);
});

test("derives observe/verify for low-coverage recommendations", () => {
  const rec = {
    ...sampleRec,
    action: "OBSERVE",
    score: 41,
    evidence_coverage: 0.4,
    breakdown: [{ dim: "activity", weight: 0.2, score: 30 }],
    job: { ...sampleRec.job, hc: 2, relation: "TEAM_SHARED" },
  };
  const job = mapRecommendation(rec);
  assert.equal(job.group, "NEW_VALIDATION");
  assert.equal(job.eligibility, "VERIFY_REQUIRED");
  assert.equal(job.actions[0].kind, "verify");
});

test("allows independent engagement while flagging another consultant ownership", () => {
  const rec = {
    ...sampleRec,
    job: { ...sampleRec.job, hc: 1, relation: "OTHER_CONSULTANT" },
  };
  const job = mapRecommendation(rec);
  assert.equal(job.eligibility, "ELIGIBLE");
  assert.equal(job.actions[0].id, "ownership");
  assert.equal(eligibilityOf("RECOMMEND_ACCEPT", "NOT_JOINED", 1, "OPEN"), "VERIFY_REQUIRED");
});

test("excludes closed or zero-HC jobs", () => {
  const rec = {
    ...sampleRec,
    job: { ...sampleRec.job, hc: 0, active_state: "CLOSED" },
  };
  const job = mapRecommendation(rec);
  assert.equal(job.group, "EXCLUDE");
  assert.equal(job.eligibility, "EXCLUDED");
  assert.equal(groupOf("RECOMMEND_WATCH", null, "COOLING"), "MAINTENANCE");
});

test("classifies role direction from role text", () => {
  assert.equal(directionOf("资深海外投放经理"), "paid");
  assert.equal(directionOf("海外增长负责人"), "growth");
  assert.equal(directionOf("市场总监 / Manager"), "marketing");
  assert.equal(directionOf("GTM Leader"), "marketing");
});

test("maps backend sync status, including reauth", () => {
  assert.equal(mapSyncStatus({ state: "READY", updated_at: "2026-08-14T03:48:21.361Z", rows_read: 60, rows_expected: 60, errors: [] }).state, "READY");
  assert.equal(mapSyncStatus({ state: "INCOMPLETE", errors: ["缺 project_id"] }).state, "INCOMPLETE");
  assert.equal(mapSyncStatus(null).state, "EMPTY");
  const reauth = mapSyncStatus({ state: "READY" }, { needs_reauth: true });
  assert.equal(reauth.state, "AUTH_EXPIRED");
});

test("normalizes backend error envelopes by HTTP semantics", () => {
  assert.equal(new BrainxApiError("登录失效", 401, "UNAUTHORIZED").kind, "AUTH");
  assert.equal(new BrainxApiError("状态冲突", 409, "CONFLICT").kind, "CONFLICT");
  assert.equal(new BrainxApiError("参数错误", 422, "BAD_REQUEST").kind, "VALIDATION");
  assert.equal(new BrainxApiError("服务不可用", 502, "UPSTREAM").kind, "UNAVAILABLE");
  assert.equal(new BrainxApiError("未知错误", 404, "NOT_FOUND").kind, "HTTP");
});

test("maps events and outcomes with local display fields", () => {
  const events = mapEvents([
    { event_type: "RECOMMENDED", occurred_at: "2026-08-14T03:48:21.416Z", actor: "felix" },
    { event_type: "DISMISSED", occurred_at: "2026-08-14T04:00:00Z", reason: "当前没精力" },
  ]);
  assert.equal(events[0].type, "已推荐");
  assert.equal(events[1].reason, "当前没精力");

  const outcomes = mapOutcomes([
    { stage: "面试", observed_at: "2026-08-14T04:05:00Z", value: { rating: 4, note: "首轮验证" } },
  ]);
  assert.equal(outcomes[0].stage, "面试");
  assert.equal(outcomes[0].rating, 4);
  assert.equal(outcomes[0].note, "首轮验证");
});

test("maps frozen replay data without recomputation", () => {
  const replay = mapReplayData({
    decision_id: "d-1",
    recommendation: {
      rank: 2,
      policy_version: "baseline-1.0",
      created_at: "2026-08-14T03:48:21.416Z",
      reasons: ["关系：团队共享"],
      risks: ["HC 未知"],
      evidence_refs: [{ type: "sync", ref: "snap-1", excerpt: "快照 snap-1" }],
    },
    events: [{ event_type: "WATCHED", occurred_at: "2026-08-14T04:10:00Z" }],
    outcomes: [{ stage: "反馈", observed_at: "2026-08-14T04:12:00Z", value: { note: "已回写" } }],
  });
  assert.equal(replay.decisionId, "d-1");
  assert.equal(replay.policyVersion, "baseline-1.0");
  assert.equal(replay.rank, 2);
  assert.equal(replay.events[0].type, "已关注");
  assert.equal(replay.outcomes[0].note, "已回写");
});

test("facts keep UNKNOWN for missing fields instead of inventing values", () => {
  const facts = factsOf({ relation: "UNKNOWN" });
  assert.equal(facts["剩余 HC"], "UNKNOWN");
  assert.equal(facts["职位关系"], "UNKNOWN");
  assert.equal(facts["当前阶段"], "UNKNOWN");
});

test("maps backend radar rows without inventing operational metrics", () => {
  const row = mapRadarRow({
    project_id: "P-FIX-ABC",
    company: "蝴蝶梦境",
    role: "海外增长负责人",
    city: "上海",
    cities: ["上海市", "北京市"],
    pipeline: "推荐 3 · 面试 1",
    pipeline_steps: { recommendation: 3, interview: 1 },
    owner_name: "Mia 钟笑咪",
    hc: null,
    active_state: "OPEN",
    relation: "TEAM_SHARED",
    captured_at: "2026-08-12T00:00:00+08:00",
    cockpit: null,
  });
  assert.equal(row.id, "P-FIX-ABC");
  assert.equal(row.client, "蝴蝶梦境");
  assert.equal(row.status, "活跃");
  assert.equal(row.source, "市场信号");
  assert.equal(row.hc, null); // UNKNOWN 原样为 null，绝不写 0
  assert.deepEqual(row.cities, ["上海市", "北京市"]);
  assert.deepEqual(row.pipelineSteps, { recommendation: 3, interview: 1 });
  assert.equal(row.ownerName, "Mia 钟笑咪");
  assert.equal(row.score, null);
  assert.equal(row.recommended, null);
  assert.equal(row.pm, "团队共享");
  assert.match(row.reason, /Pipeline/);
  assert.equal(row.positionType, "商业化");
});

test("keeps notes and merges one complete detail contract for both job entries", () => {
  const base = toRadarJobDetail({
    project_id: "P-DETAIL-1", company: "示例客户", role: "平台研发负责人",
    cities: ["上海市"], active_state: "OPEN", hc: 1, relation: "TEAM_SHARED",
    priority: "HIGH", notes: "必须完整保留的职位说明", source_url: "https://example.com/job/1",
  });
  assert.equal(base.notes, "必须完整保留的职位说明");
  assert.equal(base.priority, "HIGH");

  const merged = mergeOpportunityDetail(base, {
    job: { project_id: "P-DETAIL-1", pipeline_steps: { Interview: 2 }, owner_name: "顾问甲", notes: "后端最新备注" },
    relation: { relation: "TEAM_SHARED" }, engagement_state: "VIEWED", legal_actions: [], outcomes: [],
    events: [{ event_type: "VIEWED", occurred_at: "2026-08-27T10:30:00Z", reason: "今日决策打开" }],
    latest_recommendation: { decision_id: "D-1", score: 90, action: "RECOMMEND_ACCEPT", reasons: ["动能明确"], risks: [], evidence_refs: [], created_at: "2026-08-27T10:25:00Z" },
  });
  assert.equal(merged.notes, "后端最新备注");
  assert.deepEqual(merged.pipeline, { Interview: 2 });
  assert.equal(merged.events?.[0].detail, "今日决策打开");

  const today = toDecisionJobDetail({ ...mapRecommendation({ ...sampleRec, job: { ...sampleRec.job, notes: "今日决策备注" } }) }, []);
  assert.equal(today.notes, "今日决策备注");
});

test("normalizes radar field capabilities and sync report for the frontend", async () => {
  const backendReport = {
    sync_id: "sync-1", consultant_id: "mia", created_at: "2026-08-26T00:00:00Z",
    schema_version: "ttc-job-search-2026-08-26", total_rows: 1,
    rows_expected: 1, rows_read: 1, complete: true, errors: [], warnings: [],
    fields: [{ key: "city", label: "城市", kind: "text-list", populated: 1, coverage: 1,
      display_available: true, filter_available: true }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path) => new Response(JSON.stringify(String(path).includes("field-report")
    ? { report: backendReport }
    : {
        schema_version: backendReport.schema_version,
        items: [{ project_id: "p-1", cities: ["上海市"], pipeline_steps: { Interview: 1 }, owner_name: "Mia" }],
        field_capabilities: backendReport.fields,
        field_report: backendReport,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const radar = await getRadar();
    assert.equal(radar.schemaVersion, backendReport.schema_version);
    assert.equal(radar.fieldCapabilities[0].filterAvailable, true);
    assert.equal(radar.fieldReport.syncId, "sync-1");
    const report = await getTtcFieldReport();
    assert.equal(report.totalRows, 1);
    assert.equal(report.fields[0].displayAvailable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("maps cockpit radar rows as 驾驶舱导入 with cockpit context", () => {
  const row = mapRadarRow({
    project_id: "P-FIX-CPT",
    company: "39AI",
    role: "增长投放经理",
    active_state: "OPEN",
    relation: "PRIMARY_PM",
    hc: 1,
    cockpit: { membership_status: "PRIMARY_PM", current_stage: "ACTIVE_ADVANCEMENT", next_action: "回写信号" },
  });
  assert.equal(row.source, "驾驶舱导入");
  assert.equal(row.sourceColumn, "驾驶舱导入");
  assert.match(row.reason, /我主做/);
  assert.match(row.reason, /ACTIVE_ADVANCEMENT/);
  assert.equal(row.status, "活跃");
});

test("maps radar statuses from active_state without fabricating signals", () => {
  assert.equal(mapRadarRow({ project_id: "p1", active_state: "CLOSED", relation: "TEAM_SHARED" }).status, "已关闭");
  assert.equal(mapRadarRow({ project_id: "p2", active_state: "COOLING", relation: "TEAM_SHARED" }).status, "降温");
  assert.equal(mapRadarRow({ project_id: "p3", relation: "TEAM_SHARED" }).status, "待同步");
});

test("maps backend client rows honestly (null hc stays null, no invented metrics)", () => {
  const c = mapClientRow({
    company: "蝴蝶梦境", company_type: "跨境电商", job_count: 7, active_jobs: 7,
    hc_known: null, last_activity: "2026-08-12T00:00:00+08:00",
    relations: ["TEAM_SHARED"], states: ["OPEN"],
  });
  assert.equal(c.name, "蝴蝶梦境");
  assert.equal(c.state, "有活跃职位");
  assert.equal(c.hc, null); // 绝不写 0
  assert.equal(c.score, null);
  assert.equal(c.hires, null);
  assert.equal(c.r2i, "待后端");
  assert.match(c.feedback, /2026-08-12/);
  const other = mapClientRow({
    company: "X", relations: ["OTHER_CONSULTANT"], states: ["OPEN"],
    job_count: 2, active_jobs: 0,
  });
  assert.equal(other.state, "无活跃职位");
  assert.equal(other.risk, "其他顾问主做");
});

test("classifies radar position types from role text", () => {
  assert.equal(classifyRadarPositionType("算法工程师（大模型）"), "算法");
  assert.equal(classifyRadarPositionType("产品经理"), "产品");
  assert.equal(classifyRadarPositionType("海外投放经理"), "商业化");
  assert.equal(classifyRadarPositionType("前端开发"), "技术");
});

test("maps a real project summary without inventing score or HC", () => {
  const job = projectToDecisionJob({
    project_id: "P-MY-1", relation: "MY_JOB", membership_source: "MANUAL_CONFIRMATION",
    joined_at: "2026-08-29T00:00:00.000Z", company: "真实客户", role: "增长负责人",
    city: "上海", active_state: "OPEN", hc: null, pipeline: "面试 2", current_stage: "面试",
    pipeline_snapshot: null, next_action: null, owner_name: "Mia", captured_at: "2026-08-28T00:00:00.000Z",
    engagement_state: "NEW", state_since: null, project_status: "PENDING_START", active_action: null,
    legal_actions: ["WATCH", "ACCEPT", "DISMISS"],
  });
  assert.equal(job.id, "P-MY-1");
  assert.equal(job.finalScore, "—");
  assert.equal(job.facts["剩余 HC"], "UNKNOWN");
  assert.equal(job.recentSignal, "面试");
  assert.deepEqual(job.brainxLegal, ["WATCH", "ACCEPT", "DISMISS"]);
});

test("openmaiToHtml：候选人表格渲染为 <table>，机器块与 HTML 注释被剥离（2026-08-31）", () => {
  // 取真实 result_text 的结构样本（生产 JDWIAC3）：标题 + 表格 + 链接 + 机器 JSON 块 + 注释
  const sample = [
    "## 搜索结果",
    "",
    "当前共命中 **4 位**候选人。",
    "",
    "| # | 姓名 | 核心匹配点 | 查看 |",
    "|---|---|---|---|",
    "| 1 | 童文心 | 字节跳动背景 | [查看](https://ttcadvisory.com/app/private-talent/talents/PT2064600175304888320) |",
    "",
    "```openmai-table-artifact",
    '{"type":"openmai-table-artifact","total":4}',
    "```",
    "",
    "<!-- RECOMMENDED_IDS: PT2064600175304888320 -->",
  ].join("\n");
  const html = openmaiToHtml(sample);
  assert.match(html, /<h2>搜索结果<\/h2>/);
  assert.match(html, /<table>/);
  assert.match(html, /童文心/);
  assert.match(html, /<a target="_blank" rel="noopener noreferrer" href="https:\/\/ttcadvisory\.com/);
  assert.ok(!html.includes("openmai-table-artifact"), "机器 JSON 块不得出现");
  assert.ok(!html.includes("RECOMMENDED_IDS"), "HTML 注释不得出现");
  assert.ok(!html.includes("<!--"), "不得残留任何 HTML 注释");
});

test("openmaiToHtml：空输入与无表格输入不炸", () => {
  assert.equal(openmaiToHtml(""), "");
  assert.match(openmaiToHtml("找人中，请稍候"), /找人中/);
});

// brainx-api.ts — Brain X 后端（btex/brainx）HTTP 适配层。
// 前端唯一数据通道：页面不得直接 fetch /api；全部请求与映射集中在这里。
// 后端契约见 brainx/src/server.js 与 README「后端接入」章节。
//
// 纯函数映射器（map*/of*）不依赖浏览器环境，供 tests/brainx-adapter.test.mjs 直接单测。
// 请求函数只在浏览器端调用；SSR（npm run build）期间不会触发任何网络请求。
import type {
  DecisionEvent,
  EngagementCommand,
  EngagementState,
  Notification,
  Outcome,
  CommitmentAction,
  CommitmentSnapshot,
  SyncStatus,
} from "./decision-demo";
import { brainxFetch } from "./brainx-http.ts";
import { getProjects, type ProjectSummary } from "./brainx-projects-api.ts";
export { brainxFetch, BrainxApiError } from "./brainx-http.ts";
export {
  classifyRadarPositionType, getClients, getRadar, getTtcFieldReport, mapClientRow, mapRadarRow,
} from "./brainx-radar-api.ts";
export type {
  BackendClientRow, BackendRadarRow, RadarClient, RadarFieldCapability, RadarFieldReport, RadarJob, RadarPayload,
  RadarPositionType,
} from "./brainx-radar-api.ts";
// —— 与 workbench.tsx 的 DecisionJob 结构一致的映射结果（结构类型，避免循环依赖）——
export type BrainxDirection = "paid" | "growth" | "marketing";
export type BrainxGroup =
  | "RESULT_CLOSURE" | "ACTIVE_ADVANCEMENT" | "NEW_VALIDATION" | "MAINTENANCE" | "EXCLUDE";
export type BrainxEligibility = "ELIGIBLE" | "VERIFY_REQUIRED" | "BLOCKED" | "EXCLUDED";
export type BrainxDecisionAction = {
  id: string; label: string;
  kind: "verify" | "advance" | "watch" | "skip";
  detail: string;
};
export type ManualFactField =
  | "active_state" | "current_stage" | "pipeline_snapshot"
  | "remaining_hc" | "next_action" | "notes";
export type BrainxFactField = {
  value: string | number | null;
  effective_value: string | number | null;
  source: "SYNC" | "MANUAL" | "UNKNOWN";
  updated_at: string | null;
};
export type BrainxFactFields = Partial<Record<ManualFactField, BrainxFactField>>;
export type BrainxJob = {
  id: string; rank: number; company: string; role: string;
  direction: BrainxDirection; sourceMode: "COCKPIT_CONTEXT" | "MARKET_ONLY";
  group: BrainxGroup; eligibility: BrainxEligibility;
  globalScore: number | string; explorationScore: number | string;
  personalScore: number | string; finalScore: number | string;
  evidenceCoverage: number | null;
  recommendation: string; recentSignal: string;
  facts: Record<string, string>; scoreNotes: string[];
  factFields?: BrainxFactFields;
  scoreBreakdown?: BackendBreakdown[];
  risks: string[]; evidence: string[]; actions: BrainxDecisionAction[];
  brainxLegal?: EngagementCommand[]; brainxDecisionId?: string;
};
export type BrainxSnapshot = {
  consultantId: string;
  jobs: BrainxJob[];
  engagement: Record<string, EngagementState>;
  events: Record<string, DecisionEvent[]>;
  outcomes: Record<string, Outcome[]>;
  legal: Record<string, EngagementCommand[]>;
  sync: SyncStatus;
  auth: { consultant: string; authorized: boolean; needsReauth: boolean };
  notifications: Notification[];
  dismissReasons: string[];
  runId: string | null;
  snapshotId: string | null;
  policyVersion: string | null;
  profileKeywords: string[];
  openmai: Record<string, OpenmaiResult | null>;
  preferences: WorkbenchPreferences;
  projects: ProjectSummary[];
};

export type BrainxReplay = {
  decisionId: string;
  snapshotAt: string;
  policyVersion: string;
  rank: number;
  reasons: string[];
  risks: string[];
  evidence: string[];
  events: DecisionEvent[];
  outcomes: Outcome[];
};

type BackendEvidenceRef = { type?: string; ref?: string; excerpt?: string };
export type BackendBreakdown = { dim: string; label?: string; weight: number; score: number | null; weighted_score?: number | null; status?: "available" | "missing" };
type BackendJob = {
  project_id: string; company?: string; role?: string; city?: string | null;
  cities?: string[]; pipeline?: string | null; pipeline_steps?: Record<string, number> | null;
  owner_name?: string | null; hc?: number | null; active_state?: string | null;
  priority?: string | null; notes?: string | null; company_type?: string | null;
  current_stage?: string | null; pipeline_snapshot?: string | null; next_action?: string | null;
  fact_sources?: Partial<Record<ManualFactField, string>>;
  fact_updated_at?: Partial<Record<ManualFactField, string | null>>;
  source_url?: string | null; captured_at?: string | null; relation?: string | null;
};
export type BackendRecommendation = {
  decision_id: string; rank: number; action: string; score: number;
  confidence_band: string; evidence_coverage: number;
  reasons: string[]; risks: string[]; evidence_refs: BackendEvidenceRef[];
  breakdown?: BackendBreakdown[]; job: BackendJob; source_mode?: "COCKPIT_CONTEXT" | "MARKET_ONLY"; membership_status?: string | null; // 隔离透出（2026-08-30 起逐 item；唯一权威=cockpit_facts 行存在，公司名相似不升格）
};
export type BackendSync = {
  state: string; updated_at?: string | null; rows_read?: number | null;
  rows_expected?: number | null; errors?: string[]; warning?: { at: string; message: string; detail?: string } | null;
};
export type BackendWorkbench = {
  consultant_id: string; sync: BackendSync; feishu_auth?: { authorized?: boolean; needs_reauth?: boolean };
  ttc_auth?: Record<string, unknown>; current_policy_version?: string | null;
  watched_count?: number; watched_limit?: number; accepted_count?: number; cooldown_count?: number;
  need_action_count?: number; today_top3?: BackendRecommendation[];
  run_id?: string | null;
};
export type BackendRecommendations = {
  blocked: boolean; reason?: string; run_id?: string | null; snapshot_id?: string | null;
  policy_version?: string | null; generated_at?: string; items: BackendRecommendation[]; empty?: boolean;
};
export type BackendOpportunity = {
  job: BackendJob & { raw_json?: never }; fact_updates?: BrainxFactFields;
  relation: { relation: string | null; source?: string | null; valid_from?: string | null };
  engagement_state: EngagementState; legal_actions: EngagementCommand[];
  events: BackendEvent[]; outcomes: BackendOutcome[]; latest_recommendation: BackendLatestRecommendation | null;
  openmai?: OpenmaiResult | null;
  commitment_goal?: string | null; active_action?: BackendCommitmentAction | null;
  action_history?: BackendCommitmentAction[]; suggested_action?: BackendSuggestedAction | null;
  terminal_result_missing?: boolean;
};
export type BackendCommitmentAction = { action_id: string; title: string; due_at: string; status: "OPEN"|"BLOCKED"|"DONE"|"CANCELLED"; source: "RULE"|"MANUAL"; created_at: string; completed_at?: string|null; completion_note?: string|null };
export type BackendSuggestedAction = { title: string; due_at: string; source: "RULE"|"MANUAL"; rule?: string };
export type BackendEvent = { event_type: string; occurred_at?: string; actor?: string; reason?: string | null };
export type BackendOutcome = { stage: string; observed_at?: string; value?: { rating?: number; note?: string } | null };
export type BackendLatestRecommendation = {
  decision_id: string; score: number; action: string; confidence_band?: string;
  evidence_coverage?: number; reasons: string[]; risks: string[]; evidence_refs: BackendEvidenceRef[];
  breakdown?: BackendBreakdown[]; policy_version?: string; created_at?: string;
};
export type BackendReplay = {
  decision_id: string; run?: { run_id: string; snapshot_id: string; policy_version: string; created_at: string; candidate_count: number } | null;
  recommendation: BackendLatestRecommendation & { project_id: string; rank: number; score_breakdown?: BackendBreakdown[] };
  job_now?: { company?: string; role?: string; active_state?: string; note?: string } | null;
  events: BackendEvent[]; outcomes: BackendOutcome[];
};
export type BackendProfile = { consultant_id: string; display_name: string; profile_keywords: string[]; profile_note: string; feishu_auth?: { authorized?: boolean; needs_reauth?: boolean } };
export type WorkbenchFolder = { id: string; name: string; jobIds: string[] };
export type WorkbenchPreferences = { tray: string[]; folders: WorkbenchFolder[]; folderMode: boolean; updatedAt?: string | null };
export type BackendDismissReasons = { items: string[] };
export type BackendSessionStatus = { configured: boolean; dev_auth: boolean };
export type BackendSseEvent = { type?: "hello" | "sync" | "recommend" | "sync_error" | "openmai_result"; message?: string; consultant_id?: string; project_id?: string; status?: string; at?: string };
export type BackendConsultants = { items: { consultant_id: string; display_name: string }[] };
export type BackendEngagementResponse = { ok: boolean; already?: boolean; event_id?: string; state: EngagementState; legal_actions: EngagementCommand[] };
export type BackendRecommendationRun = { blocked?: boolean; reason?: string; run_id?: string | null; items?: BackendRecommendation[] };
export type BackendPickTray = { snapshot_id: string | null; batch_id: string | null; cursor?: string; next_cursor: string | null; has_more: boolean; items: BackendRecommendation[] };
export type BackendFeedbackResponse = { ok: boolean; already?: boolean; feedback_id?: string; replacement?: BackendPickTray };
export type BackendOutcomeResponse = { ok: boolean; already?: boolean; outcome_id?: string | number };
export type BackendProgressResponse = { ok: boolean; already?: boolean; state?: EngagementState; active_action?: BackendCommitmentAction; incorporated_into_next_decision?: boolean; backfilled?: boolean };
export type BackendProfileUpdate = { ok: boolean; consultant_id: string; profile_keywords?: string[]; profile_note?: string };

// —— 词典（与后端 src/*.js 的枚举对齐，前端仅用于展示标签，不做业务判断）——
export const RELATION_LABELS: Record<string, string> = {
  MY_JOB: "我的职位",
  PRIMARY_PM: "我是主 PM",
  TEAM_SHARED: "团队共享",
  OTHER_CONSULTANT: "其他顾问主做",
  NOT_JOINED: "未加入",
  UNKNOWN: "UNKNOWN",
};

export const ACTIVE_STATE_LABELS: Record<string, string> = {
  OPEN: "招聘中",
  COOLING: "冷却期",
  CLOSED: "已关闭",
  COMPLETED: "已完成",
};

export const PRIORITY_LABELS: Record<string, string> = {
  HIGH: "高", NEW: "新", NORMAL: "普通", STANDBY: "待命",
};

export const BACKEND_ACTION_LABELS: Record<string, string> = {
  RECOMMEND_ACCEPT: "建议开始跟进",
  RECOMMEND_WATCH: "建议关注",
  OBSERVE: "先观察验证",
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  VIEWED: "已查看",
  RECOMMENDED: "已推荐",
  WATCHED: "已关注",
  ACCEPTED: "已开始跟进",
  DISMISSED: "暂不考虑",
  RELEASED: "已释放",
  COMPLETED: "已完成",
  EXPIRED: "已过期",
};

export const FALLBACK_DISMISS_REASONS = [
  "无资源", "不符合方向", "客户/职位质量不足", "当前没精力", "已有其他顾问推进", "信息不完整", "其他",
];

// 后端 scorer.js 固定六维权重（判断策略页只读展示；前端不得重算排序）
export const BACKEND_WEIGHTS: { dim: string; label: string; weight: string }[] = [
  { dim: "direction", label: "职位方向匹配", weight: "25%" },
  { dim: "activity", label: "项目活跃度与 Pipeline", weight: "20%" },
  { dim: "similarity", label: "与历史项目相似度", weight: "15%" },
  { dim: "capacity", label: "当前跟进容量", weight: "15%" },
  { dim: "outcomes", label: "历史行为与交付结果", weight: "15%" },
  { dim: "exploration", label: "探索额度", weight: "10%" },
];

// —— 幂等键（PRD §4.3）：同一手势复用同一 key，in-flight 期间不清除 ——
export function makeIdempotencyKey(scope: string): string {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web:${scope}:${uuid}`;
}

// —— 时间显示（后端 ISO → 本地短格式；纯展示）——
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// —— 派生规则：只做展示分组/资格标签，真正的排序与权限一律以后端为准 ——
export function directionOf(role: string): BrainxDirection {
  const r = String(role || "").toLowerCase();
  if (/投放|广告|优化师|\bsem\b|performance|paid/i.test(r)) return "paid";
  if (/市场|营销|品牌|公关|gtm|marketing|brand|cm/i.test(r)) return "marketing";
  return "growth";
}

export function eligibilityOf(action: string, relation: string, hc: number | null, activeState: string): BrainxEligibility {
  if (hc === 0 || activeState === "CLOSED" || activeState === "COMPLETED") return "EXCLUDED";
  // OTHER_CONSULTANT 不再阻塞开始跟进（顾问之间互不排斥，仅保留“他人主做”提示）
  if (relation === "NOT_JOINED" || relation === "UNKNOWN") return "VERIFY_REQUIRED";
  if (action === "OBSERVE") return "VERIFY_REQUIRED";
  return "ELIGIBLE";
}

export function groupOf(action: string, hc: number | null, activeState: string): BrainxGroup {
  if (hc === 0 || activeState === "CLOSED" || activeState === "COMPLETED") return "EXCLUDE";
  if (action === "OBSERVE") return "NEW_VALIDATION";
  if (action === "RECOMMEND_WATCH") return "MAINTENANCE";
  return "ACTIVE_ADVANCEMENT";
}

export function actionsOf(action: string, relation: string): BrainxDecisionAction[] {
  if (relation === "OTHER_CONSULTANT" || relation === "NOT_JOINED") {
    return [{ id: "ownership", label: "确认项目归属", kind: "verify", detail: "确认是否允许跟进，或先与其他顾问沟通认领" }];
  }
  if (action === "RECOMMEND_ACCEPT") {
    return [{ id: "advance", label: "进入项目推进", kind: "advance", detail: "开始跟进后按客户反馈窗口持续回写信号" }];
  }
  if (action === "RECOMMEND_WATCH") {
    return [{ id: "watch", label: "加入观察", kind: "watch", detail: "保留本周提醒，评估后再开始跟进" }];
  }
  return [{ id: "verify", label: "核验关键事实", kind: "verify", detail: "补齐 HC 与阶段事实后再判断" }];
}

export function factsOf(
  job: { relation?: string | null; active_state?: string | null; current_stage?: string | null; hc?: number | null; captured_at?: string | null; pipeline?: string | null; pipeline_snapshot?: string | null; city?: string | null; priority?: string | null; company_type?: string | null; next_action?: string | null; notes?: string | null; owner_name?: string | null },
): Record<string, string> {
  const facts: Record<string, string> = {
    "职位关系": RELATION_LABELS[job.relation || ""] || job.relation || "UNKNOWN",
    "数据来源": "职位市场",
    "职位状态": ACTIVE_STATE_LABELS[job.active_state || ""] || job.active_state || "UNKNOWN",
    "当前阶段": job.current_stage || ACTIVE_STATE_LABELS[job.active_state || ""] || job.active_state || "UNKNOWN",
    // UNKNOWN 是未知事实：后端 hc=null 时原样展示 UNKNOWN，绝不写成 0
    "剩余 HC": job.hc == null ? "UNKNOWN" : String(job.hc),
    "最近活动": job.captured_at ? String(job.captured_at).slice(0, 10) : "UNKNOWN",
    "历史 Pipeline": job.pipeline_snapshot || job.pipeline || "暂无记录",
  };
  if (job.city) facts["城市"] = job.city;
  if (job.priority) facts["优先级"] = PRIORITY_LABELS[job.priority] || job.priority;
  if (job.company_type) facts["客户类型"] = job.company_type;
  if (job.next_action) facts["下一步动作"] = job.next_action;
  if (job.notes) facts["备注"] = job.notes;
  if (job.owner_name) facts["主做顾问"] = job.owner_name;
  return facts;
}

function factFieldsOf(job: {
  active_state?: string | null; current_stage?: string | null; pipeline?: string | null;
  pipeline_snapshot?: string | null; hc?: number | null; next_action?: string | null;
  notes?: string | null; fact_sources?: Partial<Record<ManualFactField, string>>;
  fact_updated_at?: Partial<Record<ManualFactField, string | null>>;
}): BrainxFactFields {
  const valueOf: Record<ManualFactField, string | number | null> = {
    active_state: job.active_state || null,
    current_stage: job.current_stage || null,
    pipeline_snapshot: job.pipeline_snapshot ?? job.pipeline ?? null,
    remaining_hc: job.hc ?? null,
    next_action: job.next_action || null,
    notes: job.notes || null,
  };
  return Object.fromEntries(Object.entries(valueOf).map(([field, value]) => [field, {
    value,
    effective_value: value,
    source: (job.fact_sources?.[field as ManualFactField] || (value == null ? "UNKNOWN" : "SYNC")) as BrainxFactField["source"],
    updated_at: job.fact_updated_at?.[field as ManualFactField] || null,
  }])) as BrainxFactFields;
}

function breakdownDim(
  breakdown: BackendBreakdown[] | undefined | null,
  dim: string,
): number | string {
  const found = breakdown?.find((b) => b.dim === dim);
  if (!found || found.score == null) return "—";
  return found.score;
}

/** 后端推荐项（/recommendations 或 /workbench.today_top3 的元素）→ 前端 DecisionJob。 */
export function mapRecommendation(rec: BackendRecommendation): BrainxJob {
  const job = rec.job;
  const relation = job.relation || "UNKNOWN";
  const coveragePct = Math.round((rec.evidence_coverage ?? 0) * 100);
  return {
    id: job.project_id,
    rank: rec.rank,
    company: job.company || "未知客户",
    role: job.role || "未知职位",
    direction: directionOf(job.role || ""),
    sourceMode: rec.source_mode === "COCKPIT_CONTEXT" ? "COCKPIT_CONTEXT" : "MARKET_ONLY", // 后端逐 item 透出（缺省按职位市场，与隔离判定一致：无 cockpit_facts 行即市场）
    group: groupOf(rec.action, job.hc ?? null, job.active_state || ""),
    eligibility: eligibilityOf(rec.action, relation, job.hc ?? null, job.active_state || ""),
    globalScore: breakdownDim(rec.breakdown, "activity"),
    explorationScore: breakdownDim(rec.breakdown, "exploration"),
    personalScore: breakdownDim(rec.breakdown, "direction"),
    finalScore: rec.score,
    evidenceCoverage: coveragePct,
    recommendation: rec.reasons[0] || rec.risks[0] || BACKEND_ACTION_LABELS[rec.action] || rec.action,
    recentSignal: `${BACKEND_ACTION_LABELS[rec.action] || rec.action} · 证据覆盖 ${coveragePct}%`,
    facts: factsOf(job),
    factFields: factFieldsOf(job),
    scoreNotes: rec.reasons || [],
    risks: rec.risks || [],
    evidence: (rec.evidence_refs || []).map((e) => e.excerpt || e.ref || e.type || "快照记录"),
    actions: actionsOf(rec.action, relation),
  };
}

/** 后端 workbench.sync → 前端 SyncStatus。RUNNING 是本地瞬时态；AUTH_EXPIRED 由飞书授权推导。 */
export function mapSyncStatus(
  sync: { state: string; updated_at?: string | null; rows_read?: number | null; rows_expected?: number | null; errors?: string[]; warning?: { at: string; message: string; detail?: string } | null } | null | undefined,
  feishuAuth?: { needs_reauth?: boolean } | null,
): SyncStatus {
  if (feishuAuth?.needs_reauth) return { state: "AUTH_EXPIRED", updatedAt: null, errors: [] };
  const s = sync || { state: "EMPTY" };
  const state = s.state === "READY" ? "READY" : s.state === "INCOMPLETE" ? "INCOMPLETE" : "EMPTY";
  return {
    state,
    updatedAt: s.updated_at ? formatClock(s.updated_at) : null,
    rowsRead: s.rows_read ?? undefined,
    rowsExpected: s.rows_expected ?? undefined,
    errors: s.errors || [], warning: s.warning ? { at: s.warning.at, message: s.warning.message, detail: s.warning.detail } : null, // 降级信号（2026-08-25）
  };
}

export function mapEvents(
  events: { event_type: string; occurred_at?: string; actor?: string; reason?: string | null }[] | null | undefined,
): DecisionEvent[] {
  return (events || []).map((e) => ({
    id: `${e.event_type}:${e.occurred_at || ""}`,
    type: EVENT_TYPE_LABELS[e.event_type] || e.event_type,
    at: formatClock(e.occurred_at),
    reason: e.reason || undefined,
  }));
}

export function mapOutcomes(
  outcomes: { stage: string; observed_at?: string; value?: { rating?: number; note?: string } | null }[] | null | undefined,
): Outcome[] {
  return (outcomes || []).map((o) => ({
    id: `out:${o.stage}:${o.observed_at || ""}`,
    stage: o.stage as Outcome["stage"],
    rating: o.value?.rating,
    note: o.value?.note,
    at: formatClock(o.observed_at),
  }));
}

export function buildNotifications(
  wb: {
    sync?: { state?: string; updated_at?: string | null } | null;
    need_action_count?: number;
    today_top3?: { job?: { project_id?: string; company?: string } }[];
  },
  recs: { items?: { job?: { project_id?: string; company?: string } }[] },
): Notification[] {
  const notes: Notification[] = [];
  const syncState = wb.sync?.state;
  if (syncState === "READY") {
    notes.push({ id: "brainx-sync-ok", kind: "SYNC_ALERT", title: "同步状态正常", detail: "当前完整快照已进入本轮职位判断", read: false });
  } else if (syncState === "INCOMPLETE") {
    notes.push({ id: "brainx-sync-incomplete", kind: "SYNC_ALERT", title: "本次同步不完整", detail: "为避免误导，暂不生成正式推荐", read: false });
  }
  const top3 = (wb.today_top3 || recs.items || []).slice(0, 3);
  if (top3.length) {
    const names = top3.map((t) => t.job?.company).filter(Boolean).join("、");
    notes.push({
      id: "brainx-daily-top3", kind: "DAILY_TOP3", title: "今日 Top 3 已生成",
      detail: `${names || "今日推荐"} 等待判断`, jobId: top3[0].job?.project_id, read: false,
    });
  }
  if (wb.need_action_count && wb.need_action_count > 0) {
    notes.push({ id: "brainx-commit", kind: "COMMITMENT", title: `${wb.need_action_count} 个项目需要处理`, detail: "关注超过 7 天未推进，或开始跟进后未回写结果", read: false });
  }
  return notes;
}

/** 后端 /decisions/:id/replay 响应 → 前端回放面板数据。 */
export function mapReplayData(r: BackendReplay): BrainxReplay {
  return {
    decisionId: r.decision_id,
    snapshotAt: formatClock(r.recommendation.created_at),
    policyVersion: r.recommendation.policy_version || "—",
    rank: r.recommendation.rank ?? 0,
    reasons: r.recommendation.reasons || [],
    risks: r.recommendation.risks || [],
    evidence: (r.recommendation.evidence_refs || []).map((e) => e.excerpt || e.ref || e.type || "快照记录"),
    events: mapEvents(r.events),
    outcomes: mapOutcomes(r.outcomes),
  };
}

export async function getPickTray(cursor?: string): Promise<BackendPickTray> {
  const query = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : "?limit=20";
  return brainxFetch<BackendPickTray>(`/api/v1/recommendations/pick-tray${query}`);
}

export async function nextRecommendationBatch(batchId: string, cursor: string, idempotencyKey: string): Promise<BackendPickTray> {
  return brainxFetch<BackendPickTray>("/api/v1/recommendations/next-batch", {
    method: "POST", body: { batch_id: batchId, cursor, size: 20, idempotency_key: idempotencyKey },
  });
}

export async function sendRecommendationFeedback(projectId: string, reason: string, batchId: string | null, idempotencyKey: string): Promise<BackendFeedbackResponse> {
  return brainxFetch<BackendFeedbackResponse>("/api/v1/recommendations/feedback", {
    method: "POST", body: { project_id: projectId, feedback: "NOT_INTERESTED", reason, batch_id: batchId, idempotency_key: idempotencyKey },
  });
}

// 撤销"不感兴趣"反馈（小红书/B站式 toast 撤销按钮的后端对应）
export async function undoRecommendationFeedback(projectId: string): Promise<{ ok: boolean; removed?: boolean }> {
  return brainxFetch<{ ok: boolean; removed?: boolean }>("/api/v1/recommendations/feedback/undo", {
    method: "POST", body: { project_id: projectId },
  });
}

export async function updateWorkbenchPreferences(preferences: Pick<WorkbenchPreferences, "tray" | "folders" | "folderMode">): Promise<{ ok: boolean } & WorkbenchPreferences> {
  return brainxFetch<{ ok: boolean } & WorkbenchPreferences>("/api/v1/workbench/preferences", {
    method: "PUT", body: preferences,
  });
}

export type ManualFactUpdate = {
  changes?: Partial<Record<ManualFactField, string | number>>;
  clear_fields?: ManualFactField[];
  idempotency_key: string;
};

export async function updateOpportunityFacts(id: string, update: ManualFactUpdate): Promise<{
  ok: boolean; already?: boolean; event_id?: string; decision_run_id?: string | null;
  recompute?: { blocked?: boolean; reason?: string };
  recommendation?: { decision_id?: string; score?: number; action?: string } | null;
}> {
  return brainxFetch(`/api/v1/opportunities/${encodeURIComponent(id)}/facts`, { method: "PATCH", body: update });
}

// —— 人才供给（旁路，只读展示；后端 GET /opportunities/:id/talent-supply）——
export type TalentSupplySnapshot = {
  jobId: string;
  enabled: boolean;
  algo?: string;
  matchableTalentCount?: number;
  supplyDifficulty?: "low" | "medium" | "high";
  matchingSuggestion?: string;
  reactivatableTalentCount?: number;
  topMatches?: { talentId: number; name: string; score: number; matched?: string[] }[];
  source?: string;
};

/** 拉取某职位的真实人才供给（真库匹配结果）。未开启开关时返回 enabled:false。 */
export async function getTalentSupply(jobId: string): Promise<TalentSupplySnapshot> {
  return brainxFetch<TalentSupplySnapshot>(`/api/v1/opportunities/${encodeURIComponent(jobId)}/talent-supply`);
}

/** 读取完整工作台快照：概览 + 推荐 + 逐职位详情（承接态/允许动作/事件/结果）+ 画像。
 *  会话未登录（401）时抛错，由调用方进入离线回退。 */
export async function getSnapshot(): Promise<BrainxSnapshot> {
  const [wb, recs, projects, profile, dismiss, preferences] = await Promise.all([
    brainxFetch<BackendWorkbench>("/api/v1/workbench"),
    brainxFetch<BackendRecommendations>("/api/v1/recommendations?limit=20"),
    getProjects(),
    brainxFetch<BackendProfile>("/api/v1/profile"),
    brainxFetch<BackendDismissReasons>("/api/v1/dismiss-reasons").catch(() => ({ items: FALLBACK_DISMISS_REASONS })),
    brainxFetch<WorkbenchPreferences>("/api/v1/workbench/preferences").catch(() => ({ tray: [], folders: [], folderMode: false, updatedAt: null })),
  ]);

  const jobs = (recs.items || []).map(mapRecommendation) as BrainxJob[];
  const engagement: Record<string, EngagementState> = {};
  const events: Record<string, DecisionEvent[]> = {};
  const outcomes: Record<string, Outcome[]> = {};
  const legal: Record<string, EngagementCommand[]> = {};
  const openmai: Record<string, OpenmaiResult | null> = {};

  const details = await Promise.all(
    jobs.map((j) => brainxFetch<BackendOpportunity>(`/api/v1/opportunities/${encodeURIComponent(j.id)}`).catch(() => null)),
  );
  jobs.forEach((job, i) => {
    const d = details[i];
    const decisionId = d?.latest_recommendation?.decision_id || recs.items[i]?.decision_id;
    job.brainxDecisionId = decisionId;
    if (!d) return;
    openmai[job.id] = d.openmai ?? null;
    engagement[job.id] = d.engagement_state as EngagementState;
    events[job.id] = mapEvents(d.events);
    outcomes[job.id] = mapOutcomes(d.outcomes);
    legal[job.id] = (d.legal_actions || []).filter((a: string) => a !== "VIEW") as EngagementCommand[];
    job.brainxLegal = legal[job.id];
  });

  for (const project of projects.items || []) {
    engagement[project.project_id] = project.engagement_state;
    legal[project.project_id] = project.legal_actions;
  }
  return {
    consultantId: profile.consultant_id || wb.consultant_id,
    jobs,
    engagement,
    events,
    outcomes,
    legal,
    openmai,
    sync: mapSyncStatus(wb.sync, wb.feishu_auth),
    auth: {
      consultant: profile.display_name || wb.consultant_id || "顾问",
      authorized: !!profile.feishu_auth?.authorized,
      needsReauth: !!profile.feishu_auth?.needs_reauth,
    },
    notifications: buildNotifications(wb, recs),
    dismissReasons: dismiss.items || FALLBACK_DISMISS_REASONS,
    runId: wb.run_id || null,
    snapshotId: recs.snapshot_id || null,
    policyVersion: recs.policy_version || wb.current_policy_version || null,
    profileKeywords: profile.profile_keywords || [],
    preferences,
    projects: projects.items || [],
  };
}

/** 开始跟进后自动找人结果（/api/v1/opportunities/:id 响应内嵌 openmai 字段）。 */
export type OpenmaiResult = {
  status: "none" | "running" | "done" | "failed";
  result_text?: string | null;
  error?: string | null;
  task_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
};

/** 重新找人（显式触发，running 中后端会 409）。 */
export async function rerunOpenmai(jobId: string): Promise<{ ok: boolean }> {
  return brainxFetch(`/api/v1/opportunities/${encodeURIComponent(jobId)}/openmai/rerun`, { method: "POST" });
}

/** 重取单个职位详情（承接动作/结果回写成功后刷新本地视图）。 */
export async function fetchJobDetail(id: string): Promise<{
  engagementState: EngagementState;
  legal: EngagementCommand[];
  events: DecisionEvent[];
  outcomes: Outcome[];
  decisionId: string | null;
  openmai: OpenmaiResult | null;
  commitment: CommitmentSnapshot;
}> {
  const d = await brainxFetch<BackendOpportunity>(`/api/v1/opportunities/${encodeURIComponent(id)}`);
  return {
    engagementState: d.engagement_state as EngagementState,
    legal: (d.legal_actions || []).filter((a: string) => a !== "VIEW") as EngagementCommand[],
    events: mapEvents(d.events),
    outcomes: mapOutcomes(d.outcomes),
    decisionId: d.latest_recommendation?.decision_id || null,
    openmai: (d as { openmai?: OpenmaiResult | null }).openmai ?? null,
    commitment: {
      goal: d.commitment_goal || null,
      activeAction: d.active_action ? mapCommitmentAction(d.active_action) : null,
      actionHistory: (d.action_history || []).map(mapCommitmentAction),
      suggestedAction: d.suggested_action ? {
        title: d.suggested_action.title, dueAt: d.suggested_action.due_at,
        source: d.suggested_action.source, rule: d.suggested_action.rule,
      } : null,
      terminalResultMissing: !!d.terminal_result_missing,
    },
  };
}

function mapCommitmentAction(action: BackendCommitmentAction): CommitmentAction {
  return { actionId: action.action_id, title: action.title, dueAt: action.due_at,
    status: action.status, source: action.source, createdAt: action.created_at,
    completedAt: action.completed_at, completionNote: action.completion_note };
}

/** SSE 订阅（/api/v1/events）；返回带 close 的句柄。 */
export function connectSSE(onEvent: (event: BackendSseEvent) => void): { close: () => void } {
  if (typeof window === "undefined" || !("EventSource" in window)) return { close: () => {} };
  const es = new EventSource("/api/v1/events");
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* 心跳/非 JSON 帧忽略 */ }
  };
  return { close: () => es.close() };
}

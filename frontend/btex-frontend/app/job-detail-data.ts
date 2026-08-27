import type { BackendOpportunity, BackendRadarRow } from "./brainx-api";
import type { DecisionEvent } from "./decision-demo";
import type { JobDetailRecommendation, JobDetailReviewData } from "./job-detail-card-review";
import type { DecisionJob } from "./workbench-model";

const relationLabels: Record<string, string> = {
  MY_JOB: "我的职位",
  PRIMARY_PM: "我是主 PM",
  TEAM_SHARED: "团队共享",
  OTHER_CONSULTANT: "其他顾问主做",
  NOT_JOINED: "未加入",
};

const eventLabels: Record<string, string> = {
  VIEWED: "已查看",
  RECOMMENDED: "已推荐",
  WATCHED: "已关注",
  ACCEPTED: "已接单",
  DISMISSED: "暂不考虑",
  RELEASED: "已释放",
  COMPLETED: "已完成",
  EXPIRED: "已过期",
  FACT_UPDATED: "职位事实已更新",
};

function jobStatus(value?: string | null): JobDetailReviewData["activeState"] {
  if (value === "OPEN" || value === "招聘中") return "OPEN";
  if (value === "COOLING" || value === "冷却期") return "COOLING";
  if (["CLOSED", "COMPLETED", "已关闭", "已完成"].includes(value || "")) return "CLOSED";
  return "UNKNOWN";
}

function citiesOf(value?: string | null) {
  return String(value || "").split(/[、,，]/).map(item => item.trim()).filter(Boolean);
}

function numberOf(value?: string | number | null) {
  if (value === null || value === undefined || value === "" || value === "UNKNOWN") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recommendationOf(detail: BackendOpportunity): JobDetailRecommendation | null {
  const recommendation = detail.latest_recommendation;
  if (!recommendation?.reasons?.length) return null;
  return {
    action: recommendation.action === "RECOMMEND_ACCEPT" ? "FOLLOW"
      : recommendation.action === "RECOMMEND_WATCH" ? "WATCH" : "HOLD",
    reasons: recommendation.reasons,
    risks: recommendation.risks || [],
    generatedAt: recommendation.created_at || null,
    policyVersion: recommendation.policy_version || null,
  };
}

export function toRadarJobDetail(row: BackendRadarRow): JobDetailReviewData {
  return {
    projectId: row.project_id,
    role: row.role || "职位待确认",
    company: row.company || "公司待确认",
    cities: row.cities || citiesOf(row.city),
    activeState: jobStatus(row.active_state),
    hc: row.hc ?? null,
    pipeline: row.pipeline_steps || null,
    ownerName: row.owner_name || null,
    capturedAt: row.captured_at || null,
    relation: relationLabels[row.relation || ""] || null,
    companyType: row.company_type || null,
    priority: row.priority || null,
    currentStage: row.cockpit?.current_stage || null,
    nextAction: row.cockpit?.next_action || null,
    notes: row.notes || null,
    sourceUrl: row.cockpit?.source_url || row.source_url || null,
    engagementState: row.engagement_state || null,
    inMyProjects: row.relation === "MY_JOB" || row.relation === "PRIMARY_PM",
  };
}

export function mergeOpportunityDetail(base: JobDetailReviewData, detail: BackendOpportunity): JobDetailReviewData {
  const job = detail.job;
  return {
    ...base,
    role: job.role || base.role,
    company: job.company || base.company,
    cities: job.cities?.length ? job.cities : citiesOf(job.city).length ? citiesOf(job.city) : base.cities,
    activeState: jobStatus(job.active_state),
    hc: job.hc ?? base.hc,
    pipeline: job.pipeline_steps || base.pipeline,
    ownerName: job.owner_name || base.ownerName,
    capturedAt: job.captured_at || base.capturedAt,
    relation: relationLabels[detail.relation?.relation || job.relation || ""] || base.relation,
    companyType: job.company_type || base.companyType,
    priority: job.priority || base.priority,
    currentStage: job.current_stage || base.currentStage,
    nextAction: job.next_action || base.nextAction,
    notes: job.notes || base.notes,
    sourceUrl: job.source_url || base.sourceUrl,
    engagementState: detail.engagement_state,
    recommendation: recommendationOf(detail),
    events: (detail.events || []).slice().reverse().map((event, index) => ({
      id: `${event.event_type}:${event.occurred_at || index}`,
      label: eventLabels[event.event_type] || event.event_type,
      at: event.occurred_at || null,
      detail: event.reason || null,
    })),
    inMyProjects: ["MY_JOB", "PRIMARY_PM"].includes(detail.relation?.relation || job.relation || ""),
  };
}

export function toDecisionJobDetail(job: DecisionJob, events: DecisionEvent[]): JobDetailReviewData {
  const facts = job.facts || {};
  const relation = facts["职位关系"] || null;
  return {
    projectId: job.id,
    role: job.role,
    company: job.company,
    cities: citiesOf(facts["城市"]),
    activeState: jobStatus(facts["职位状态"] || facts["当前状态"]),
    hc: numberOf(facts["剩余 HC"]),
    pipeline: null,
    ownerName: facts["主做顾问"] || null,
    capturedAt: job.factFields?.active_state?.updated_at || null,
    relation,
    companyType: facts["客户类型"] || null,
    priority: facts["优先级"] || null,
    currentStage: facts["当前阶段"] || null,
    nextAction: facts["下一步动作"] || null,
    notes: facts["备注"] || null,
    engagementState: null,
    recommendation: job.scoreNotes.length ? {
      action: job.actions.some(action => action.kind === "advance") ? "FOLLOW"
        : job.actions.some(action => action.kind === "watch") ? "WATCH" : "HOLD",
      reasons: job.scoreNotes,
      risks: job.risks,
      generatedAt: null,
      policyVersion: null,
    } : null,
    events: events.map(event => ({ id: event.id, label: event.type, at: event.at, detail: event.reason || null })),
    inMyProjects: relation === "我的职位" || relation === "我是主 PM",
  };
}

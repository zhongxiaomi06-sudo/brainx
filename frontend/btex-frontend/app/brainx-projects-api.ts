import type { EngagementCommand, EngagementState } from "./decision-demo";
import { brainxFetch } from "./brainx-http.ts";
import type { DecisionDirection, DecisionGroup, DecisionJob } from "./workbench-model";

export type ProjectStatus = "PENDING_START" | "IN_PROGRESS" | "NEEDS_ACTION" | "COMPLETED" | "RELEASED";

export type ProjectActionSummary = {
  action_id: string;
  title: string;
  goal: string | null;
  due_at: string;
  status: "OPEN" | "BLOCKED";
  source: "RULE" | "MANUAL";
  updated_at: string;
};

export type ProjectSummary = {
  project_id: string;
  relation: "MY_JOB" | "TEAM_SHARED";
  membership_source: string;
  joined_at: string;
  company: string;
  role: string;
  city: string | null;
  active_state: string | null;
  hc: number | null;
  pipeline: string | null;
  current_stage: string | null;
  pipeline_snapshot: string | null;
  next_action: string | null;
  owner_name: string | null;
  captured_at: string | null;
  engagement_state: EngagementState;
  state_since: string | null;
  project_status: ProjectStatus;
  active_action: ProjectActionSummary | null;
  legal_actions: EngagementCommand[];
};

export type ProjectsResponse = { items: ProjectSummary[]; total_count: number };
export type MembershipResponse = {
  ok: boolean;
  already?: boolean;
  relation: "MY_JOB" | "TEAM_SHARED";
  legal_actions: EngagementCommand[];
  project: ProjectSummary | null;
  recompute?: { blocked?: boolean; deferred?: boolean; reason?: string };
};

export function getProjects(): Promise<ProjectsResponse> {
  return brainxFetch<ProjectsResponse>("/api/v1/projects");
}

export function updateOpportunityMembership(
  id: string,
  relation: "MY_JOB" | "TEAM_SHARED",
  idempotencyKey: string,
): Promise<MembershipResponse> {
  return brainxFetch(`/api/v1/opportunities/${encodeURIComponent(id)}/membership`, {
    method: "PATCH",
    body: { relation, idempotency_key: idempotencyKey },
  });
}

function directionOf(role: string): DecisionDirection {
  if (/投放|广告|优化师|sem|performance|paid/i.test(role)) return "paid";
  if (/市场|营销|品牌|公关|gtm|marketing|brand/i.test(role)) return "marketing";
  return "growth";
}

function groupOf(project: ProjectSummary): DecisionGroup {
  if (project.project_status === "COMPLETED") return "RESULT_CLOSURE";
  if (project.project_status === "IN_PROGRESS" || project.project_status === "NEEDS_ACTION") return "ACTIVE_ADVANCEMENT";
  return "MAINTENANCE";
}

export function projectToDecisionJob(project: ProjectSummary): DecisionJob {
  const facts: Record<string, string> = {
    "职位关系": project.relation === "MY_JOB" ? "我的职位" : "团队共享",
    "数据来源": "职位市场",
    "职位状态": project.active_state || "UNKNOWN",
    "当前阶段": project.current_stage || project.active_state || "UNKNOWN",
    "剩余 HC": project.hc == null ? "UNKNOWN" : String(project.hc),
    "最近活动": project.captured_at?.slice(0, 10) || "UNKNOWN",
    "历史 Pipeline": project.pipeline_snapshot || project.pipeline || "暂无记录",
  };
  if (project.city) facts["城市"] = project.city;
  if (project.owner_name) facts["主做顾问"] = project.owner_name;
  if (project.next_action) facts["下一步动作"] = project.next_action;
  return {
    id: project.project_id,
    rank: 0,
    company: project.company,
    role: project.role,
    direction: directionOf(project.role),
    sourceMode: "MARKET_ONLY",
    group: groupOf(project),
    eligibility: "ELIGIBLE",
    globalScore: "—",
    explorationScore: "—",
    personalScore: "—",
    finalScore: "—",
    evidenceCoverage: null,
    recommendation: project.active_action?.title || project.next_action || "建立第一条跟进行动",
    recentSignal: project.active_action?.title || project.current_stage || "待开始跟进",
    facts,
    scoreNotes: [],
    risks: [],
    evidence: [`项目归属 · ${project.membership_source}`],
    actions: [],
    brainxLegal: project.legal_actions,
  };
}

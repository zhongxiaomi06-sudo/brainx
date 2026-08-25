import type React from "react";
import { BriefcaseBusiness, ClipboardCheck, Database, Settings2, Sparkles, Users } from "lucide-react";
import type { ManualFactField } from "./brainx-api";
import type { AuthStatus, DecisionEvent, EngagementCommand, EngagementState, Notification, Outcome, SyncStatus } from "./decision-demo";
export { cockpitRadarJobs, demoRadarJobs, jobs } from "./workbench-radar-data";

export type Page = "today" | "jobs" | "clients" | "alerts" | "rules" | "sources" | "accepted";
export type Status = "待同步" | "新发布" | "升温" | "活跃" | "拥挤" | "降温" | "疑似失活" | "已关闭";
export type PositionType = "技术" | "产品" | "运营" | "算法" | "设计" | "商业化";
export type JobSource = "市场信号" | "驾驶舱导入";
export type Job = {
  id: number | string;
  name: string;
  client: string;
  industry: string;
  city: string;
  pm: string;
  status: Status;
  score: number | null;
  hc: number | null;
  feedback: string;
  recommended: number | null;
  interview: number | null;
  offer: number | null;
  reason: string;
  salary: string;
  source: JobSource;
  positionType: PositionType;
  sourceColumn?: string;
};
export type DecisionGroup = "RESULT_CLOSURE" | "ACTIVE_ADVANCEMENT" | "NEW_VALIDATION" | "MAINTENANCE" | "EXCLUDE";
export type Eligibility = "ELIGIBLE" | "VERIFY_REQUIRED" | "BLOCKED" | "EXCLUDED";
export type DecisionDirection = "paid" | "growth" | "marketing";
export type SourceMode = "COCKPIT_CONTEXT" | "MARKET_ONLY";
export type DecisionAction = { id: string; label: string; kind: "verify" | "advance" | "watch" | "skip"; detail: string };
export type DecisionFact = { value: string | number | null; effective_value: string | number | null; source: "SYNC" | "MANUAL" | "UNKNOWN" | "LOCAL"; updated_at: string | null };
export type DecisionJob = {
  id: string;
  rank: number;
  company: string;
  role: string;
  direction: DecisionDirection;
  sourceMode: SourceMode;
  group: DecisionGroup;
  eligibility: Eligibility;
  globalScore: number | string;
  explorationScore: number | string;
  personalScore: number | string;
  finalScore: number | string;
  evidenceCoverage: number | null;
  recommendation: string;
  recentSignal: string;
  facts: Record<string, string>;
  scoreNotes: string[];
  factFields?: Partial<Record<ManualFactField, DecisionFact>>;
  risks: string[];
  evidence: string[];
  actions: DecisionAction[];
  brainxLegal?: EngagementCommand[];
  brainxDecisionId?: string;
};
export type Panel = { kind: "job"; jobId: string; tab: "judgement" | "engagement" | "trail" | "replay" } | { kind: "sync" } | { kind: "identity" } | { kind: "notifications" } | { kind: "commitments" } | null;
export type DirectSegmentOption<T extends string> = { value: T; label: React.ReactNode; ariaLabel?: string };

export const decisionGroupMeta: Record<DecisionGroup, { title: string; subtitle: string }> = {
  RESULT_CLOSURE: { title: "结果收口", subtitle: "别丢单，先把当前结果确认下来" },
  ACTIVE_ADVANCEMENT: { title: "高动能推进", subtitle: "现在有真实动能，优先顺势推进" },
  NEW_VALIDATION: { title: "新机会验证", subtitle: "值得看，但先验证关键事实" },
  MAINTENANCE: { title: "维护观察", subtitle: "项目仍有效，暂不抢占今天注意力" },
  EXCLUDE: { title: "暂不推荐", subtitle: "硬条件不符合，不进入正式推荐" },
};
export type DecisionSeed = {
  id: string;
  direction: DecisionDirection;
  rank: number;
  company: string;
  role: string;
  relation: string;
  sourceMode: SourceMode;
  stage: string;
  remainingHc: number;
  pipeline: string;
  process: number;
  exploration: number;
  personal: number;
  final: number;
  group: DecisionGroup;
  reasons: string[];
  risks: string[];
  nextAction: string;
  evidence: string[];
};
export const decisionSeeds: DecisionSeed[] = [
  {
    id: "JU87P01",
    direction: "paid",
    rank: 1,
    company: "39-AI",
    role: "资深海外投放经理",
    relation: "我的职位",
    sourceMode: "COCKPIT_CONTEXT",
    stage: "INTERVIEW",
    remainingHc: 1,
    pipeline: "推荐 22 · 面试 2 · 寻访 1",
    process: 82,
    exploration: 76,
    personal: 81,
    final: 80,
    group: "ACTIVE_ADVANCEMENT",
    reasons: ["已进入面试阶段，项目具有真实推进动能。", "驾驶舱已有 20 名推荐样本和 2 名面试样本。", "HC 1，当前入职 0，剩余 HC 1。"],
    risks: ["客户最新反馈和下一轮推荐动作仍需回写。"],
    nextAction: "按驾驶舱下一动作推进，并在 72 小时内回写信号",
    evidence: ["驾驶舱项目快照", "Pipeline 阶段记录", "HC 占用判断"],
  },
  {
    id: "J3NBVPJ",
    direction: "paid",
    rank: 2,
    company: "上海蝴蝶梦境科技有限公司",
    role: "资深广告优化师",
    relation: "未加入",
    sourceMode: "MARKET_ONLY",
    stage: "INTERVIEW",
    remainingHc: 1,
    pipeline: "推荐 3 · 面试 3",
    process: 78,
    exploration: 95,
    personal: 64,
    final: 80,
    group: "NEW_VALIDATION",
    reasons: ["市场职位处于面试阶段，且仍有明确 HC。", "探索价值高，但尚未匹配到驾驶舱 project_id。"],
    risks: ["项目负责人和当前 HC 需要在承接前再次确认。"],
    nextAction: "确认负责人和 HC，再做 72 小时低成本验证",
    evidence: ["职位市场快照", "市场 Pipeline", "HC 字段"],
  },
  {
    id: "JPG4HAS",
    direction: "paid",
    rank: 3,
    company: "Aha.AI",
    role: "B2B 投放专员",
    relation: "我的职位",
    sourceMode: "MARKET_ONLY",
    stage: "INTERVIEW",
    remainingHc: 1,
    pipeline: "推荐 2 · 面试 1",
    process: 75,
    exploration: 95,
    personal: 71,
    final: 79,
    group: "ACTIVE_ADVANCEMENT",
    reasons: ["职位市场显示已有面试推进，方向匹配度高。", "当前快照未找到可确认的驾驶舱 project_id。"],
    risks: ["不能把公司名相似当作驾驶舱关联证据。"],
    nextAction: "核验项目归属和 HC，再决定投入寻访",
    evidence: ["职位市场快照", "市场 Pipeline", "顾问关系"],
  },
  {
    id: "JNDLIXO",
    direction: "growth",
    rank: 1,
    company: "北京雨林时代科技有限公司",
    role: "海外增长负责人",
    relation: "我的职位",
    sourceMode: "MARKET_ONLY",
    stage: "INTERVIEW",
    remainingHc: 2,
    pipeline: "推荐 3 · 面试 10",
    process: 85,
    exploration: 95,
    personal: 71,
    final: 85,
    group: "ACTIVE_ADVANCEMENT",
    reasons: ["10 名面试样本证明需求处于真实推进阶段。", "总 HC 2，当前仍有 2 个机会空间。"],
    risks: ["未匹配驾驶舱上下文，需确认竞争与项目负责人。"],
    nextAction: "确认负责人和 HC，再做 72 小时低成本验证",
    evidence: ["职位市场快照", "市场 Pipeline", "HC 字段"],
  },
  {
    id: "JPZ5RC5",
    direction: "growth",
    rank: 2,
    company: "CurioSea",
    role: "GTM Leader / 全球增长负责人",
    relation: "未加入",
    sourceMode: "MARKET_ONLY",
    stage: "INTERVIEW",
    remainingHc: 1,
    pipeline: "推荐 10 · 面试 14 · 寻访 1",
    process: 83,
    exploration: 95,
    personal: 64,
    final: 83,
    group: "NEW_VALIDATION",
    reasons: ["市场 Pipeline 活跃，面试与推荐样本充分。", "方向吻合，但顾问尚未加入项目。"],
    risks: ["未加入项目，不能直接出现接单动作。"],
    nextAction: "确认项目归属与可承接状态，再决定是否加入",
    evidence: ["职位市场快照", "市场 Pipeline", "项目关系字段"],
  },
  {
    id: "JVS2PHH",
    direction: "growth",
    rank: 3,
    company: "科漫智能",
    role: "海外增长运营负责人 / 经理",
    relation: "我的职位",
    sourceMode: "COCKPIT_CONTEXT",
    stage: "INTERVIEW",
    remainingHc: 1,
    pipeline: "推荐 28 · 面试 7 · 寻访 3",
    process: 85,
    exploration: 75,
    personal: 81,
    final: 82,
    group: "ACTIVE_ADVANCEMENT",
    reasons: ["驾驶舱已记录岗位拆解、30 人联系池和首轮验证。", "项目处于面试阶段，HC 仍开放。"],
    risks: ["客户优先级、联系回复和硬条件尚需进一步确认。"],
    nextAction: "按驾驶舱下一动作推进，并在 72 小时内回写信号",
    evidence: ["驾驶舱项目快照", "岗位拆解记录", "Pipeline 阶段记录"],
  },
  {
    id: "J90P3H0",
    direction: "marketing",
    rank: 1,
    company: "中科酷原",
    role: "市场总监 / 经理",
    relation: "未加入",
    sourceMode: "MARKET_ONLY",
    stage: "INTERVIEW",
    remainingHc: 5,
    pipeline: "推荐 1 · 面试 9",
    process: 87,
    exploration: 95,
    personal: 64,
    final: 86,
    group: "NEW_VALIDATION",
    reasons: ["存在 5 个剩余 HC，机会空间明确。", "已有 9 名面试样本，项目需求处于活跃状态。"],
    risks: ["尚未加入项目，需确认项目负责人和承接规则。"],
    nextAction: "确认负责人和 HC，再做 72 小时低成本验证",
    evidence: ["职位市场快照", "市场 Pipeline", "HC 字段"],
  },
  {
    id: "JBWXJ7W",
    direction: "marketing",
    rank: 2,
    company: "深势科技",
    role: "Marketing Head（科研产品）",
    relation: "未加入",
    sourceMode: "MARKET_ONLY",
    stage: "INTERVIEW",
    remainingHc: 1,
    pipeline: "推荐 3 · 面试 3",
    process: 78,
    exploration: 95,
    personal: 64,
    final: 80,
    group: "NEW_VALIDATION",
    reasons: ["方向吻合，市场 Pipeline 已有真实推进。", "剩余 HC 1，仍有机会空间。"],
    risks: ["项目未加入，驾驶舱上下文不可用。"],
    nextAction: "确认项目归属、客户优先级和当前 HC",
    evidence: ["职位市场快照", "市场 Pipeline", "HC 字段"],
  },
  {
    id: "JU2GCAC",
    direction: "marketing",
    rank: 3,
    company: "天瞳威视",
    role: "市场与媒体公关总监",
    relation: "未加入",
    sourceMode: "MARKET_ONLY",
    stage: "INTERVIEW",
    remainingHc: 1,
    pipeline: "推荐 12 · 面试 9 · 寻访 7",
    process: 84,
    exploration: 76,
    personal: 64,
    final: 79,
    group: "ACTIVE_ADVANCEMENT",
    reasons: ["项目 Pipeline 充分，已有推荐和面试推进。", "HC 1，当前仍有可验证机会。"],
    risks: ["市场竞争可能偏高，且缺少驾驶舱项目上下文。"],
    nextAction: "核验竞争强度和项目归属后，再决定投入级别",
    evidence: ["职位市场快照", "市场 Pipeline", "HC 字段"],
  },
  {
    id: "JX3S2YU",
    direction: "paid",
    rank: 4,
    company: "云帆智能",
    role: "海外解决方案销售",
    relation: "未加入",
    sourceMode: "MARKET_ONLY",
    stage: "SCREENING",
    remainingHc: 2,
    pipeline: "推荐 6 · 面试 1",
    process: 69,
    exploration: 72,
    personal: 64,
    final: 70,
    group: "MAINTENANCE",
    reasons: ["职位仍保留 2 个 HC，但近期反馈不足。", "需要先确认需求是否仍然有效。"],
    risks: ["连续反馈间隔较长，不能直接投入承接资源。"],
    nextAction: "先确认需求有效性与负责人，再决定是否接单",
    evidence: ["职位市场快照", "HC 字段", "反馈记录"],
  },
];
export const decisionJobs: DecisionJob[] = decisionSeeds.map((seed) => ({
  id: seed.id,
  rank: seed.rank,
  company: seed.company,
  role: seed.role,
  direction: seed.direction,
  sourceMode: seed.sourceMode,
  group: seed.group,
  eligibility: "ELIGIBLE",
  globalScore: seed.process,
  explorationScore: seed.exploration,
  personalScore: seed.personal,
  finalScore: seed.final,
  evidenceCoverage: null,
  recommendation: seed.nextAction,
  recentSignal: `${seed.stage} · 剩余 HC ${seed.remainingHc}`,
  facts: {
    职位关系: seed.relation,
    数据来源: seed.sourceMode === "COCKPIT_CONTEXT" ? "驾驶舱上下文" : "职位市场",
    当前阶段: seed.stage,
    "剩余 HC": String(seed.remainingHc),
    "Offer 状态": "0",
    入职状态: "0",
    "历史 Pipeline": seed.pipeline,
  },
  scoreNotes: seed.reasons,
  risks: seed.risks,
  evidence: seed.evidence,
  actions:
    seed.relation === "未加入"
      ? [{ id: "verify", label: "确认项目归属", kind: "verify", detail: "先确认负责人和承接状态" }]
      : [
          { id: "advance", label: "进入项目推进", kind: "advance", detail: seed.nextAction },
          { id: "watch", label: "加入观察", kind: "watch", detail: "保留本周提醒" },
        ],
}));
export const verificationJobs: DecisionJob[] = [
  ["JS6ZVBW", "Nooklab", "DTC负责人", "Offer 1 覆盖剩余 HC 1，入职未确认"],
  ["JFL41BC", "SigmaZ", "平台增长负责人", "Offer 1 覆盖剩余 HC 1，入职未确认"],
  ["JH1ORT9", "refly.ai", "增长运营 / KOL / 投放", "Offer 2 覆盖剩余 HC 2，入职未确认"],
].map(
  ([id, company, role, note], index) =>
    ({
      id,
      rank: index + 1,
      company,
      role,
      direction: index === 0 ? "growth" : index === 1 ? "growth" : "paid",
      sourceMode: "MARKET_ONLY",
      group: "RESULT_CLOSURE",
      eligibility: "VERIFY_REQUIRED",
      globalScore: 0,
      explorationScore: 0,
      personalScore: 0,
      finalScore: 0,
      evidenceCoverage: null,
      recommendation: "核验 Offer 与入职状态",
      recentSignal: note,
      facts: { 职位关系: "待确认", 数据来源: "职位市场", 当前阶段: "OFFER", "剩余 HC": "UNKNOWN", "Offer 状态": "已发出", 入职状态: "UNKNOWN", "历史 Pipeline": "待核验" },
      scoreNotes: ["Offer 已覆盖当前 HC，但入职结果未知。"],
      risks: [note],
      evidence: ["职位市场快照", "Offer 状态字段", "入职状态缺失"],
      actions: [{ id: "verify", label: "去确认状态", kind: "verify", detail: "确认 Offer、入职和剩余 HC" }],
    }) as DecisionJob,
);

export type Client = { name: string; industry: string; state: string; active: number; hc: number | null; feedback: string; r2i: string; i2o: string; hires: number | null; intent: string; score: number | null; risk: string };
export const clients: Client[] = [
  { name: "星河科技", industry: "人工智能", state: "招聘窗口期", active: 4, hc: 9, feedback: "18h", r2i: "38%", i2o: "24%", hires: 12, intent: "强", score: 94, risk: "面试标准抬高" },
  { name: "澄明智能", industry: "人工智能", state: "稳定合作", active: 3, hc: 7, feedback: "22h", r2i: "34%", i2o: "19%", hires: 8, intent: "强", score: 89, risk: "顾问竞争增加" },
  { name: "远屿网络", industry: "内容平台", state: "招聘窗口期", active: 4, hc: 8, feedback: "30h", r2i: "28%", i2o: "17%", hires: 6, intent: "较强", score: 85, risk: "海外画像不稳定" },
  { name: "拾光生活", industry: "消费科技", state: "稳定合作", active: 2, hc: 4, feedback: "16h", r2i: "41%", i2o: "25%", hires: 9, intent: "强", score: 88, risk: "薪资空间有限" },
  { name: "纬度引擎", industry: "跨境电商", state: "反馈降温", active: 3, hc: 5, feedback: "54h", r2i: "31%", i2o: "15%", hires: 5, intent: "中", score: 71, risk: "面试拥挤" },
  { name: "棱镜互动", industry: "营销科技", state: "需求不明确", active: 2, hc: 2, feedback: "72h", r2i: "19%", i2o: "8%", hires: 3, intent: "弱", score: 56, risk: "预算低于市场" },
  { name: "矩阵工场", industry: "SaaS", state: "稳定合作", active: 2, hc: 3, feedback: "28h", r2i: "30%", i2o: "18%", hires: 7, intent: "较强", score: 81, risk: "决策链较长" },
  { name: "云帆智能", industry: "企业服务", state: "高风险", active: 1, hc: 2, feedback: "168h", r2i: "14%", i2o: "0%", hires: 1, intent: "弱", score: 39, risk: "7天无反馈" },
];
export const actionSeed = [
  ["紧急", "AI 广告销售负责人", "优先推进，今天补充2名高匹配人选", "HC增至3且反馈速度提升", "预计缩短5天交付周期"],
  ["关注", "海外增长负责人", "暂停泛化寻访，提高推荐门槛", "已有5人进入面试", "减少约8小时无效投入"],
  ["机会", "星河科技", "将两名顾问调配至重点职位", "过去48小时反馈明显加快", "本周面试 +3"],
  ["紧急", "云帆智能", "向PM确认需求是否仍然有效", "连续7天没有反馈", "避免继续无效投入"],
  ["关注", "商业化增长经理", "重新确认薪资预算", "预算低于市场中位数约18%", "提升推荐转化"],
  ["机会", "AI 产品运营负责人", "扩展头部AI应用公司名单", "反馈稳定且仍有2个HC", "本周推荐 +4"],
];
export const events = [
  ["14:20", "职位升温", "AI 广告销售负责人 · HC 2 → 3"],
  ["12:45", "客户反馈", "星河科技反馈2份简历，均进入初面"],
  ["11:10", "Offer 产生", "用户增长负责人产生1个Offer"],
  ["09:35", "反馈异常", "云帆智能已连续7天未反馈"],
  ["昨天", "职位关闭", "国际化产品增长 · HC已全部关闭"],
];
export const statusOrder: Exclude<Status, "待同步">[] = ["新发布", "升温", "活跃", "拥挤", "降温", "疑似失活", "已关闭"];
export const nav = [
  ["today", "工作台", Sparkles],
  ["jobs", "职位市场", BriefcaseBusiness],
  ["clients", "人才库", Users],
  ["accepted", "项目管理", ClipboardCheck],
  ["sources", "数据源", Database],
  ["rules", "设置中心", Settings2],
] as const;
export const sourceNames = ["内部项目驾驶舱", "职位库", "客户管理记录", "飞书文档", "飞书消息", "邮件反馈", "历史交付记录"];
export type PickFolder = { id: string; name: string; jobIds: string[] };
export type MembershipRelation = "MY_JOB" | "TEAM_SHARED";
export const DEFAULT_FOLDERS: PickFolder[] = [
  { id: "f-week", name: "本周重点", jobIds: [] },
  { id: "f-verify", name: "待验证", jobIds: [] },
  { id: "f-later", name: "稍后再看", jobIds: [] },
];
export type SavedWorkbenchState = Partial<{
  done: number[];
  snoozed: number[];
  extraTasks: string[];
  weights: number[];
  decisionActions: string[];
  membershipRelations: Record<string, MembershipRelation>;
  tray: string[];
  folders: PickFolder[];
  folderMode: boolean;
  engagement: Record<string, EngagementState>;
  events: Record<string, DecisionEvent[]>;
  outcomes: Record<string, Outcome[]>;
  sync: SyncStatus;
  auth: AuthStatus;
  notifications: Notification[];
}>;
export function readSavedWorkbenchState(): SavedWorkbenchState {
  if (typeof document === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("decision-workbench") || "{}");
  } catch {
    return {};
  }
}
export const initialEngagement: Record<string, EngagementState> = { JU87P01: "ACCEPTED", JNDLIXO: "ACCEPTED", JVS2PHH: "ACCEPTED", JPG4HAS: "VIEWED" };
export const INITIAL_TRAY_IDS = Object.keys(initialEngagement).filter((id) => initialEngagement[id] === "ACCEPTED");
export const initialEvents: Record<string, DecisionEvent[]> = {
  JU87P01: [{ id: "evt-1", type: "已接单", at: "08-11 11:31" }],
  JNDLIXO: [{ id: "evt-3", type: "已接单", at: "08-11 13:42" }],
  JVS2PHH: [{ id: "evt-2", type: "已接单", at: "08-11 16:20" }],
};
export const initialOutcomes: Record<string, Outcome[]> = {
  JU87P01: [{ id: "out-39ai-1", stage: "推荐采纳", rating: 5, note: "已确认本轮由本人推进，等待客户回信。", at: "08-11 11:32" }],
  JNDLIXO: [{ id: "out-rainforest-1", stage: "反馈", rating: 4, note: "已核验项目归属，下一步补齐负责人和 HC。", at: "08-11 13:44" }],
  JVS2PHH: [{ id: "out-1", stage: "面试", rating: 4, note: "已完成首轮供给验证", at: "08-11 10:18" }],
};
export function legalActions(job: DecisionJob, state: EngagementState): EngagementCommand[] {
  if (job.facts["职位关系"] === "未加入" || job.eligibility !== "ELIGIBLE") return [];
  if (state === "WATCHED") return ["UNWATCH", "ACCEPT", "DISMISS"];
  if (state === "ACCEPTED") return ["RELEASE", "COMPLETE"];
  if (state === "RELEASED") return ["WATCH", "DISMISS"];
  if (state === "DISMISSED") return ["WATCH"];
  if (state === "VIEWED" || state === "RECOMMENDED" || state === "NEW") return ["WATCH", "DISMISS"];
  return [];
}
export type EngagementPrerequisite = { title: string; detail: string; action?: DecisionAction };
export function engagementPrerequisite(job: DecisionJob, state: EngagementState): EngagementPrerequisite {
  const verify = job.actions.find((action) => action.kind === "verify");
  if (job.facts["职位关系"] === "未加入") return { title: "先确认项目归属", detail: "该职位尚未加入当前项目；完成核验前，关注与接单操作会保持关闭。", action: verify };
  if (job.eligibility === "VERIFY_REQUIRED") return { title: "先补齐关键事实", detail: "Offer、入职或剩余 HC 尚未确认，不能直接进入承接流程。", action: verify };
  if (job.eligibility === "BLOCKED") return { title: "当前承接受阻", detail: "前置条件未满足，暂时没有可执行的承接操作。" };
  if (job.eligibility === "EXCLUDED") return { title: "当前不进入承接", detail: "该职位已被排除，不会提供关注或接单操作。" };
  if (state === "DISMISSED") return { title: "已暂不考虑", detail: "已记录原因；如有新信号，可重新关注后再评估。" };
  if (state === "RELEASED") return { title: "已释放", detail: "该职位已从当前工作区释放；可重新关注后再接单。" };
  if (state === "COMPLETED") return { title: "已完成", detail: "该职位的本轮承接已经结束，结果已归档。" };
  return { title: "当前没有可执行操作", detail: "等待后端返回下一步允许动作。" };
}
export function stateEvent(command: EngagementCommand) {
  return { WATCH: "已关注", UNWATCH: "已取消关注", ACCEPT: "已接单", DISMISS: "暂不考虑", RELEASE: "已释放", COMPLETE: "已完成" }[command];
}
export function nextState(command: EngagementCommand): EngagementState {
  return ({ WATCH: "WATCHED", UNWATCH: "VIEWED", ACCEPT: "ACCEPTED", DISMISS: "DISMISSED", RELEASE: "RELEASED", COMPLETE: "COMPLETED" } as const)[command];
}

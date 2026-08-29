import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (name) => readFile(new URL(name, root), "utf8");
const workbenchSource = async () => (await Promise.all([
  source("app/workbench.tsx"),
  source("app/brainx-projects-api.ts"),
  source("app/workbench-controls.tsx"),
  source("app/workbench-facts.tsx"),
  source("app/workbench-model.ts"),
  source("app/workbench-opportunity.tsx"),
  source("app/workbench-pick-tray.tsx"),
  source("app/workbench-radar-data.ts"),
  source("app/workbench-sources.tsx"),
  source("app/workbench-entry.tsx"),
  source("app/workbench-today.tsx"),
  source("app/workbench-fact-pages.tsx"),
  source("app/jobs-workspace-review.tsx"),
  source("app/job-detail-data.ts"),
  source("app/job-detail-card-review.tsx"),
  source("app/workbench-settings-page.tsx"),
  source("app/workspace-shell.tsx"),
  source("app/ttc-jobs-table.tsx"),
  source("app/client-insights-review.tsx"),
])).join("\n");
const cssSource = async () => (await Promise.all([
  source("app/globals.css"),
  source("app/workbench-concept.css"),
  source("app/workbench-layout.css"),
  source("app/workbench-next.css"),
  source("app/workspace-shell.css"),
  source("app/ttc-jobs-table.css"),
  source("app/jobs-workspace-review.css"),
  source("app/client-insights-review.css"),
  source("app/settings-center-review.css"),
])).join("\n");

test("keeps demo datasets behind the explicit demo mode", async () => {
  const workbench = await source("app/workbench.tsx");

  assert.match(workbench, /brainxJobs\?\?\(demo\?decisionJobs:\[\]\)/);
  assert.match(workbench, /items=\{brainxRadar\?\.items\?\?\[\]\}/);
  assert.match(workbench, /items=\{brainxClients\?\?\[\]\}/);
  assert.doesNotMatch(workbench, /brainxJobs\|\|decisionJobs/);
  assert.doesNotMatch(workbench, /demoRadarJobs|brainxClients\?brainxClients:clients/);
});

test("uses the reference three-column shell and a single-column opportunity workspace", async () => {
  const [page, workbench, css] = await Promise.all([
    source("app/page.tsx"),
    workbenchSource(),
    cssSource(),
  ]);

  assert.match(page, /import DecisionWorkbench from "\.\/workbench"/);
  assert.match(workbench, /type DecisionDirection = "paid"\s*\|\s*"growth"\s*\|\s*"marketing"/);
  assert.match(workbench, /id: "today", label: "今日决策", icon: Sparkles/);
  assert.match(workbench, /<WorkspaceShell activePage=\{shellPage\}/);
  assert.match(workbench, /page==="settings"\?<WorkbenchSettingsPage/);
  assert.doesNotMatch(workbench, /page==="settings"&&<WorkbenchSettingsPage/);
  assert.match(workbench, /精选盘/);
  assert.match(workbench, /function PickTray/);
  assert.match(workbench, /function DecisionZone/);
  assert.match(workbench, /type OpportunityRowModel/);
  assert.match(workbench, /function OpportunityRow/);
  assert.doesNotMatch(workbench, /<div className="pick-card-rail"><div className="pick-card-publish"/);
  assert.match(workbench, /onClick=\{\(\)\s*=>\s*setTab\("market"\)\}/);
  assert.match(workbench, /<RecommendationQueueV2Review items=\{queueItems\}/);
  assert.doesNotMatch(workbench, /today-brief|今天只处理最值得推进的职位|TODAY&apos;S DECISIONS/);
  assert.match(workbench, /onOpen=\{item => \{ const job = queueJobs\.get\(item\.projectId\); if \(job\) open\(job, "judgement"\); \}\}/);
  assert.match(workbench, /aria-label="精选盘"/);
  assert.match(css, /\.pick-tray/);
  assert.match(css, /grid-template-columns:216px minmax\(0,1fr\)/);
  assert.match(css, /touch-action:manipulation/);
  assert.match(workbench, /assistantPlacement="overlay"/);
  assert.match(css, /\.btex-app\.panel-motion-open \.decision-drawer\{filter:none;transition:transform \.30s/);
  assert.match(css, /\.btex-app\.decision-panel-open/);
  assert.match(workbench, /BrainX · \{meta\.title\}/);
  assert.doesNotMatch(workbench, /concept-workspace-menu/);
  assert.doesNotMatch(workbench, /aria-haspopup="menu"/);
  assert.doesNotMatch(workbench, /aria-label="打开设置"/);
  assert.match(workbench, /onNavigate\("settings"\)[\s\S]*?工作台设置/);
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(workbench, /<Pencil aria-hidden="true"\s*\/>\s*编辑/);
  assert.doesNotMatch(workbench, /修正事实/);
  assert.match(css, /\.fact-edit-trigger\{display:inline-flex/);
  assert.doesNotMatch(workbench, /冻结快照/);
  assert.doesNotMatch(workbench, /离线演示态不显示供给/);
  assert.doesNotMatch(workbench, /旁路只读 · 不计入最终得分/);
  assert.match(css, /\.drawer-section-head\{margin-bottom:14px\}/);
  assert.match(css, /\.drawer-section-head h2\{margin:0\}/);
});

test("splits candidates by their live engagement state and keeps verification jobs pending", async () => {
  const workbench = await workbenchSource();

  for (const id of ["JU87P01", "J3NBVPJ", "JPG4HAS", "JNDLIXO", "JPZ5RC5", "JVS2PHH", "J90P3H0", "JBWXJ7W", "JU2GCAC", "JX3S2YU"]) {
    assert.match(workbench, new RegExp(`id:\\s*"${id}"`));
  }
  assert.match(workbench, /const verificationJobs:\s*DecisionJob\[\]\s*=\s*\[/);
  assert.match(workbench, /"JS6ZVBW",\s*"Nooklab",\s*"DTC负责人",\s*"Offer 1 覆盖剩余 HC 1，入职未确认"/);
  assert.match(workbench, /eligibility:\s*"VERIFY_REQUIRED"/);
  assert.match(workbench, /const initialEngagement:\s*Record<string,\s*EngagementState>\s*=\s*\{[^}]*JU87P01:\s*"ACCEPTED"[^}]*JNDLIXO:\s*"ACCEPTED"[^}]*JVS2PHH:\s*"ACCEPTED"/);
  assert.match(workbench, /const acceptedJobs\s*=\s*jobs\.filter\(job\s*=>\s*engagement\[job\.id\]\s*===\s*"ACCEPTED"\)/);
  assert.match(workbench, /const pendingJobs\s*=\s*\[\.\.\.jobs\.filter\(job\s*=>\s*engagement\[job\.id\]\s*!==\s*"ACCEPTED"\),\s*\.\.\.verificationJobs\]/);
  assert.match(workbench, /const pendingShown\s*=\s*showVerification/);
  assert.match(workbench, /const isContext\s*=\s*activeJobId\s*!==\s*null\s*&&\s*pendingShown\.some/);
  assert.match(workbench, /className=\{`formal-recommendation-v2\$\{isContext \? " is-context" : ""\}`\}/);
  assert.match(workbench, /title="我的项目"/);
  assert.match(workbench, /getProjects\(\)/);
  assert.match(workbench, /onAddToProjects=\{job=>\{void addToMyProjects\(job\.id,job\.company\)\}\}/);
  assert.match(workbench, /if \(action === "ADD"\) \{ onAddToProjects\(job\); return; \}/);
  assert.match(workbench, /<RecommendationQueueV2Review items=\{queueItems\}/);
  assert.match(workbench, /"剩余 HC"\s*:\s*"UNKNOWN"/);
});

test("shows source context, row-level scores, detailed layers, reasons and risks", async () => {
  const workbench = await workbenchSource();

  assert.match(workbench, /type SourceMode = "COCKPIT_CONTEXT"\s*\|\s*"MARKET_ONLY"/);
  assert.match(workbench, /sourceMode:\s*"COCKPIT_CONTEXT"/);
  assert.match(workbench, /sourceMode:\s*"MARKET_ONLY"/);
  assert.match(workbench, /label="AI 匹配分" value=\{row\.score\}/);
  assert.match(workbench, /label="证据覆盖"[\s\S]*?value=\{row\.coverage === null \? "—" : `\$\{row\.coverage\}%`\}/);
  assert.doesNotMatch(workbench, /label="建议动作" value=\{row\.action\}/);
  assert.doesNotMatch(workbench, /job\.evidence\[0\]\|\|"推荐快照"/);
  assert.match(workbench, /label="项目推进" value=\{job\.globalScore\}/);
  assert.match(workbench, /label="探索机会" value=\{job\.explorationScore\}/);
  assert.match(workbench, /label="个人适配" value=\{job\.personalScore\}/);
  assert.match(workbench, /label="最终得分" value=\{job\.finalScore\}/);
  assert.match(workbench, /DrawerSection title="风险与缺失"/);
  assert.match(workbench, /DrawerSection title="证据来源"/);
  assert.match(workbench, /brainx:edit-facts/);
  assert.match(workbench, /确认事实后，必须完成重新判断，分数才会更新/);
});

test("preserves engagement, result recording, replay, sync and notifications", async () => {
  const [workbench, demo, loop] = await Promise.all([
    workbenchSource(),
    source("app/decision-demo.ts"),
    source("app/engagement-loop.tsx"),
  ]);

  assert.match(workbench, /function WorkbenchPanel/);
  assert.match(workbench, /function EngagementPanel/);
  assert.match(workbench, /function engagementStateMessage/);
  assert.match(workbench, /if \(state === "RELEASED"\) return \["WATCH", "DISMISS"\]/);
  assert.match(workbench, /if \(state === "DISMISSED"\) return \["WATCH"\]/);
  assert.match(workbench, /已从当前工作区释放；如需继续推进，可重新关注后再开始跟进。/);
  assert.match(workbench, /CommitmentLoopPanel/);
  assert.match(workbench, /updateOpportunityMembership/);
  assert.match(workbench, /membershipRelations/);
  assert.match(loop, /确认项目归属/);
  assert.match(loop, /回写进展/);
  assert.match(loop, /待补录终局结果/);
  assert.match(loop, /progress\/suggestion/);
  assert.match(workbench, /function ReplayPanel/);
  assert.match(workbench, /function NotificationPanel/);
  assert.match(workbench, /const runSync=\(\)=>/);
  assert.match(workbench, /const recordOutcome=/);
  assert.match(workbench, /localStorage\.setItem\("decision-workbench"/);
  assert.match(demo, /export type EngagementState = "NEW"\|"RECOMMENDED"\|"VIEWED"\|"WATCHED"\|"ACCEPTED"/);
});

test("uses 加入项目、关注 and 开始跟进 as separate user-facing concepts", async () => {
  const [workbench, demo, editor, api] = await Promise.all([
    workbenchSource(),
    source("app/decision-demo.ts"),
    source("app/engagement-loop-editor.tsx"),
    source("app/brainx-api.ts"),
  ]);
  const visibleCopy = [workbench, demo, editor, api].join("\n");

  assert.match(demo, /ACCEPT:"开始跟进"/);
  assert.match(editor, /确认开始跟进/);
  assert.match(api, /ACCEPTED: "已开始跟进"/);
  assert.doesNotMatch(visibleCopy, /确认接单|已接单|交付列表|接单后|再接单/);
});

test("keeps the navigation permanently compact and retains the commitments panel", async () => {
  const [workbench, css] = await Promise.all([
    workbenchSource(),
    cssSource(),
  ]);

  assert.doesNotMatch(workbench, /navOpen|sidebarWidth|sidebarResize/);
  assert.match(workbench, /\{\s*kind:\s*"commitments"\s*\}/);
  assert.match(workbench, /function CommitmentsPanel/);
  assert.doesNotMatch(workbench, /mobile-commitment-trigger/);
  assert.doesNotMatch(workbench, /<section className="commitments">/);
  assert.match(css, /\.mobile-commitment-trigger\{display:none\}/);
});

test("manual tuning adjusts soft layers without bypassing hard rules", async () => {
  const [workbench, rules] = await Promise.all([workbenchSource(), source("app/workbench-rules.tsx")]);

  assert.match(rules, /const DIMENSIONS = \[/);
  assert.match(rules, /api\/v1\/assistant\/weight-suggestion/);
  assert.match(rules, /api\/v1\/recommendations\/run/);
  assert.match(rules, /保存并生成新推荐/);
  assert.match(rules, /只调软权重：HC、已入职、职位关闭、项目归属与数据冲突等硬规则不可调整/);
  assert.doesNotMatch(rules, /api\.deepseek|API Key|type="password"/);
  assert.doesNotMatch(workbench, /brainx-deepseek-key|api_key:/);
  assert.match(workbench, /job\.eligibility\s*!==\s*"ELIGIBLE"/);
  assert.match(workbench, /finalScore:\s*seed\.final/);
  assert.doesNotMatch(workbench, /globalScore\s*\*|explorationScore\s*\*|personalScore\s*\*/);
});

test("uses TTC facts and field capabilities without restoring fake job filters", async () => {
  const workbench = await workbenchSource();

  assert.match(workbench, /row\.cities/);
  assert.match(workbench, /row\.pipeline_steps/);
  assert.match(workbench, /row\.owner_name/);
  assert.match(workbench, /field\.filterAvailable/);
  assert.match(workbench, /<JobsWorkspaceReview rows=\{rows\} embedded/);
  assert.match(workbench, /dataLabel="真实职位数据 · 来自 TTC 同步快照"/);
  assert.match(workbench, /loadDetail=\{loadDetail\}/);
  assert.match(workbench, /filterCapabilities=\{filterCapabilities\}/);
  assert.match(workbench, /relation:\s*relationLabels\[row\.relation/);
  assert.match(workbench, /notes:\s*row\.notes/);
  assert.match(workbench, /mergeOpportunityDetail\(toJobDetail\(source\), await getOpportunityDetail/);
  assert.match(workbench, /备注与职位描述/);
  assert.match(workbench, /activeTab=\{panel\.tab\}/);
  assert.match(workbench, /onFollow=\{onAddToProjects\}/);
  assert.match(workbench, /updateOpportunityMembership\(jobId,"MY_JOB"/);
  assert.doesNotMatch(workbench, /function JobFactDetail|aria-label=\{`\$\{row\.role\} 职位事实`\}/);
  assert.match(workbench, /Promise\.allSettled\(\[\s*getRadar\(\)\.then/);
  assert.match(workbench, /filteredRows\.slice\(0, rowLimit\)/);
  assert.match(workbench, /visible\.slice\(0, rowLimit\)/);
  assert.doesNotMatch(workbench, /职位类型筛选|全部职位类型|综合分数 ↓|信号轨道/);
});

test("the corrected package has one workbench implementation", async () => {
  const page = await source("app/page.tsx");
  assert.doesNotMatch(page, /PrototypeWorkbench|variant=/);
});

test("exposes the real TTC job source without persisting its credential in the browser", async () => {
  const sources = await source("app/workbench-sources.tsx");

  assert.match(sources, /TTC 职位系统/);
  assert.match(sources, /\/api\/v1\/ttc\/connect/);
  assert.match(sources, /method: "PUT", body: \{ jwt: token \}/);
  assert.match(sources, /type="password"/);
  assert.match(sources, /autoComplete="off"/);
  assert.doesNotMatch(sources, /localStorage|sessionStorage/);
  assert.doesNotMatch(sources, /演示状态|sourceNames|查看字段/);
});

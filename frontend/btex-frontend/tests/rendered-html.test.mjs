import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (name) => readFile(new URL(name, root), "utf8");

test("uses the reference three-column shell and a single-column opportunity workspace", async () => {
  const [page, workbench, css] = await Promise.all([
    source("app/page.tsx"),
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(page, /import DecisionWorkbench from "\.\/workbench"/);
  assert.match(workbench, /type DecisionDirection = "paid"\|"growth"\|"marketing"/);
  assert.match(workbench, /\["today","工作台",Sparkles\]/);
  assert.match(workbench, /精选盘/);
  assert.match(workbench, /function PickTray/);
  assert.match(workbench, /function DecisionZone/);
  assert.match(workbench, /type OpportunityRowModel/);
  assert.match(workbench, /function OpportunityRow/);
  assert.doesNotMatch(workbench, /<div className="pick-card-rail"><div className="pick-card-publish"/);
  assert.match(workbench, /onClick=\{\(\)=>setTab\("market"\)\}/);
  assert.match(workbench, /title="未接单"/);
  assert.match(workbench, /aria-label="精选盘"/);
  assert.match(css, /\.pick-tray/);
  assert.match(css, /grid-template-columns:164px minmax\(640px,1fr\) 356px/);
  assert.match(css, /rail-brand-logo\{width:108px/);
  assert.match(css, /touch-action:manipulation/);
  assert.match(css, /assistant-open \.assistant-trigger\{display:none\}/);
  assert.match(css, /\.btex-app\.panel-motion-open \.decision-drawer\{filter:none;transition:transform \.30s/);
  assert.match(css, /\.btex-app\.decision-panel-open/);
  assert.match(workbench, /concept-workspace-menu/);
  assert.match(workbench, /aria-haspopup="menu"/);
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(workbench, /<Pencil aria-hidden="true"\/>编辑/);
  assert.doesNotMatch(workbench, /修正事实/);
  assert.match(css, /\.fact-edit-trigger\{display:inline-flex/);
  assert.doesNotMatch(workbench, /冻结快照/);
  assert.doesNotMatch(workbench, /离线演示态不显示供给/);
  assert.doesNotMatch(workbench, /旁路只读 · 不计入最终得分/);
  assert.match(css, /\.drawer-section-head\{margin-bottom:14px\}/);
  assert.match(css, /\.drawer-section-head h2\{margin:0\}/);
  assert.match(css, /\.drawer-metrics>div\{box-sizing:border-box;min-width:0;grid-template-rows:16px auto/);
  assert.match(css, /\.drawer-metrics small\{display:block;white-space:nowrap;line-height:16px\}/);
  assert.match(css, /@media\(min-width:721px\)\{\.drawer-metrics\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\);gap:0\}/);
  assert.match(workbench, /briefTone=title==="为什么现在做"\?"is-reason":title==="风险与缺失"\?"is-risk"/);
  assert.match(workbench, /briefTone==="is-reason"\?<Sparkles\/>:<AlertTriangle\/>/);
  assert.match(css, /\.decision-brief-item\{margin-top:24px;padding:16px;border:1px solid/);
  assert.match(css, /\.decision-brief-item \.explanations\{list-style:none/);
});

test("splits candidates by their live engagement state and keeps verification jobs pending", async () => {
  const workbench = await source("app/workbench.tsx");

  for (const id of ["JU87P01", "J3NBVPJ", "JPG4HAS", "JNDLIXO", "JPZ5RC5", "JVS2PHH", "J90P3H0", "JBWXJ7W", "JU2GCAC", "JX3S2YU"]) {
    assert.match(workbench, new RegExp(`id:"${id}"`));
  }
  assert.match(workbench, /const verificationJobs:DecisionJob\[\]=\[/);
  assert.match(workbench, /"JS6ZVBW","Nooklab","DTC负责人","Offer 1 覆盖剩余 HC 1，入职未确认"/);
  assert.match(workbench, /eligibility:"VERIFY_REQUIRED"/);
  assert.match(workbench, /const initialEngagement:Record<string,EngagementState>=\{"JU87P01":"ACCEPTED","JNDLIXO":"ACCEPTED","JVS2PHH":"ACCEPTED"/);
  assert.match(workbench, /const acceptedJobs=(?:activeDecisionJobs|jobs)\.filter\(job=>engagement\[job\.id\]==="ACCEPTED"\)/);
  assert.match(workbench, /const pendingJobs=\[\.\.\.jobs\.filter\(job=>engagement\[job\.id\]!=="ACCEPTED"&&!tray\.includes\(job\.id\)&&!dismissedRecommendationIds\.includes\(job\.id\)\)/);
  assert.match(workbench, /const pendingShown=showVerification\?pendingJobs/);
  assert.match(workbench, /const isContext=activeJobId!==null&&pendingShown\.some/);
  assert.match(workbench, /isContext=\{isContext\}/);
  assert.match(workbench, /title="已确定"/);
  assert.match(workbench, /title="未接单"/);
  assert.match(workbench, /"剩余 HC":"UNKNOWN"/);
});

test("shows source context, row-level scores, detailed layers, reasons and risks", async () => {
  const workbench = await source("app/workbench.tsx");

  assert.match(workbench, /type SourceMode = "COCKPIT_CONTEXT"\|"MARKET_ONLY"/);
  assert.match(workbench, /sourceMode:"COCKPIT_CONTEXT"/);
  assert.match(workbench, /sourceMode:"MARKET_ONLY"/);
  assert.match(workbench, /label="AI 匹配分" value=\{row\.score\}/);
  assert.match(workbench, /label="证据覆盖" value=\{row\.coverage===null\?"—":`\$\{row\.coverage\}%`\}/);
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
    source("app/workbench.tsx"),
    source("app/decision-demo.ts"),
    source("app/engagement-loop.tsx"),
  ]);

  assert.match(workbench, /function WorkbenchPanel/);
  assert.match(workbench, /function EngagementPanel/);
  assert.match(workbench, /function engagementStateMessage/);
  assert.match(workbench, /if\(state==="RELEASED"\)return \["WATCH","DISMISS"\]/);
  assert.match(workbench, /if\(state==="DISMISSED"\)return \["WATCH"\]/);
  assert.match(workbench, /已从当前工作区释放；如需继续推进，可重新关注后再接单。/);
  assert.match(workbench, /CommitmentLoopPanel/);
  assert.match(loop, /当前行动/);
  assert.match(loop, /回写进展/);
  assert.match(loop, /确认项目归属/);
  assert.match(loop, /加入项目/);
  assert.match(loop, /我的职位/);
  assert.match(loop, /团队共享/);
  assert.match(loop, /membershipNeedsConfirmation/);
  assert.match(loop, /"待确认","UNKNOWN"/);
  assert.match(loop, /requiresFactVerification/);
  assert.match(loop, /核验关键事实/);
  assert.match(loop, /去核验/);
  assert.match(loop, /state==="COMPLETED"/);
  assert.match(loop, /terminalResult:/);
  assert.match(loop, /待补录终局结果/);
  assert.match(workbench, /editRequest=\{factEditRequest\}/);
  assert.match(workbench, /onVerify=\{requestFactEdit\}/);
  assert.match(loop, /终局结果只允许|terminal-result/);
  assert.match(loop, /progress\/suggestion/);
  assert.match(loop, /确认结果与下一行动/);
  assert.match(loop, /行动与结果/);
  assert.doesNotMatch(loop, /演示数据 · 仅保存在当前浏览器/);
  assert.doesNotMatch(loop, /承接已形成闭环/);
  assert.doesNotMatch(loop, /规则草案 · 可修改，确认后才成为事实/);
  assert.doesNotMatch(loop, /结果提交后会纳入下一轮判断依据/);
  assert.match(workbench, /接单需逐个确认目标、行动和截止时间/);
  assert.match(workbench, /updateOpportunityMembership/);
  assert.match(workbench, /membershipRelations/);
  assert.doesNotMatch(workbench, /tray-accept/);
  assert.match(workbench, /function ReplayPanel/);
  assert.match(workbench, /function NotificationPanel/);
  assert.match(workbench, /const runSync=\(\)=>/);
  assert.match(workbench, /const recordOutcome=/); // 旧兼容入口保留，但新面板不再调用
  assert.match(workbench, /localStorage\.setItem\("decision-workbench"/);
  assert.match(demo, /export type EngagementState = "NEW"\|"RECOMMENDED"\|"VIEWED"\|"WATCHED"\|"ACCEPTED"/);
});

test("uses one compact visual system for commitment actions and terminal results", async () => {
  const [loop, css] = await Promise.all([
    source("app/engagement-loop.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(loop, /className="commitment-terminal-options"/);
  assert.match(loop, /aria-pressed=\{terminalStage==="入职"\}/);
  assert.match(loop, /aria-pressed=\{terminalStage==="关闭"\}/);
  assert.match(css, /--commitment-title:16px/);
  assert.match(css, /--commitment-control-height:38px/);
  assert.match(css, /\.commitment-terminal-options button\.selected/);
});

test("keeps inline card feedback action-only", async () => {
  const [workbench, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  assert.doesNotMatch(workbench, /已标记为不感兴趣|当前卡片已暂时保留/);
  assert.doesNotMatch(workbench, /说说「|补充原因/);
  assert.match(workbench, /quickFeedbackReasons/);
  assert.match(workbench, /pick-card-feedback-custom/);
  assert.match(workbench, /const reason=customFeedbackReason\.trim\(\)\|\|selectedFeedbackReason/);
  assert.match(workbench, /feedbackSubmitted\?"已提交":"提交"/);
  assert.match(workbench, /if\(!reason\)\{setInlineFeedbackJobId\(job\.id\);return\}/);
  assert.match(workbench, /feedbackSubmitted\?" feedback-active":" feedback-selecting"/);
  assert.match(workbench, /pick-card-hide-feedback is-thanks/);
  assert.match(workbench, />感谢反馈</);
  assert.match(workbench, /feedbackTrayRestoreRef/);
  assert.match(workbench, /setTray\(current=>current\.filter\(id=>id!==job\.id\)\)/);
  assert.match(workbench, /current\.includes\(job\.id\)\?current:\[\.\.\.current,job\.id\]/);
  assert.match(css, /\.pick-card-hide-feedback\.is-thanks\{display:flex/);
  assert.match(css, /\.pick-card\.feedback-active>:not\(\.pick-card-hide-feedback\)\{filter:blur\(3px\);opacity:\.28;pointer-events:none/);
  assert.match(css, /\.pick-card-feedback-reasons\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.pick-card-feedback-reasons button\.selected/);
});

test("refreshes algorithmic recommendations from the brand control", async () => {
  const [workbench, api, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/brainx-api.ts"),
    source("app/globals.css"),
  ]);

  assert.match(api, /export async function getPickTray/);
  assert.match(api, /export async function nextRecommendationBatch/);
  assert.match(workbench, /const refreshRecommendations=/);
  assert.match(workbench, /await getPickTray\(\)/);
  assert.match(workbench, /await nextRecommendationBatch\(/);
  assert.match(workbench, /\/api\/v1\/recommendations\/run/);
  assert.match(workbench, /aria-label="刷新推荐"/);
  assert.match(workbench, /recommendationRefreshing/);
  assert.match(workbench, /演示推荐已换一批/);
  assert.match(workbench, /dismissedRecommendationIds/);
  assert.match(workbench, /const excludedRecommendationIds=new Set\(\[\.\.\.tray,\.\.\.dismissedRecommendationIds\]\)/);
  assert.match(workbench, /!excludedRecommendationIds\.has\(job\.id\)/);
  assert.match(workbench, /!tray\.includes\(job\.id\)&&!dismissedRecommendationIds\.includes\(job\.id\)/);
  assert.match(css, /\.rail-brand-logo\.is-spinning/);
});

test("keeps the collapsible resizable navigation and retains the commitments panel", async () => {
  const [workbench, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  // PR#5 评审恢复：可拖拽侧边栏（navOpen/sidebarWidth/sidebarResize）与键盘可达手柄
  assert.match(workbench, /const \[navOpen,setNavOpen\]/);
  assert.match(workbench, /const \[sidebarWidth,setSidebarWidth\]/);
  assert.match(workbench, /sidebarResize/);
  assert.match(workbench, /className="rail-resizer"/);
  assert.match(workbench, /role="separator"/);
  assert.match(workbench, /\{kind:"commitments"\}/);
  assert.match(workbench, /function CommitmentsPanel/);
  assert.doesNotMatch(workbench, /mobile-commitment-trigger/);
  assert.doesNotMatch(workbench, /<section className="commitments">/);
  assert.match(css, /\.mobile-commitment-trigger\{display:none\}/);
});

test("manual tuning adjusts soft layers without bypassing hard rules", async () => {
  const workbench = await source("app/workbench.tsx");

  assert.match(workbench, /useState\(\[60,25,15\]\)/);
  assert.match(workbench, /const names=\["项目推进","探索机会","个人适配"\]/);
  assert.match(workbench, /const canApply=total===100/);
  assert.match(workbench, /保存并生成新推荐/);
  assert.match(workbench, /不可调整：HC、已入职、职位关闭、项目归属与数据冲突规则/);
  assert.match(workbench, /job\.eligibility!=="ELIGIBLE"/);
  assert.match(workbench, /finalScore:seed\.final/);
  assert.doesNotMatch(workbench, /globalScore\s*\*|explorationScore\s*\*|personalScore\s*\*/);
});

test("imports cockpit positions into the radar without inventing operational facts", async () => {
  const [workbench, cockpit] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/cockpit-radar-data.ts"),
  ]);

  assert.match(cockpit, /Generated from TTC驾驶舱全景图-副本 \(1\)\.xlsx/);
  assert.match(cockpit, /"company": "Nooklab"/);
  assert.match(workbench, /const cockpitRadarJobs:Job\[\]/);
  assert.match(workbench, /source:"驾驶舱导入" as const/);
  assert.match(workbench, /score:null,hc:null,feedback:"待接入"/);
  assert.match(workbench, /职位类型筛选/);
  assert.match(workbench, /全部职位类型/);
  assert.match(workbench, /CockpitJobDetail/);
  assert.match(workbench, /等待后端同步后再参与职位判断/);
});

test("the corrected package has one workbench implementation", async () => {
  const page = await source("app/page.tsx");
  assert.doesNotMatch(page, /PrototypeWorkbench|variant=/);
});

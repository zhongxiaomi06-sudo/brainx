import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (name) => readFile(new URL(name, root), "utf8");
const workbenchSource = async () => (await Promise.all([
  source("app/workbench.tsx"),
  source("app/workbench-controls.tsx"),
  source("app/workbench-facts.tsx"),
  source("app/workbench-model.ts"),
  source("app/workbench-opportunity.tsx"),
  source("app/workbench-pick-tray.tsx"),
  source("app/workbench-radar-data.ts"),
])).join("\n");
const cssSource = async () => (await Promise.all([
  source("app/globals.css"),
  source("app/workbench-concept.css"),
  source("app/workbench-layout.css"),
])).join("\n");

test("uses the reference three-column shell and a single-column opportunity workspace", async () => {
  const [page, workbench, css] = await Promise.all([
    source("app/page.tsx"),
    workbenchSource(),
    cssSource(),
  ]);

  assert.match(page, /import DecisionWorkbench from "\.\/workbench"/);
  assert.match(workbench, /type DecisionDirection = "paid"\s*\|\s*"growth"\s*\|\s*"marketing"/);
  assert.match(workbench, /\["today",\s*"工作台",\s*Sparkles\]/);
  assert.match(workbench, /精选盘/);
  assert.match(workbench, /function PickTray/);
  assert.match(workbench, /function DecisionZone/);
  assert.match(workbench, /type OpportunityRowModel/);
  assert.match(workbench, /function OpportunityRow/);
  assert.doesNotMatch(workbench, /<div className="pick-card-rail"><div className="pick-card-publish"/);
  assert.match(workbench, /onClick=\{\(\)\s*=>\s*setTab\("market"\)\}/);
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
  assert.match(workbench, /const acceptedJobs=(?:activeDecisionJobs|jobs)\.filter\(job=>engagement\[job\.id\]==="ACCEPTED"\)/);
  assert.match(workbench, /const pendingJobs=\[\.\.\.jobs\.filter\(job=>engagement\[job\.id\]!=="ACCEPTED"\),\.\.\.verificationJobs\]/);
  assert.match(workbench, /const pendingShown=showVerification\?pendingJobs/);
  assert.match(workbench, /const isContext=activeJobId!==null&&pendingShown\.some/);
  assert.match(workbench, /isContext=\{isContext\}/);
  assert.match(workbench, /title="已确定"/);
  assert.match(workbench, /title="未接单"/);
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
  assert.match(workbench, /已从当前工作区释放；如需继续推进，可重新关注后再接单。/);
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
  const workbench = await workbenchSource();

  assert.match(workbench, /useState\(\[60,25,15\]\)/);
  assert.match(workbench, /const names=\["项目推进","探索机会","个人适配"\]/);
  assert.match(workbench, /const canApply=total===100/);
  assert.match(workbench, /保存并生成新推荐/);
  assert.match(workbench, /不可调整：HC、已入职、职位关闭、项目归属与数据冲突规则/);
  assert.match(workbench, /job\.eligibility\s*!==\s*"ELIGIBLE"/);
  assert.match(workbench, /finalScore:\s*seed\.final/);
  assert.doesNotMatch(workbench, /globalScore\s*\*|explorationScore\s*\*|personalScore\s*\*/);
});

test("imports cockpit positions into the radar without inventing operational facts", async () => {
  const [workbench, cockpit] = await Promise.all([
    workbenchSource(),
    source("app/cockpit-radar-data.ts"),
  ]);

  assert.match(cockpit, /Generated from TTC驾驶舱全景图-副本 \(1\)\.xlsx/);
  assert.match(cockpit, /"company": "Nooklab"/);
  assert.match(workbench, /const cockpitRadarJobs:\s*Job\[\]/);
  assert.match(workbench, /source:\s*"驾驶舱导入" as const/);
  assert.match(workbench, /score:\s*null,[\s\S]*?hc:\s*null,[\s\S]*?feedback:\s*"待接入"/);
  assert.match(workbench, /职位类型筛选/);
  assert.match(workbench, /全部职位类型/);
  assert.match(workbench, /CockpitJobDetail/);
  assert.match(workbench, /等待后端同步后再参与职位判断/);
});

test("the corrected package has one workbench implementation", async () => {
  const page = await source("app/page.tsx");
  assert.doesNotMatch(page, /PrototypeWorkbench|variant=/);
});

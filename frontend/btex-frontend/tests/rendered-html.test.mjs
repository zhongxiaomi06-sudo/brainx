import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (name) => readFile(new URL(name, root), "utf8");

test("keeps the supplied workbench shell and presents two balanced decision zones", async () => {
  const [page, workbench, css] = await Promise.all([
    source("app/page.tsx"),
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(page, /import DecisionWorkbench from "\.\/workbench"/);
  assert.match(workbench, /type DecisionDirection = "paid"\|"growth"\|"marketing"/);
  assert.match(workbench, /\["today","精选",Sparkles\]/);
  assert.match(workbench, /精选盘/);
  assert.match(workbench, /function PickTray/);
  assert.match(workbench, /function DecisionZone/);
  assert.match(workbench, /title="未接单"/);
  assert.match(workbench, /aria-label="精选盘"/);
  assert.match(css, /\.pick-tray/);
  assert.match(css, /\.btex-app\.panel-motion-open \.decision-drawer\{filter:none;transition:transform \.30s/);
  assert.match(css, /\.btex-app\.decision-panel-open/);
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

test("shows source context, three layers, final score, reasons and risks", async () => {
  const workbench = await source("app/workbench.tsx");

  assert.match(workbench, /type SourceMode = "COCKPIT_CONTEXT"\|"MARKET_ONLY"/);
  assert.match(workbench, /sourceMode:"COCKPIT_CONTEXT"/);
  assert.match(workbench, /sourceMode:"MARKET_ONLY"/);
  assert.match(workbench, /label="推进" value=\{job\.globalScore\}/);
  assert.match(workbench, /label="探索" value=\{job\.explorationScore\}/);
  assert.match(workbench, /label="个人" value=\{job\.personalScore\}/);
  assert.match(workbench, /label="最终" value=\{job\.finalScore\}/);
  assert.match(workbench, /DrawerSection title="风险与缺失"/);
  assert.match(workbench, /DrawerSection title="证据来源"/);
  assert.match(workbench, /brainx:edit-facts/);
  assert.match(workbench, /确认事实后，必须完成重新判断，分数才会更新/);
});

test("preserves engagement, result recording, replay, sync and notifications", async () => {
  const [workbench, demo] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/decision-demo.ts"),
  ]);

  assert.match(workbench, /function WorkbenchPanel/);
  assert.match(workbench, /function EngagementPanel/);
  assert.match(workbench, /function engagementStateMessage/);
  assert.match(workbench, /if\(state==="RELEASED"\)return \["WATCH","DISMISS"\]/);
  assert.match(workbench, /if\(state==="DISMISSED"\)return \["WATCH"\]/);
  assert.match(workbench, /已从当前工作区释放；如需继续推进，可重新关注后再接单。/);
  assert.match(workbench, /DrawerSection title=\{canRecordOutcome\?"记录结果":"结果记录"\}/);
  assert.match(workbench, /function ReplayPanel/);
  assert.match(workbench, /function NotificationPanel/);
  assert.match(workbench, /const runSync=\(\)=>/);
  assert.match(workbench, /const recordOutcome=/);
  assert.match(workbench, /localStorage\.setItem\("decision-workbench"/);
  assert.match(demo, /export type EngagementState = "NEW"\|"RECOMMENDED"\|"VIEWED"\|"WATCHED"\|"ACCEPTED"/);
});

test("keeps my commitments in the left workspace and removes the bottom duplicate", async () => {
  const [workbench, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(workbench, /const \[navOpen,setNavOpen\]=useState\(false\)/);
  assert.match(workbench, /\{kind:"commitments"\}/);
  assert.match(workbench, /function CommitmentsPanel/);
  assert.match(workbench, /className="mobile-commitment-trigger"/);
  assert.doesNotMatch(workbench, /<section className="commitments">/);
  assert.match(css, /\.mobile-commitment-trigger\{display:none\}/);
});

test("keeps the mobile drawer close control clear of the brand", async () => {
  const [workbench, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(workbench, /mobileNavOpen\?<X aria-hidden="true"\/>/);
  assert.match(css, /\.btex-app\.mobile-nav-open \.mobile-nav-trigger\{left:calc\(min\(82vw,320px\) - 50px\)!important/);
  assert.match(css, /\.btex-app\.mobile-nav-open \.mobile-nav-trigger span\{display:none\}/);
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
  assert.match(workbench, /const handleBrandClick=/);
  assert.match(workbench, /brandClickCountRef\.current>=5/);
  assert.match(workbench, /window\.open\("https:\/\/github\.com\/jiands233","_blank","noopener,noreferrer"\)/);
  assert.match(workbench, /onClick=\{handleBrandClick\}/);
  assert.match(workbench, /演示推荐已换一批/);
  assert.match(workbench, /dismissedRecommendationIds/);
  assert.match(workbench, /const excludedRecommendationIds=new Set\(\[\.\.\.tray,\.\.\.dismissedRecommendationIds\]\)/);
  assert.match(workbench, /!excludedRecommendationIds\.has\(job\.id\)/);
  assert.match(workbench, /!tray\.includes\(job\.id\)&&!dismissedRecommendationIds\.includes\(job\.id\)/);
  assert.match(workbench, /const allJobs=\[\.\.\.acceptedJobs,\.\.\.jobs\.filter\(job=>engagement\[job\.id\]!=="ACCEPTED"\),\.\.\.verificationJobs\]/);
  assert.match(workbench, /你已到达世界的尽头/);
  assert.doesNotMatch(workbench, /当前推荐已处理完|精选盘和不感兴趣的职位不会重复出现|换一批推荐<\/button>/);
  assert.match(css, /\.rail-brand-image\.is-spinning/);
  assert.match(css, /\.recommendation-empty/);
});

test("turns the exhausted recommendation state into a playable dinosaur game", async () => {
  const [workbench, game, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/dino-runner.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(workbench, /import \{ DinoRunner \} from "\.\/dino-runner"/);
  assert.match(workbench, /<DinoRunner\/>/);
  assert.match(game, /event\.code==="Space"\|\|event\.code==="ArrowUp"/);
  assert.match(game, /setPhase\("running"\)/);
  assert.match(game, /setPhase\("over"\)/);
  assert.match(game, /setScore\(value=>value\+1\)/);
  assert.match(game, /点击或按空格开始/);
  assert.match(game, /点击重新开始/);
  assert.match(css, /\.recommendation-empty\{[^}]*min-height:360px/);
  assert.match(css, /\.dino-runner\{/);
  assert.match(css, /@keyframes dino-obstacle-run/);
  assert.match(css, /@keyframes dino-jump/);
});

test("credits the dinosaur empty state to Otto", async () => {
  const [workbench, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(workbench, /className="dino-credit"/);
  assert.match(workbench, /href="https:\/\/github\.com\/jiands233"/);
  assert.match(workbench, /target="_blank"/);
  assert.match(workbench, />Otto<\/a> 作品/);
  assert.match(css, /\.recommendation-empty\{[^}]*position:relative/);
  assert.match(css, /\.dino-credit\{position:absolute;right:24px;bottom:16px/);
});

test("launches a silent firework easter egg after two pick-tray title clicks", async () => {
  const [workbench, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(workbench, /fireworkClickCount\.current\+=1/);
  assert.match(workbench, /fireworkClickCount\.current>=2/);
  assert.match(workbench, /className="pick-tray-firework-trigger"/);
  assert.match(workbench, /className="pick-tray-fireworks"/);
  assert.match(css, /@keyframes pick-tray-firework-ray/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.pick-tray-fireworks\{display:none\}\}/);
});

test("keeps the identity panel focused on one login action", async () => {
  const [workbench, css] = await Promise.all([
    source("app/workbench.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(workbench, /className="identity-panel"/);
  assert.match(workbench, /className="identity-status-card"/);
  assert.match(workbench, /className="identity-primary-action identity-login-only"/);
  assert.match(workbench, />登录<\/button>/);
  assert.doesNotMatch(workbench, /identity-dev-card|identity-demo-card|identity-demo-grid/);
  assert.match(css, /\.identity-panel\{display:grid;gap:/);
  assert.match(css, /\.identity-primary-action\{[^}]*background:rgba\(229,245,240,\.92\)/);
});

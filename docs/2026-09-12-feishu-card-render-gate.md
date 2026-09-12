# 飞书群卡片渲染回归门禁

> 上级入口：[BrainX 文档书](README.md) · [质量门禁操作手册](standards/QUALITY_GATE_OPERATIONS.md)
>
> 相关：[上传前完整验证](standards/PRE_PUSH_VERIFICATION.md) · [前端审核台账](frontend-reviews/README.md)

## 1. 为什么需要它

群里机器人发的卡片由 `src/*.js` 的纯函数产出飞书卡片 JSON，再由飞书渲染。仓库原有的 24 项门禁里，与卡片相关的只有「工具注册五处一致」和「浏览器前后端链路」，**没有任何一项会渲染卡片并检查它长什么样**。结果是：按钮挤成一行、按钮文字被省略号吃掉、表格列被压到读不出来，这些都不会让门禁变红。

本门禁把「卡片好不好看」中**可判定**的部分变成阻断项。

## 2. 怎么用

```bash
# 校验（门禁 full / ci 里已接入，无需手工调用）
node scripts/quality-gate/card-render/run.mjs

# 只看一张卡
node scripts/quality-gate/card-render/run.mjs --only candidate-share

# 改了卡片排版、确认新截图无误后重建基线（必须人眼看过再提交）
node scripts/quality-gate/card-render/run.mjs --update

# 查看当前登记的存量缺陷
node scripts/quality-gate/card-render/run.mjs --list-defects
```

产物：

- 截图与报告：`.quality-gate/reports/card-render/`（`<id>.png` + `summary.md` + `summary.json`）
- 基线：`fixtures/card-render/baseline/<id>.<platform>.png`
- 存量缺陷登记：`fixtures/card-render/known-defects.json`

## 3. 工作原理

1. **样本来自生产代码**：`scenarios.mjs` 调用 `buildDailyCard`、`buildProjectLaunchCard`、`candidateShareCard` 等真实构建函数产出 17 个卡片形态。不手写 JSON —— 手写副本会漂移，门禁就成了摆设。
2. **可变字段归一化**：时间戳、签名、运行号每次运行都变，不归一化就无法比对。`canonicalize()` 把完整时间戳、**只带月日的相对时间戳**（卡片标题用的是 `now().slice(5, 16)` 形式，如「09-12 19:05」）、日期、8 位以上十六进制串替换成占位符后再渲染。
3. **渲染近似**：`renderer.mjs` 把 legacy 卡片 JSON（markdown / hr / action / note / input / button / column_set / column / div）转成 DOM，`theme.css` 按 420px 卡片宽度近似飞书样式。**遇到未覆盖的元素类型直接抛错**，不静默跳过 —— 静默跳过会让新卡片的排版问题逃过门禁。
4. **阻断判据**：
   - `button-truncated`：按钮文字被省略号截断。判据用 `Range` 量文字的真实排版宽度，与按钮内容宽度（`clientWidth` 减左右 padding）精确比较 —— **不能用 `scrollWidth > clientWidth`**：两者都是整数取整，多个中文按钮挤一行时常常只差不到 1px，取整后相等就漏判（2026-09-12 实测「一键加入人才库」已被省略号吃掉却报 PASS）。
   - `overflow-x`：卡片出现横向溢出
   - `pixel-diff`：截图与基线差异超过阈值（默认 0.4%，`BRAINX_CARD_DIFF_RATIO` 可调）
   - `baseline-missing`：新卡片没有基线
   - `render-error`：渲染器未覆盖的元素类型
   - **文字排版 7 条**：`markdown-block-too-long` / `markdown-block-overflow` /
     `label-run-too-long` / `action-row-too-many-buttons` / `action-row-solo` /
     `label-colon-halfwidth` / `heading-not-first` —— 规则定义与示例见
     [飞书群卡片文字排版规范](standards/CARD_TYPOGRAPHY.md)，实现在 `typography.mjs`
     （纯 JSON 判定，不依赖渲染，因此渲染失败时也会照常报出）。

## 4. 四处必须知道的边界

1. **基线按平台分档，且只有「已确认基线的平台」才把缺基线当阻断**：文件名为 `<id>.<platform>.png`。macOS 与 Linux 的中文字体栅格化不同，共用一份基线会天天误报。因此缺基线只在 `darwin`（基线人工确认过的平台，可用 `BRAINX_CARD_BASELINE_PLATFORMS` 覆盖）上阻断；在 CI 的 `linux` 上**跳过像素比对**并在报告里显著提示 —— 但**截断、横向溢出、文字排版这些断言照常生效**，因为它们是度量比较，与字体栅格化无关，CI 依然拦得住真正的排版回归。要在新平台启用像素基线，在该平台跑一次 `--update` 并人眼确认后提交。
2. **浏览器用系统 Chrome，不是 Playwright 自带浏览器**：门禁走 `chromium.launch({ channel: 'chrome' })`（可用 `BRAINX_CARD_BROWSER_CHANNEL` 覆盖），与前端浏览器链路检查（`frontend/btex-frontend/tests/e2e-browser-check.mjs`）同一套。原因是 runner 与本机都自带 Chrome，而 Playwright 的 bundled 浏览器需要额外的 `npx playwright install` —— CI 里没有装，门禁会直接死在启动浏览器这一步（2026-09-12 首次上 CI 就是这个失败）。另外 CI 额外装了 `fonts-noto-cjk`：缺 CJK 字体时中文会渲染成缺字方框，「按钮文字是否被截断」这类字宽断言就失去意义。
3. **渲染是近似，不是飞书本体**：`theme.css` 只能近似飞书的宽度、间距与按钮压缩行为。它能抓到「文字被截断」「横向溢出」「整卡高度异常」这类几何事实，抓不到「配色不协调」「层级看不出来」这类主观判断。后者仍靠人眼审核。
   **近似本身也会出错，改了要复核**：2026-09-12 之前 `.btn` 一律 `flex: 1 1 0`，把「整行只有一个按钮」也拉满整行宽，而飞书对单按钮是「自然宽度 + 左对齐」。于是本地截图里根本看不到「孤儿按钮 + 右侧留白」（F4），门禁对 F4 **完全失明**。现在单按钮行不参与拉伸（`.el-actions[data-count="1"] .btn`），与飞书对齐；`column_set` 右列里的孤行动作贴列尾收口。
4. **存量缺陷只报告不阻断**：`known-defects.json` 沿用 `.quality-gate/baseline.json` 的治理口径 —— 只能减少、不得新增、**到期即失效**。到期后同一缺陷会立刻变成阻断项。这是为了让门禁今天就能上线，同时不让既有缺陷无限期挂账。当前该表为**空**（F2/F3 已修复下线）。

## 5. 首轮运行抓到的缺陷与处置（2026-09-12）

门禁跑通的当天就抓到两处**功能级**排版缺陷，且都已在当日修完，`known-defects.json` 回到空表：

| 卡片 | 缺陷 | 原因 | 修复 |
|---|---|---|---|
| 每日推荐卡 | 「接单并建群」被省略号截断（3 个职位都有） | 动作行放了 4 个按钮，420px 下每个只剩约 88px | 拆成两行 2+2（主行动组 / 辅助组），并把 🔥 移到标题行尾、指标行改用 ` · ` 分隔 |
| 找人结果卡 | 「重点关注」被省略号截断（6 行都有） | 6 列 column_set，「操作」列按权重只分到约 53px | 删掉「操作」列（5 列），按钮移出表格收成下方整行动作区，按每行 3 个拆行，按钮文案带序号 |

两处都是**顾问读不到按钮名**，属于功能缺陷而非审美偏好。

同一天另发现并修掉一处**门禁自身**的缺陷：三张卡的标题拼了 `now().slice(5, 16)` 的相对
时间戳（「09-12 19:05」），而 `canonicalize()` 只认带年份的完整时间戳，导致这几张卡的基线
每跑一次 `--update` 就被改写一次，甚至可能因分钟数字位数变化而偶发阻断。补上相对时间戳
规则后，连续两次 `--update` 的产物已逐字节一致。

同时新增 `markdown-block-too-long` 等 6 条文字排版规则，抓到 Offer 决策群首卡把
「4 个小节」塞进一个 markdown 元素形成的 11 行文字墙；修复方式见
`src/candidate-decision-group.js#splitSections`（按小节拆成独立元素，落库的
`context_summary` 保持原样不变）。

## 6. 第三轮：按钮主次、孤行、emoji 与门禁加严（2026-09-12）

用户确认「F1/F4/F5/F6/F7 也都修改」并要求「文字书写进行美观的调整修改」后，
本轮把卡片按钮清单里剩下的 6 项问题全部处置，并顺手补掉两处门禁盲区。

| 编号 | 处置 | 落地位置 |
|---|---|---|
| F1 主次颠倒 | 候选人卡 primary 从「查看链接」交给「初筛通过」；决策群首卡从「查看 TTC 人才」交给「生成报告」。跳转降为 default 并排到末位 | `tools-candidate-actions.js`、`candidate-decision-group.js` |
| F4 单按钮孤行（8 处） | 新增 `src/card-layout.js#alignSoloAction`，把孤行动作包成两列 `column_set`，按钮落右列当页脚；同时把本地渲染器改成与飞书一致的「单按钮不拉伸」 | `card-layout.js`、`push.js`、`openmai-delivery.js`、`project-reminder.js`、`stage-reminder.js`、`group-intake.js`、`candidate-shortlist-card.js`、`candidate-report.js` |
| F5 项目卡 3 段 action | 动作块从 3 段收到 2 段：一行「找人方式」，一行「补充条件 + 打开职位工作台」；未接单时「接单 + 工作台」并成一行 | `project-launch.js` |
| F6「回放」口径 | 文案改「查看评估详情」，**深链保留 `replay:<decision_id>`** | `push.js` |
| F7 emoji 风格 | 卡片文案一律去 emoji：序号改 `1. 2. 3.`，`🔥`→`（高优）`，`👀`/`⚠️` 删除，`✕ 忽略`→`忽略` | 见[排版规范 §2.1](standards/CARD_TYPOGRAPHY.md) |
| F8 表格词内换行 | 「经验/城市」+「学历」并成一列「背景」（`7 年 · 深圳 · 硕士 · 哈工大`），列数 5→4；列权重调整为 3/3/4/2，让「匹配度」表头不再折行 | `openmai-delivery.js` |

### F6 的结论与最初判断相反（保留证据）

审核 F6 时给的选项是「改文案 + 换深链」，但**核实后发现深链不该换**：

- 深链消费方是 `frontend/btex-frontend/app/use-workbench-deep-link.ts`：`replay:<decision_id>` 按
  `brainxDecisionId` 定位职位，而 `workbench.tsx:274` 用 `kind==='replay'` 打开 **judgement** 面板。
- 换成 `opportunity:<project_id>` 会走 `facts` 视图 —— 与「查看职位」按钮**完全重合**。
- 所以 T1「回放 tab 已下线」只说明「回放」这个词不该再出现在按钮上，深链本身仍然有效且语义更强。
  **最终只改文案，未动深链。**

### 本轮补掉的两处门禁盲区

1. **渲染器把单按钮拉满整行** → 门禁对 F4 失明（详见 §4.3）。已改成与飞书一致的自然宽度。
2. **`scrollWidth > clientWidth` 漏判亚像素截断** → 改用 `Range` 量文字真实宽度（详见 §3.4）。
   加严后当场抓到「一键加入人才库」的真实截断（改为「加入人才库」），且**零误报**；
   中间一度因「减了两次 border」导致 17 张卡全部误报，已修正（`clientWidth` 本身已排除 border）。

另外新增排版规则 `action-row-solo`（`MIN_ACTION_BUTTONS = 2`），把「孤行按钮必须右对齐收口」
变成可阻断的判据 —— 这样 F4 不会再被重新写回来。

本轮全量门禁里，卡片渲染回归 **17/17 通过**；单元测试 **694/694 通过**。

## 7. 维护约定

- 新增或修改任何卡片构建函数后，必须跑 `--update` 看新截图，确认无误再提交基线；只改基线不看图等于把门禁关掉。
- 新增卡片必须在 `scenarios.mjs` 里登记，否则不会被覆盖。
- 渲染器遇到新元素类型会抛错 —— 这是刻意的：先补渲染器，再谈基线。

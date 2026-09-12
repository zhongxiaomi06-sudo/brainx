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
   - `button-truncated`：按钮文字被省略号截断（`scrollWidth > clientWidth`）
   - `overflow-x`：卡片出现横向溢出
   - `pixel-diff`：截图与基线差异超过阈值（默认 0.4%，`BRAINX_CARD_DIFF_RATIO` 可调）
   - `baseline-missing`：新卡片没有基线
   - `render-error`：渲染器未覆盖的元素类型
   - **文字排版 6 条**：`markdown-block-too-long` / `markdown-block-overflow` /
     `label-run-too-long` / `action-row-too-many-buttons` / `label-colon-halfwidth` /
     `heading-not-first` —— 规则定义与示例见[飞书群卡片文字排版规范](standards/CARD_TYPOGRAPHY.md)，
     实现在 `typography.mjs`（纯 JSON 判定，不依赖渲染，因此渲染失败时也会照常报出）。

## 4. 三处必须知道的边界

1. **基线按平台分档**：文件名为 `<id>.<platform>.png`。macOS 与 Linux 的中文字体栅格化不同，共用一份基线会天天误报。**换平台（例如首次上 CI）必须在新平台跑一次 `--update` 并提交**。
2. **渲染是近似，不是飞书本体**：`theme.css` 只能近似飞书的宽度、间距与按钮压缩行为。它能抓到「文字被截断」「横向溢出」「整卡高度异常」这类几何事实，抓不到「配色不协调」「层级看不出来」这类主观判断。后者仍靠人眼审核。
3. **存量缺陷只报告不阻断**：`known-defects.json` 沿用 `.quality-gate/baseline.json` 的治理口径 —— 只能减少、不得新增、**到期即失效**。到期后同一缺陷会立刻变成阻断项。这是为了让门禁今天就能上线，同时不让既有缺陷无限期挂账。

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

## 6. 维护约定

- 新增或修改任何卡片构建函数后，必须跑 `--update` 看新截图，确认无误再提交基线；只改基线不看图等于把门禁关掉。
- 新增卡片必须在 `scenarios.mjs` 里登记，否则不会被覆盖。
- 渲染器遇到新元素类型会抛错 —— 这是刻意的：先补渲染器，再谈基线。

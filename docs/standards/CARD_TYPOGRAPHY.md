# 飞书群卡片文字排版规范

> 上级入口：[BrainX 文档书](../README.md) · [质量门禁操作手册](QUALITY_GATE_OPERATIONS.md)
>
> 相关：[飞书群卡片渲染回归门禁](../2026-09-12-feishu-card-render-gate.md) · [前端审核台账](../frontend-reviews/README.md)

## 1. 为什么需要它

群卡片文案由 `src/*.js` 直接拼字符串产出，没有模板、没有组件约束。结果是同一张卡片里
「加粗标题、英文指标、一堆冒号标签」混着排，读者需要自己找层级；长摘要更是整块塞进一个
markdown 元素，一屏下来是一面 11 行的文字墙。

截图回归只能证明「和上一版长得一样」，不能证明「这一版是有章法的」。因此把「章法」拆成
**可以在卡片 JSON 层判定的规则**，让排版纪律和「按钮被省略号截断」一样能阻断 push。

规则由 `scripts/quality-gate/card-render/typography.mjs` 实现，被卡片渲染门禁与
`tests/quality-gate.test.mjs` 双重调用。

## 2. 文字层级

一张卡片里的每一行都必须能归入下面五级之一。**层级靠「行角色」区分，不靠字号**——
飞书 legacy 卡片只给 markdown / hr / action / note 几种元素，能用的视觉手段只有
「加粗 / 行内代码 / 空行 / 分隔符」。

| 层级 | 名称 | 形态 | 示例 |
|---|---|---|---|
| H | 标题行 | 以加粗开头，必须位于块首 | `**1️⃣ 智能影像产品经理** 🔥` |
| M | 元信息行 | 不加粗，字段用 ` · ` 分隔 | `深圳思博威视 · 深圳 · 我的职位` |
| K | 指标行 | 行内代码包住，术语与顺序固定 | `` `Fit 82 · Activity 74 · Evidence 71` `` |
| L | 标签行 | `**标签**：值`，全角冒号，最多连续 3 行 | `**依据**：客户近两周新增 HC` |
| N | 说明行 | 短句，用 `note` 元素或普通文本 | `run: run-1a2b · snapshot: snap-9f8e7d6c` |

一个典型的职位块：H → M → 结论行 → K → **空行分组** → 最多 3 行 L。

```
**1️⃣ 智能影像产品经理** 🔥
深圳思博威视 · 深圳 · 我的职位
综合 **86** 分 · 置信高 · 建议接单
`Fit 82 · Activity 74 · Evidence 71`

**依据**：客户近两周新增 HC，且面试流程已启动；你的方向关键词与岗位描述重合度高
**风险**：岗位对端侧算法经验要求明确，候选人池可能偏窄
**下一步**：点击「接单并建群」，群内再选择找人方式
```

## 3. 硬规则

以下 6 条会在卡片渲染门禁里**阻断 push**（规则名即 `summary.md` 里的 `[rule]`）。

| 规则 | 判据 | 为什么 |
|---|---|---|
| `markdown-block-too-long` | 单个 markdown 块**正文行** > 8 | 超过就是一屏文字墙，应拆成多个元素，由卡片自身的元素间距承担分组 |
| `markdown-block-overflow` | 单个 markdown 块总行数（含列表）> 16 | 列表可以扫读，但不能无限长 |
| `label-run-too-long` | 连续标签行 > 3 | 4 行以上「**标签**：值」读者会放弃逐行看，应插入空行或元信息行分组 |
| `action-row-too-many-buttons` | 单个 action 块按钮 > 3 | 420px 卡片宽度下每按钮只剩约 88px，文字必被省略号截断（与 `button-truncated` 互为因果） |
| `label-colon-halfwidth` | 标签行使用半角 `:` | 同一张卡片里全角/半角混用会显得不齐 |
| `heading-not-first` | 块内出现加粗标题，但不在第一个非空行 | 块中间再出现整行加粗，读者无法判断哪一行是标题 |

**列表与引用行不计入正文行数**（`- ` / `1. ` / `> `）：它们本身就是可扫读的结构，
把「8 条讨论记录」当成文字墙是误判。但总行数仍有 16 行上限。

## 4. 需要拆分时的做法

**长文本拆块**：不要在一个 markdown 元素里写 4 个小节。按小节拆成多个 markdown 元素，
让卡片的元素间距（8px）承担分组。参考 `src/candidate-decision-group.js#splitSections`
—— 迁移摘要从「一块 11 行」变成「4 个独立小节」。

**动作行拆行**：4 个以上按钮不要挤在一行。拆成多个 `action` 元素，并让分组有语义：
主行动组在前（primary 按钮），辅助组在后（回放 / 忽略）。

```js
// 每日推荐卡：接单并建群 + 查看职位 / 回放 + ✕ 忽略
els.push({ tag: 'action', actions: primaryActions });
if (secondaryActions.length) els.push({ tag: 'action', actions: secondaryActions });
```

**表格外置动作**：窄列里不要放按钮。权重 1–2 的列实际只有 30–60px，按钮文字必被截断。
把按钮移出表格、收成表格下方的整行动作区；按钮文案带序号以对应表格行号
（如 `重点关注 1`），不要用姓名——长名同样会被截断。

## 5. 自检

```bash
# 排版规则单测 + 全部生产卡片样本零违规
node --test tests/quality-gate.test.mjs

# 出图复核：排版违规会在报告里列为阻断项
node scripts/quality-gate/card-render/run.mjs
# 全部卡片截图一页看完：.quality-gate/reports/card-render/gallery.html
```

`summary.md` 的「排版纪律」列显示每张卡的违规数，`OK` 表示零违规。

## 6. 维护约定

- 新增或修改卡片文案后，必须跑一次门禁；排版违规会阻断，不要靠 `known-defects.json` 绕过。
- 新增规则时同步更新本文档的规则表与 `MAX_*` 常量，并在 `tests/quality-gate.test.mjs`
  里补一条「正例通过 + 反例触发」的用例。
- 规则要保守：只拦「一眼看出没章法」的事实，不表达审美偏好。审美判断仍靠人眼看
  `gallery.html`。
- 阈值改动会影响所有存量卡片，改之前先跑一遍门禁看波及面。

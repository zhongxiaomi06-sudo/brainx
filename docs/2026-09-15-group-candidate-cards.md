# 群内候选人呈现标准化：一律系统卡片（2026-09-15）

> 上级：[文档书总目录](README.md) · 相关：[人才匹配跑批模块](2026-09-15-talent-match-run.md)、[飞书群卡片文字排版规范](standards/CARD_TYPOGRAPHY.md)、[群成员权限放开与绑定自愈](2026-09-15-group-member-access-and-bind-selfheal.md)

## 规则（用户 2026-09-15 决策）

群里每次呈现候选人（短名单、搜索完成读回）**一律由代码确定性渲染标准卡片**发到群里，
模型只回一句引导语；不得由模型罗列名单、评分、匹配百分比或自制表格。
起因：多轮对话后模型自由排版逐渐走样（自制"匹配 93%"样式）。

## 实现

- `brainx_candidate_shortlist`（群上下文）：handler 把本页短名单渲染成卡片
  （`src/shortlist-card.js`，3/5/3 行 + 初筛通过/加入reloop 按钮，按钮指令直接复用
  openmai-delivery 的 action builder，不复制指令文本）发到本群；envelope 仅回引导语。
  私聊不发卡、维持原样。
- `brainx_openmai_search` 读回已完成结果（群上下文）：handler 发 `buildOpenmaiDeliveryCard`。
- 幂等防刷屏：`shortlist-card:<job>:<chat>:<page|first>:<日期>` /
  `openmai-result-card:<job>:<chat>:round<N>:<日期>`；发卡 best-effort，
  失败时 envelope 保留名单（宁可模型排版一次，也不能让群友看不到）。
- 短名单候选人 ref 是内部受控引用（非 TTC 编号），姓名列纯文本不拼 TTC 链接。
- `plugins/brainx-openclaw/prompt.js` 硬规则：工具返回 `card_delivered=true` 时数据里
  已没有名单，模型不得凭记忆补写。

## 验证

- `tests/shortlist-card.test.mjs` 7/7；相关回归 88/88；卡片渲染门禁 17/17（新增
  shortlist-card 场景与 darwin 基线）；全量 742/742。

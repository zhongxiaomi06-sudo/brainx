# 018 — SuperMai 自由找人卡片渲染 + 轮次标题修正

状态：Implementing（2026-09-16，用户拍板）
上游：用户 2026-09-16 需求「supermai 生产，下一次给这个，也渲染成固定的格式还有卡片格式」「首轮正确表示，其他轮次不要写第二轮第三轮」「没有可以对应的链接就暂时放空」。
关联：[007 双找人入口](../007-dual-sourcing-entries/spec.md)、[008 三通道找人](../008-sourcing-three-channels/spec.md)、[013 拉群即见卡](../013-launch-card-first/spec.md)。

## 1. 问题

两个独立缺陷，2026-09-16 linda 实证暴露：

### 1.1 自由找人模式不发卡

`tools-jobs.js#supermaiScout` 第 411 行的发卡条件：

```js
const cardSent = cur.status === 'done' && !noReply && jobId && job
  && trySendOpenmaiResultCard(sendCardFn, publicBaseUrl, { job_id: jobId }, principal, job, cur);
```

`jobId && job` 排除了自由找人模式（无职位、纯判据）。结果：自由找人 done 后，`result_text` 原样塞进 envelope，由模型自由排版——同一判据每次呈现格式不一致，且群聊里没有结构化卡片，顾问无法点候选人行的「初筛通过 / 加入reloop」按钮。

`buildOpenmaiDeliveryCard`（`openmai-delivery.js:55`）硬依赖 `job` 对象：第 57 行 `job.project_id` 拼 deep link、第 63 行 `job.search_round`、第 71-74 行 `job.company`/`job.role`。自由找人没 job，直接复用会崩——这是 `jobId && job` 排除条件的根因。

### 1.2 轮次标题误写「第 N 轮」

`buildOpenmaiDeliveryCard` 第 64-68 行：

```js
const roundLabel = searchRound > 1 ? `第 ${searchRound} 轮 · ` : '';
const readyTitle = searchRound > 1 ? `Reloop 候选人推荐 · 第 ${searchRound} 轮已就绪`
  : 'Reloop 候选人推荐 · 首轮已就绪';
const partialTitle = searchRound > 1 ? `Reloop 候选人推荐 · 第 ${searchRound} 轮候选人不足`
  : 'Reloop 候选人推荐 · 首轮候选人不足';
```

用户要求：**首轮才写「首轮」，其他轮次不写「第 N 轮」**。当前非首轮带「第 N 轮」前缀，违反要求。

## 2. 硬约束（已确认，不要推翻）

1. **自由找人模式不接受 `continue_search`**（`skills/brainx-sourcing-supermai/SKILL.md` 第 28 行原话）。卡片底部「继续找人」按钮在自由找人模式下不能复用项目模式的 continue_search command（它带 `job_id=<合成键>` 会被 `NOT_FOUND_OR_FORBIDDEN` 挡回）。
2. **无 PL 编号的候选人链接放空**，不伪造（`openmai-delivery.js#ttcTalentUrl` 已实现：非 `/^PL\d{10,}$/` 返回 null，姓名列降级纯文本）。本 spec 不改链接逻辑，只确认现状满足要求。
3. **复用 `buildOpenmaiDeliveryCard`**，不新建并行卡片函数（AGENTS.md §2 最小实现：优先复用既有函数）。
4. **deep link 放空**：自由找人模式没有真实 opportunity，`buildBrainxDeepLink({ objectType: 'opportunity', objectRef: <合成键> })` 指向不存在的职位。自由找人卡片不放底部「打开工作台」按钮（成功 + 有候选人时本来就不放；失败/空结果时也不放，避免伪造链接）。
5. **幂等键**用 `supermai-result-card:<project_id>:<chatId>:round<n>:<date>`，project_id 是 `supermai:<sha256前12>` 合成键。

## 3. 方案

### 3.1 `buildOpenmaiDeliveryCard` 加 freeform 分支

签名不变，`job` 对象新增可选字段 `job.freeform`（布尔）+ `job.criteria`（判据原文，用于正文摘要）。

- `job.freeform === true` 时：
  - 正文 `company · role` 替换为判据摘要（`job.criteria` 截前 60 字，超过加省略号）。
  - 标题用 `SuperMai 自由找人 · ` 前缀替代 `Reloop 候选人推荐 · `。
  - deep link `target` 置 null；底部「打开工作台」按钮条件加 `target &&`，null 时不渲染（不伪造链接）。
- `job.freeform !== true`（项目模式）：行为不变，复用现有逻辑。

### 3.2 轮次标题修正

```js
const readyTitle = searchRound > 1 ? 'Reloop 候选人推荐 · 续搜已就绪'
  : 'Reloop 候选人推荐 · 首轮已就绪';
const partialTitle = searchRound > 1 ? 'Reloop 候选人推荐 · 续搜候选人不足'
  : 'Reloop 候选人推荐 · 首轮候选人不足';
const roundLabel = ''; // 正文不再带「第 N 轮 ·」前缀
```

freeform 模式下标题用 `SuperMai 自由找人 · 续搜已就绪` / `SuperMai 自由找人 · 首轮已就绪`。

### 3.3 `continueSearchActions` freeform 分支

`job.freeform === true` 时，底部不放「OpenMai 继续找人 / SuperMai 继续找人」按钮（continue_search 不支持），改放一句引导语「想换方向找人，请新发一条以『找人条件：』开头的消息」。

### 3.4 `supermaiScout` 去掉排除条件 + 拼合成 job

`tools-jobs.js#supermaiScout` 第 411 行：

```js
const synthJob = jobId ? job : {
  project_id: project_id,           // supermaiCriteriaKey(criteria)
  company: '自由找人',
  role: (criteria || '').slice(0, 60),
  search_round: cur.search_round || 1,
  freeform: true,
  criteria,
};
const cardSent = cur.status === 'done' && !noReply
  && trySendOpenmaiResultCard(sendCardFn, publicBaseUrl, { job_id: project_id }, principal, synthJob, cur);
```

去掉 `jobId && job` 排除，自由找人也发卡。幂等键内部用 `args.job_id`（= project_id 合成键），`trySendOpenmaiResultCard` 第 306 行的 `openmai-result-card:<job_id>:...` 自然变成 `supermai:<sha256前12>`，防重正确。

### 3.5 卡片门禁登记

`scripts/quality-gate/card-render/scenarios.mjs` 加 scenario `supermai-freeform`：自由找人卡，2 个候选人均无 PL 编号（姓名列纯文本，链接放空），`search_round: 1`，验证 freeform 分支 + 链接放空渲染正确。

## 4. 验收

1. `npm run verify:quick` 通过。
2. 卡片门禁 `--update` 提交基线，`gallery.html` 含 `supermai-freeform` 卡片，候选人姓名列为纯文本（无按钮）、无伪造链接。
3. 非首轮项目模式卡片标题为「续搜已就绪」/「续搜候选人不足」，不含「第 N 轮」。
4. 自由找人模式卡片标题为「SuperMai 自由找人 · 首轮已就绪」，正文为判据摘要，底部无「打开工作台」按钮（无 deep link）。

## 5. 不做

- 不改 `ttcTalentUrl` 链接逻辑（已满足「无链接放空」）。
- 不动 speckit/.specify/.codebuddy 批次（来源不明，留给用户自定）。
- 不部署生产（本 spec 只到提交 + 门禁；部署需用户单独确认）。

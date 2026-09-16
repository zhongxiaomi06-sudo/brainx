# 018 Plan — SuperMai 自由找人卡片渲染 + 轮次标题修正

## 改动文件

| 文件 | 改动 | 行数影响 |
|---|---|---|
| `src/openmai-delivery.js` | `buildOpenmaiDeliveryCard` 加 freeform 分支 + 轮次标题修正；`continueSearchActions` freeform 分支 | +~25 行 |
| `src/agent-gateway/tools-jobs.js` | `supermaiScout` 去掉 `jobId && job` 排除，拼合成 job | +~10 行 |
| `scripts/quality-gate/card-render/scenarios.mjs` | 加 `supermai-freeform` scenario | +~15 行 |
| `specs/018-supermai-freeform-card/` | spec + plan | 本文件 |
| `docs/AGENT_COMMIT_LOG.md` | 中文记录 | +1 条 |

## 执行顺序

1. `openmai-delivery.js`：改 `buildOpenmaiDeliveryCard`（freeform 分支 + 轮次标题）+ `continueSearchActions`（freeform 分支）
2. `tools-jobs.js`：改 `supermaiScout`（拼合成 job + 去排除条件）
3. `scenarios.mjs`：加 `supermai-freeform` scenario
4. 跑卡片门禁 `--update` 提交基线
5. `npm run verify:quick`
6. `git add` 只 add supermai 相关文件 + spec + AGENT_COMMIT_LOG（不带 speckit）
7. commit + 确认 `git show --stat`

## 风险

- `buildOpenmaiDeliveryCard` 被 `openmai-delivery.js` 持久投递链路（第 363 行）也调用，freeform 分支不能破坏项目模式既有行为——用 `job.freeform` 显式标志，默认 false，项目模式不传该字段，行为不变。
- 门禁基线提交后，下游 `known-defects.json` 只能减少不能增加（AGENTS.md §9）。

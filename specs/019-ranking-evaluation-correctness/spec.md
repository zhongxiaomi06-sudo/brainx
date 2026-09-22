# 019 — 排序评估正确性

状态：Specified（2026-09-22）

上游：[仓库重构施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)阶段 01、
[Algorithm A 决策契约](../../docs/2026-09-22-algorithm-a-contract.md)第 6 节、
[阶段 00 基线](../../docs/2026-09-22-refactor-phase-00-baseline.md)。

## 1. 问题

现有离线评估有三个确定性错误：

1. Python DCG 按预测排序后，仍用枚举位置读取原标签，交换预测分不会正确改变结果。
2. JavaScript IDCG 只对预测 Top K 中的标签排序，遗漏同组 Top K 外更高价值项目。
3. `evaluate(db, { runs })` 的 SQL 仍绑定模块级 `RUNS`，调用方参数不生效。

此外，JavaScript 先过滤未知标签再截 Top K，会把原第 K 名之后的已知项目前移，
违反“未知不当 0、也不挤压预测名次”的契约。

## 2. 用户场景与验收

### S1：预测顺序决定 DCG

给定标签 `[3, 1]`，预测分从 `[2, 1]` 换成 `[1, 2]` 后，NDCG 必须下降。

### S2：完整评估组决定 IDCG

给定预测顺序标签 `[1, 0, 3]` 且 `K=2`，DCG 只看前两位，但 IDCG 必须包含组内
标签 3；结果必须小于 1。

### S3：未知标签保留预测位置

给定前 K 位含未知标签，先截取预测 Top K 再忽略未知收益；不能把第 K+1 位前移。
无已知正收益时返回 `null`，而非伪造可比较指标。

### S4：调用方轮数生效

调用 `evaluate(db, { runs: 2 })` 时，每位顾问的查询 LIMIT 必须为 2，不受命令行默认
值影响。

## 3. 兼容与不做

- 保持 CLI、函数入口、报告字段和 LightGBM 模型格式不变。
- 不修改正式 `baseline-1.1` 推荐顺序或数据库。
- 不在本单元改造历史标签冻结、成熟窗口、归因和覆盖率；报告继续明确当前限制。
- 不引入 npm 或 Python 新依赖。

## 4. 完成条件

- 先加入能在旧实现失败的手算回归测试，再修代码。
- Python 与 JavaScript 手算结果一致；规则和影子评估复用同一 JavaScript 指标实现。
- 专项测试和 `npm run verify:quick` 通过。
- 更新施工手册进度、中文提交记录并创建独立 commit。
- 在最新 commit 上执行 `npm run verify`；未完整通过时不得 push。

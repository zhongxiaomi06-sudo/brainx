# 032 — Algorithm A 离线与影子评估

状态：Verified（2026-09-24）

上游：[施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)阶段 08、
[Algorithm A 决策契约](../../docs/2026-09-22-algorithm-a-contract.md)、
[Algorithm A 最小链路](../031-agentic-ranking-v1/spec.md)。

## 1. 目标

建立只读业务效果、不可投递的 `agentic-shadow-eval-v1`：先冻结评估计划和门槛，再用同一授权、时点与候选池比较 `baseline-1.1` 和 `agentic-ranking-v1`，分别报告召回遗漏与 Agent 选择遗漏，并保存稳定性、成本、延迟、分组差异和样本不确定性证据。

本阶段不切正式读路径，不把影子结果记作真实曝光或业务转化，也不依据影子报告批准全员发布。

## 2. 行为要求

### S1｜门槛先登记且不可事后改写

每个评估计划必须由调用方显式提供样本量、标注覆盖、排序非劣、成本、延迟、稳定性和分组差异门槛；系统不猜生产阈值。计划冻结后只可新建替代版本，不提供原地更新。

### S2｜同池对照与两段 Recall

影子运行复用 A 冻结的授权版本、`as_of`、来源水位、画像/负载版本和候选集。旧基线仅以 `dry_run` 计算，并投影到同一候选池；不写 `decision_runs`、`recommendations` 或 impression。报告分别计算：

- 全标注全集进入冻结候选池的 retrieval recall；
- 已召回高价值项被 Agent 最终选择的 selection recall；
- 基线与 A 的 NDCG、Top-K 重合及名次差异。

标注全集不完整时只能称“提供标注范围内覆盖”，不能宣称全量 Recall。

### S3｜稳定性与攻击面回放

支持同一冻结候选集的重复运行和候选顺序扰动，并保存显式场景码。自动回归覆盖长文本、缺失画像、冷启动、来源冲突和恶意 JD；这些内容始终是不可信数据，不能改变工具权限或硬约束。

### S4｜影子隔离

A run 显式标记 `SHADOW`，后续正式读取只能选择 `LIVE`。影子编排完成后验证 push、真实曝光和旧 impression 计数未变化；任一变化都将运行标记失败。影子运行只有 `SHADOW_COMPLETED/FAILED`，不产生投递资格。

### S5｜证据与晋升结论

报告保存模型、prompt、工具、策略、候选集、用量、成本和延迟版本证据。硬约束违规必须为 0。样本量或覆盖不足时结论固定为 `INSUFFICIENT_EVIDENCE`；门槛满足时最高只能建议 `READY_FOR_CONTROLLED_GRAY`，影子数据永远不能给出 `ALL_USERS`。真实业务结果字段固定为不可从影子推断。

## 3. 验收

1. 基线与 A 的候选集合、授权版本、时点和来源快照可逐项核对。
2. retrieval recall 与 selection recall 分开，未知标签保持未知，IDCG 使用完整已知标注集合。
3. 重复/乱序输入的稳定性可与指定参考运行比较；七类场景有回归证据。
4. 影子运行前后正式推荐、投递、impression 和真实曝光计数不变。
5. 成本、延迟、分组差异和样本不足均按冻结门槛判断；报告不伪造转化或 propensity。
6. 专项、快速和完整门禁通过。

## 相关文档

- [实现计划](plan.md)
- [任务清单](tasks.md)
- [上传前完整验证](../../docs/standards/PRE_PUSH_VERIFICATION.md)

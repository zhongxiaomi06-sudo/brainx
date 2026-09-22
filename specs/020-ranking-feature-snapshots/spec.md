# 020 — 排序特征冻结快照

状态：Implemented，待完整门禁收口（2026-09-22）

上游：[仓库重构施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)阶段 01、
[Algorithm A 决策契约](../../docs/2026-09-22-algorithm-a-contract.md)第 6 节、
[排序评估正确性](../019-ranking-evaluation-correctness/spec.md)。

## 1. 问题

`bin/brainx-ltr-export.mjs`、`scripts/eval-ranking.mjs` 和
`bin/brainx-shadow-daily.mjs` 在评估历史推荐时重新读取当前 `job_facts`。
职位状态、HC、Pipeline、群活跃或备注后来变化，会改写过去样本的输入，形成未来泄漏。

`recommendations.breakdown_json` 只冻结六维评分分解，不能还原 LTR 所需的全部职位特征。
历史记录也不能用当前事实反向伪造完整快照。

## 2. 用户场景与验收

### S1：新推荐冻结特征

新建正式推荐时，每条持久化推荐同时保存 `ltr-feat-v1` 特征快照。快照必须在同一
推荐事务内写入，不能出现推荐成功但特征快照缺失。

### S2：职位变化不改历史输入

推荐生成后修改 `job_facts` 的状态、HC、Pipeline 或备注，LTR 导出、影子评估和分歧
日报仍读取原快照，导出的历史特征逐字段不变。

### S3：旧记录诚实排除

`feature_snapshot_json` 为空、损坏、版本不匹配或字段不完整时，不回读当前
`job_facts` 兜底。LTR 导出排除该行并报告原因；影子指标不发布不可比较的数值。

### S4：正式推荐兼容

正式 `baseline-1.1` 的资格过滤、分数、顺序、API/CLI 返回和已有回放字段保持不变；
特征快照不直接出网。

## 3. 数据契约

在 `recommendations` 新增可空列 `feature_snapshot_json`：

```json
{
  "schema_version": "ltr-feat-v1",
  "captured_at": "2026-09-22T00:00:00.000Z",
  "features": { "state_open": 1 }
}
```

`features` 必须完整包含 `LTR_FEATURES`，每项为有限数字。新写入不得为空；历史空值
保持空，不执行回填。本规格只新增迁移文件并在本地/内存库验证，不对生产库执行迁移。

## 4. 不做

- 不实现标签观察窗口、结果发生/收到双时间和样本成熟度；它们属于下一原子单元。
- 不回填旧推荐，不用当前职位事实猜测旧特征。
- 不改 Algorithm A、正式规则排序、生产数据或发布状态。
- 不引入新依赖。

## 5. 完成条件

- 先加入能在旧实现失败的回归测试。
- 空库安装、重复打开、正式推荐写入、职位变化回放、旧记录排除均通过。
- 排序专项和 `npm run verify:quick` 通过。
- 更新施工进度与中文提交记录，创建独立 commit。
- 在最新 commit 上执行完整门禁；未通过时不得 push。

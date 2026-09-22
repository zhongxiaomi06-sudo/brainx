# 025 — 清理路径隔离与显式策略 dry-run

状态：Specified（2026-09-23）

上游：[数据增长、引用与保留责任只读盘点](../../docs/2026-09-22-retention-inventory.md)、
[推荐数据契约与迁移手册](../../docs/2026-09-22-ranking-data-migration.md)第 7 节、
[仓库重构施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)阶段 02。

## 1. 问题

现有 `recommend()` 在每轮事务里自动调用 `pruneRecommendationHistory()`，只保护业务结果引用，
可能删除仍被曝光、事件、负反馈、实验或事故调查需要的旧推荐。旧
`bin/brainx-retention.mjs --apply` 也能直接删除并 checkpoint，且仍采用“Top 20 等于曝光”和旧
节流状态名。当前责任人、TTL、恢复点和最新本地 schema 都未就绪，这两条写路径必须先停用。

## 2. 用户场景与验收

### S1：推荐运行不再隐式删除历史

新推荐仍按每轮持久化上限控制新增量，但不得在业务事务内删除过去轮次。原
`pruneRecommendationHistory()` 不再由生产路径调用；历史推荐是否保留只由后续独立生命周期
流程决定。

### S2：旧 apply 入口失败关闭

`bin/brainx-retention.mjs --apply` 必须在打开数据库前以稳定错误码
`RETENTION_APPLY_DISABLED` 非零退出；无 `--apply` 时只运行新的只读盘点，不调用 `openDb()`、
不创建临时表、不迁移、不播种、不 checkpoint。

### S3：显式策略的只读 dry-run

新增 `retention-plan-v1`：输入固定 `as_of` 和版本化策略，只读统计推荐快照与节流审计的总数、
保护数、候选数及保护原因。输出只含聚合，不包含主键、顾问、群或内容。重复运行结果一致，
数据库文件不变。

### S4：引用保护完整且缺能力即阻断

推荐项只在早于 TTL、超出每顾问最近保留轮次，并且没有曝光、真实下发、业务结果、决策事件
或负反馈事件引用时才计为候选；任一所需表/列缺失时该类别标记 `BLOCKED_SCHEMA_CAPABILITY`，
候选数为 null。节流运行必须无推荐项且早于 TTL。`ttc_field_reports`、`sync_runs` 和原始上下文
在本单元保持 `BLOCKED_POLICY_NOT_IMPLEMENTED`。

### S5：dry-run 永不授权执行

无论策略文件写什么，报告都必须 `execution_supported=false`、`execution_ready=false`。本单元
不实现删除、归档、停止开关、审计写入或恢复执行；这些必须在责任人、TTL 和恢复演练获批后另
立规格。

## 3. 不做

- 不连接生产，不迁移本地副本，不执行 DELETE、UPDATE、INSERT、DDL、checkpoint 或 VACUUM。
- 不生成候选 ID、SQL 或可复制执行命令。
- 不批准 TTL、责任人、恢复点或生产执行窗口。
- 不把仅创建但未 `served_at` 的展示候选冒充真实曝光，也不改变正式排序。

## 4. 完成条件

- 先加入隐式裁剪、旧 apply、引用保护、缺能力和文件只读回归。
- 推荐写入不再删历史；旧 apply 在数据库打开前失败。
- `retention-plan-v1` 在完整夹具可复核，在旧 schema 失败关闭。
- 专项测试、快速门禁和最新提交完整门禁通过；没有清理、发布或 push。

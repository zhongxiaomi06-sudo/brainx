# 021 — 排序标签观察窗口与样本成熟度

状态：Specified（2026-09-22）

上游：[仓库重构施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)阶段 01、
[Algorithm A 决策契约](../../docs/2026-09-22-algorithm-a-contract.md)第 6 节、
[排序特征冻结快照](../020-ranking-feature-snapshots/spec.md)。

## 1. 问题

现有 `labelFor()` 读取顾问与职位的当前承接状态和全部 `job_outcomes`。它不知道推荐
曝光时点、观察窗口和评估数据截点，因此后续发生或迟到录入的结果会改写过去样本。

`decision_events` 只有 `occurred_at`；`job_outcomes.observed_at` 同时承担发生与录入含义。
旧记录也普遍没有可靠的推荐项关联，不能自动归因到最近一次推荐。

## 2. 用户场景与验收

### S1：双时间写入

新行为事件保存 `occurred_at` 与 `received_at`；新业务结果保存 `occurred_at` 与
`received_at`，同时保留 `observed_at` 兼容现有接口。历史新列保持空，不伪造时间。

### S2：显式观察窗口

评估调用必须提供 `window_days` 和 `cutoff_at`。窗口从真实 `served_at` 开始，只有发生
在窗口内、且在数据截点前已收到的事件或结果可形成标签。未传参数时 CLI 失败关闭，
不得把建议的 7 日窗口固化为生产默认值。

### S3：成熟度和排除原因

截点早于窗口结束时样本为 `IMMATURE`；没有真实曝光为 `UNEXPOSED`；旧记录缺双时间为
`MISSING_EVENT_TIME`。成熟但没有合格结果保持 `UNKNOWN_NO_OUTCOME`，不得变成标签 0。

### S4：只认明确推荐关联

标签事件或结果必须显式关联同一 `decision_id`。手工搜索、其他轮次或无关联业务结果
只计业务总量，不计本轮推荐贡献。写入时校验 decision 必须属于同一顾问和职位。

### S5：正式业务兼容

现有 `labelFor()` 继续作为旧诊断/业务视图，不改变正式 `baseline-1.1` 推荐、承接状态、
API 返回和现有 `observed_at` 消费者；新的时间切分只供离线导出和评估。

## 3. 数据契约

迁移 `0052_ranking_label_times.sql`：

- `decision_events.received_at TEXT NULL`；
- `job_outcomes.occurred_at TEXT NULL`；
- `job_outcomes.received_at TEXT NULL`；
- 为按 `decision_id` 和双时间读取增加有界索引。

评估返回至少包含：`status / label / reason / served_at / matures_at / cutoff_at`。标签版本
固定为 `ranking-label-v2`，任何报表和训练导出必须记录版本、窗口与截点。

## 4. 不做

- 不把 7/30/90 日任一窗口设成生产默认；业务窗口仍待阶段 08 前批准。
- 不回填旧事件/结果时间，不猜测历史 `decision_id`。
- 不在本单元接入忽略撤销、更正事件或负反馈原因；它们属于下一原子单元。
- 不执行生产迁移、历史回填、训练、模型晋升或发布。

## 5. 完成条件

- 先加入未来结果、迟到结果、未成熟、未曝光和跨轮归因的失败回归。
- 新写事件/结果具有双时间，非法或越界 decision 关联失败关闭。
- LTR 导出与排序评估要求显式窗口和截点，并报告样本状态计数。
- 专项测试与 `npm run verify:quick` 通过，创建中文原子 commit。
- 最新 commit 上完整门禁通过；未通过时不得 push。

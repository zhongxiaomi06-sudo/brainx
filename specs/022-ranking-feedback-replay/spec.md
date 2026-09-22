# 022 — 排序负反馈事件回放与撤销

状态：Implemented（2026-09-22；等待最新提交完整门禁收口）

上游：[仓库重构施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)阶段 01、
[排序标签观察窗口](../021-ranking-label-windows/spec.md)、
[忽略状态后端收口复审](../../docs/frontend-reviews/2026-08-31-ignore-state-backend.md)。

## 1. 问题

`opportunity_ignores` 是当前忽略投影，但重新加入时直接删行；旧
`recommendation_feedback` 保存原因，却在补充原因时覆盖、撤销时删除。两条路径都不能回答
“某个评估截点前是否仍处于负反馈状态”，也没有稳定绑定具体推荐项。

不能把项目级忽略猜测归因到最近推荐，也不能为了离线评估改变正式忽略、重新加入或
`baseline-1.1` 的当前行为。

## 2. 用户场景与验收

### S1：追加式反馈事件

新负反馈、撤销和原因更正分别追加 `NEGATIVE / REVOKED / REASON_CORRECTED` 事件；现有
`opportunity_ignores` 与 `recommendation_feedback` 继续作为当前兼容投影。撤销和更正不得
删除或覆盖事件历史，旧投影不做历史回填。

### S2：明确推荐归因

工作台和飞书推荐卡写入准确 `decision_id`，服务端校验其属于同一顾问和职位。项目详情
发起的无推荐关联忽略仍能排除职位，但 `decision_id` 为空，不计任一推荐轮贡献。

### S3：按评估截点回放

标签只回放真实曝光后观察窗口内发生、且截点前收到的反馈事件。有效 `NEGATIVE` 形成
标签 0；窗口内后续 `REVOKED` 取消该负标签；原因更正只改变原因，不改变反馈极性。
截点之后收到的事件只进入后续评估版本，窗口外动作不改写已冻结窗口。

### S4：稳定原因码

现有中文原因确定映射到 `NO_CAPACITY / DIRECTION_MISMATCH / JOB_QUALITY /
OTHER_CONSULTANT / INSUFFICIENT_INFO / OTHER`，同时保留最多 200 字原文。评估、训练导出和
日报记录负反馈原因计数，不把原因文本用作权限或硬事实。

### S5：兼容当前产品

正式忽略仍从精选盘、全部职位、我的项目和后续推荐中排除；撤销、重新加入或接单恢复
当前可见性。旧 API 缺 `decision_id` 时保持业务写入兼容，但事件不归因到推荐贡献。

## 3. 数据契约

迁移 `0053_ranking_feedback_events.sql` 新增 `recommendation_feedback_events`：

- 事件 ID、顾问、职位、可空 `decision_id`、事件类型；
- 稳定原因码与受限原因原文；
- 来源、发生时间、收到时间和唯一幂等键；
- 按推荐项时间回放及顾问职位回放的有界索引。

历史 `opportunity_ignores`、`recommendation_feedback` 不反推 `decision_id`、撤销或原因版本。

## 4. 不做

- 不执行生产迁移、历史回填、训练、模型晋升、发布或 push。
- 不把旧反馈猜测绑定到最近 run，不修改旧评估集。
- 不在本单元设计在线自学习、冷却时长或业务主指标窗口。
- 不拆除两个兼容投影；它们的退役须在调用归零后另立规格。

## 5. 完成条件

- 先加入负反馈、原因更正、撤销时点、迟到收到和无关联不归因的失败回归。
- 所有新写入口追加双时间事件，幂等重试不重复，非法推荐关联失败关闭。
- `ranking-label-v2`、LTR 导出、离线评估和影子日报暴露稳定原因统计。
- 专项测试和快速门禁通过并创建中文原子 commit。
- 最新 commit 上完整门禁通过；任何失败均不得 push。

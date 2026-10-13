# Algorithm A 工作台与飞书忠实展示接入记录

> 上级入口：[前端审核台账](README.md)

## 审核身份

- 审核日期：2026-09-24
- Storybook 场景：`组合场景/推荐队列 V2 审核稿/Algorithm A 原序与忠实字段`、异步生成、旧结果、撤权 rank 缺口、动作失败、窄屏，以及 `业务组件/判断规则/Algorithm A 主动偏好与容量`
- 对应 commit：本记录所在实现提交
- 审核范围：A 原序队列、冻结分页、状态恢复、主动设置、飞书每日推荐卡和默认关闭的正式入口接线

## 用户结论

- 已确认：用户要求按施工手册连续完成阶段 09，不再以小步骤反复停下；这构成本轮实现授权，不等于视觉审核通过。
- 未确认：A 卡片的信息密度、理由/权衡/待核实项视觉层级和主动设置表单仍待用户复看。
- 正式接入授权：允许代码接入，但 `BRAINX_AGENTIC_READ` 默认关闭；本轮不执行生产切读、发布或发送。

## 数据与动作边界

- 真实字段：`engine/run_id/decision_id/rank/reason/tradeoff/evidence_refs/uncertainties/suggested_next_action/generated_at`、职位规范事实、承接状态和合法动作。
- 缺失字段：A 不提供 score、六维 breakdown、概率或模型置信；界面保持“—”或隐藏，不从旧基线补值。
- 后端依赖：只读 `LIVE/PUBLISHED` A run；SHADOW 永不进入展示。读取时重验可见性、职位开放状态、HC、忽略和已承接，失效项撤下但不重排。
- 允许动作：查看职位/判断、加入项目、当前状态允许的操作，以及幂等忽略/撤销。A 决策引用已进入同一负反馈校验边界。

## 五状态证据

- Storybook：已完成；本地浏览器交互 91/91 通过。
- 用户审核：未审核；技术测试和当前施工授权都不能代替用户视觉确认。
- 正式接入：已接入；推荐 API、正式精选盘、设置中心、预览/发送路由、scheduler、CLI 和 Agent 预览工具均消费同一 A 展示语义，但读取开关默认关闭。
- 目标环境发布：未发布。
- 真实数据验证：部分验证（本地 fixture/脱敏契约）；未用目标环境真实 A run、账号撤权或飞书真机验证。

## 自动验证与回滚

- 后端专项覆盖 LIVE/SHADOW 隔离、原序、冻结游标、搜索、旧排序拒绝、撤权/关闭、生成/失败/弃权/旧结果、设置校验、动作幂等和飞书字段忠实。
- 前端静态适配测试 54/54、Storybook 91/91；飞书卡片渲染 19/19，新 A 卡视觉基线已人工查看后登记。
- 回滚只需关闭 `BRAINX_AGENTIC_READ`；历史 baseline 仍明确标记为 `baseline-1.1`，不会被冒充为 A。

## 未完成项

- [ ] 用户复看 A 队列、异步/旧结果和主动设置 Storybook 场景。
- [ ] 在目标环境发布明确 commit，并用同一 `run_id` 对照数据库、API、Web 与飞书顺序和字段。
- [ ] 用真实账号验证撤权、关闭、幂等动作、飞书桌面/手机和失败恢复。

## 相关文档

- [Algorithm A 忠实展示规格](../../specs/033-agentic-presentation/spec.md)
- [施工总手册阶段 09](../2026-09-22-refactor-agentic-ranking-manual.md#09工作台与飞书忠实展示)
- [内部 Storybook 组件库](../storybook-component-library.md)
- [飞书卡片排版规范](../standards/CARD_TYPOGRAPHY.md)

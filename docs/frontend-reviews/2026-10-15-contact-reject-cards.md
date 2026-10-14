# 群候选 CONTACT / REJECT 卡片复核

> 上级：[前端审核台账](README.md) · [施工清单](../frontend-refactor-construction-checklist.md)
> 相关：[交付与验收](../2026-10-15-sourcing-contact-reject-delivery.md) · [卡片渲染门禁](../2026-09-12-feishu-card-render-gate.md)

## 范围与证据

本次只修改正式飞书候选结果卡的“不合适”确认文案、长期排除后的撤销小卡及结果卡的排除过滤；联系方式按钮仍在原位置，后端回执统一为六态。正式构建函数是 `candidate-card-actions.js`、`candidate-decision-card.js` 和 `sourcing-result-card.js`，没有建立第二套 Storybook 演示组件。

审核稿使用本地脱敏场景 `candidate-reject-followup`、`candidate-restore-followup`、`supermai-freeform-badges`，已查看两张小卡截图。自动化验证按钮取消不写、确认后顾问级排除、撤销、原群回执发送失败说明、外部结果再过滤及群内投影安全。对应 commit 以包含本文档的提交为准。

## 五项状态

| 维度 | 当前结论 |
|---|---|
| Storybook | 不适用；这是飞书原生卡，使用卡片渲染门禁 |
| 用户审核 | 未审核新卡视觉与真机动作 |
| 正式接入 | 已接入本地正式构建函数、项目及自由找人工具 |
| 目标环境发布 | 未发布，待合并与部署证据 |
| 真实数据验证 | 未验证；仅脱敏夹具与本机截图 |

允许接入入口仅为现有项目候选卡和自由找人候选卡；字段只使用本人身份、候选稳定编号、姓名和本人决策记录。后端依赖为 `candidate_search_feedback`、`freeform_candidate_decisions`、`context_registry_entries`、本人 TTC 凭证和飞书私聊/发卡权限。验收必须分别覆盖确认/取消、撤销、跨顾问、无凭证、无简历、私发成功/失败、缓存命中/过期；无真实证据前不得勾选“已验证”。

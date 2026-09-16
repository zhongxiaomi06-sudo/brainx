# Offer 决策群单报告与编辑稿问答复核（2026-09-16）

> 上级入口：[前端审核台账](README.md)
>
> 功能规格：[候选人 Offer 决策报告](../2026-09-10-candidate-offer-report.md)

## 审核身份

- 审核日期：2026-09-16
- Storybook 场景：不适用；原生飞书卡片由卡片渲染门禁覆盖
- 对应 commit：本轮 `fix(报告)` 原子提交
- 审核范围：Offer 决策群首卡、单一报告生命周期、人工编辑稿读取和群内问答

## 用户结论

- 已确认：只生成一份报告，不重复发送 V1–V5；报告可人工修改；机器人能读取修改后的正文并继续对话。
- 未确认：手机端布局；长文档超过 500 个块时的真实租户分页表现。
- 正式接入授权：允许，限定候选人 Offer 决策群。

## 数据与动作边界

- 真实字段：当前决策群绑定、候选事实、来源上下文、唯一飞书 `document_id` 与实时文档块正文。
- 缺失字段：生产群普通未 @ 消息仍不由报告读取接口补采；本轮不启动第二条飞书 WS 连接。
- 后端依赖：`brainx_candidate_report`、飞书 Docx 创建/块列表/追加接口、现有 Agent Gateway 群权限。
- 允许动作：按钮首次生成；旧更新动作仅在原文档追加新证据；`/report` 和自然语言问题只读当前正文。

## 状态证据

- 正式入口：`src/candidate-report.js`、`src/feishu-document.js`、`plugins/brainx-openclaw/prompt.js`。
- 发布环境与版本：待部署后补记。
- 自动验证：专项测试覆盖首次创建、重复生成幂等、编辑稿读取、联系方式脱敏、原文档追加和不重复发卡；飞书卡片渲染基线待一并提交。
- 真实数据验证：待在用户截图对应的 Offer 决策群编辑现有报告并 @机器人提问后补记。

## 未完成项

- [ ] 部署 Agent Gateway 与 BrainX OpenClaw 插件 1.4.17。
- [ ] 真机编辑现有报告加入唯一测试句，再 @机器人提问并核对回答。
- [ ] 确认问答后没有新增报告文档或报告卡。

## 相关文档

- [候选人 Offer 决策报告](../2026-09-10-candidate-offer-report.md)
- [内部 Storybook 组件库](../storybook-component-library.md)
- [前端真实数据重构施工清单](../frontend-refactor-construction-checklist.md)

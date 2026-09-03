# 飞书卡片 HTTPS 深链接入记录

> 上级入口：[前端审核台账](README.md)

## 审核身份

- 审核日期：2026-09-03
- Storybook 场景：复用 `JobDetailCard`、完整工作台和真实数据入口三态；本次没有新增视觉组件
- 对应 commit：`feat(cards): 接通受控 HTTPS 对象深链`
- 审核范围：飞书职位卡、候选推荐卡、变化提醒卡与正式工作台入口

## 用户结论

- 已确认：用户要求卡片“点开之后就能打开主页面去查询”，并授权完成后进入正式软件，不继续作为影子功能。
- 未确认：目标环境中手机飞书、另一台电脑浏览器的最终跳转和视觉仍待真实验收。
- 正式接入授权：允许；限定为只读对象深链和候选查询预填，不允许 URL 携带身份或直接写业务状态。

## 数据与动作边界

- 真实字段：`project_id`、`decision_id`、脱敏 `candidate_ref`。
- 缺失字段：没有在 URL、卡片或浏览器端提供 tenant、consultant、open_id、联系方式、简历原文或权限 scope。
- 后端依赖：`BRAINX_BASE_URL` 必须是 HTTPS；工作台 API 继续验证 HttpOnly 飞书登录会话和对象可见性。
- 允许动作：打开授权职位详情、打开本人回放、预填候选匹配问题；深链自身不授予权限、不触发发送或业务写入。

## 状态证据

- 正式入口：`src/push.js`、`src/candidate-shortlist-card.js` → `frontend/btex-frontend/app/workbench.tsx`。
- 发布环境与版本：未发布；等待本批 ECS 部署。
- 自动验证：HTTPS 基址、对象编码、危险协议、身份参数缺失、候选卡片和工作台解析专项通过；快速门禁通过。
- 真实数据验证：尚未在目标环境用真实飞书卡片验证，只能记为部分验证。

## 未完成项

- [ ] ECS 发布后从 Mia 飞书私聊点击职位与候选卡。
- [ ] 用另一台未安装 OpenClaw 的电脑登录飞书后点击同一卡片。
- [ ] 未登录、无职位权限和他人回放分别得到登录提示或不可见结果。

## 相关文档

- [前端真实数据重构施工清单](../frontend-refactor-construction-checklist.md)
- [内部 Storybook 组件库](../storybook-component-library.md)

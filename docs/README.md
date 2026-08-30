# BrainX 文档书

> 上级入口：[多 Agent 协作准则](../AGENTS.md)

这里是仓库文档的统一入口。任何 Agent 读完根目录 `AGENTS.md` 后，都必须先到这里判断本次任务需要阅读哪些文档，不得在不了解相关约束时直接修改代码。

## 所有任务的固定阅读顺序

1. [多 Agent 协作准则](../AGENTS.md)
2. 本文档总目录
3. [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)
4. 下表中与当前任务匹配的专项文档

## 任务阅读路由

| 任务类型 | 必读文档 |
|---|---|
| 产品范围、功能规划或验收标准 | [BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md) |
| 最终产品形态、跨前后端施工顺序或总体验收 | [BrainX 最终交付蓝图与施工总清单](brainx-final-delivery-blueprint.md) |
| 任何代码、测试或配置改动 | [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)、[质量门禁操作手册](standards/QUALITY_GATE_OPERATIONS.md) |
| 前端组件、视觉状态或交互样例 | [内部 Storybook 组件库](storybook-component-library.md)、[上传前完整验证](standards/PRE_PUSH_VERIFICATION.md) |
| 前端审核、Storybook 确认、正式接入或发布状态 | [前端审核台账](frontend-reviews/README.md)、[内部 Storybook 组件库](storybook-component-library.md) |
| 前端信息架构、页面流程或交互重构 | [前端交互架构](frontend-interaction-architecture.md)、[推荐队列与职位决策产品架构](recommendation-queue-product-architecture.md)、[BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md) |
| 精选盘、推荐队列、推荐卡片或加入项目闭环 | [推荐队列与职位决策产品架构](recommendation-queue-product-architecture.md)、[前端审核台账](frontend-reviews/README.md) |
| 推荐算法、评分口径或学习排序规划 | [BrainX 岗位推荐算法与评分标准](BrainX岗位推荐算法与评分标准.md)、[推荐队列与职位决策产品架构](recommendation-queue-product-architecture.md) |
| 前端重构排期、施工范围或阶段验收 | [前端真实数据重构施工清单](frontend-refactor-construction-checklist.md)、[前端交互架构](frontend-interaction-architecture.md) |
| TTC 职位字段、筛选能力或字段变化 | [TTC 职位字段库](ttc-field-catalog.md)、[BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md) |
| Commit、协作记录 | [Agent Commit 记录](AGENT_COMMIT_LOG.md) |
| 密钥、登录、权限、数据隔离 | [安全操作手册](SECURITY.md) |
| 构建、发布、服务器、容器 | [部署编排](DEPLOYMENT.md)、[云端恢复清单](cloud-recovery-checklist.md)、[安全操作手册](SECURITY.md) |
| 验证历史行为或已有能力 | [开发验证报告](VERIFICATION.md) |
| 飞书多维表格或数据隔离 | [标准字段与云端隔离](2026-08-10-bitable-standard-fields-and-cloud-isolation.md) |
| CRM 批量导出设计 | [CRM 批量导出提案](crm-batch-export-proposal.md) |
| 带宽监控与告警 | [带宽告警说明](guard-bandwidth-alert.md) |
| 网站问题回溯 | [网站完整任务错误点审计](2026-08-17-网站完整任务错误点审计.md) |
| 代码质量整改、门禁或前端测试 | [质量门禁与前端链路测试审计](audits/2026-08-26-quality-gate-frontend-test-audit.md)、[DeepSeek 审查规则提炼](audits/2026-08-24-deepseek-review-rule-extraction.md)、[上传前完整验证](standards/PRE_PUSH_VERIFICATION.md) |

如果任务同时命中多个类型，必须阅读所有对应文档。找不到对应文档时，先检查代码和已有资料；若该主题会形成长期规则或决策，应先建立文档并把它加入本目录。

## 文档书目录

### 工作规范

- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)：所有 Agent 的统一验收清单。
- [质量门禁操作手册](standards/QUALITY_GATE_OPERATIONS.md)：统一命令、机器配置、存量基线、报告和 CI 维护方法。
- [Agent Commit 记录](AGENT_COMMIT_LOG.md)：每次提交的中文摘要与验证结果。

### 安全与运维

- [安全操作手册](SECURITY.md)：密钥、RDS、授权与数据隔离操作。
- [部署编排](DEPLOYMENT.md)：生产 systemd、本地开发、隔离 Docker 测试和 CI。
- [云端恢复清单](cloud-recovery-checklist.md)：现网唯一入口、标准恢复步骤与历史事件。
- [带宽告警说明](guard-bandwidth-alert.md)：带宽监控与告警规则。

### 设计与数据

- [BrainX 最终交付蓝图与施工总清单](brainx-final-delivery-blueprint.md)：基于当前代码审计定义最终产品形态、黄金路径、跨前后端施工顺序和端到端验收。
- [前端审核台账](frontend-reviews/README.md)：前端审核、正式接入、发布与真实数据验证状态的唯一权威入口。
- [前端交互架构](frontend-interaction-architecture.md)：BrainX 页面分层、状态诚实性和核心用户动作链。
- [推荐队列与职位决策产品架构](recommendation-queue-product-architecture.md)：完整200条推荐队列、20条分页、决策分层、卡片字段、动作闭环与全部职位进入详情规则。
- [BrainX 岗位推荐算法与评分标准](BrainX岗位推荐算法与评分标准.md)：当前 `baseline-1.1` 六维确定性评分、前端口径、验收标准与未来学习排序路线。
- [完整推荐队列排序复核](frontend-reviews/2026-08-30-recommendation-sort.md)：推荐优先级、最近活动、事实可信度三种服务端排序及游标稳定性证据。
- [精选盘评分与队列视图整改](frontend-reviews/2026-08-30-pick-board-score-views.md)：评分参考恢复、五种完整队列视图、数据来源筛选删除及命名收口证据。
- [精选盘卡片删除判断摘要区复审](frontend-reviews/2026-08-30-pick-card-remove-assessment.md)：列表卡片删除理由、风险、事实可信度与更新时间区，并保留详情数据边界。
- [全部职位详情真实评分栏目审核](frontend-reviews/2026-08-31-job-detail-real-score.md)：旧版评分形式复用、真实六维冻结评分映射和缺失值边界。
- [职位详情栏目切换尺寸复审](frontend-reviews/2026-08-31-job-detail-stable-size.md)：固定紧凑弹窗、内部滚动与底部动作尺寸回归。
- [职位详情放大与固定操作区复审](frontend-reviews/2026-08-31-job-detail-expanded-shell.md)：桌面卡片放大、五栏目固定框架和已加入项目忽略入口证据。
- [精选盘排序、详情动作与项目忽略复审](frontend-reviews/2026-08-31-sort-detail-project-ignore.md)：排序请求恢复、详情动作精简和待开始项目忽略闭环。
- [忽略状态后端收口复审](frontend-reviews/2026-08-31-ignore-state-backend.md)：取消关注/暂不考虑状态，统一持久忽略事实、历史迁移和跨列表排除证据。
- [主导航顺序调整复审](frontend-reviews/2026-08-30-main-navigation-order.md)：记录“我的项目”紧跟“精选盘”的正式外壳、审核稿与回归证据。
- [前端真实数据重构施工清单](frontend-refactor-construction-checklist.md)：TTC 主表、推荐策略、方向画像、导航设置与质量门禁的分阶段实施及审核边界。
- [内部 Storybook 组件库](storybook-component-library.md)：生产组件的隔离展示、交互测试与维护规则。
- [BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md)：产品定位、功能范围、已知问题、路线图与验收指标。
- [TTC 职位字段库](ttc-field-catalog.md)：TTC 字段语义、默认职位表列、筛选能力与覆盖率规则。
- [标准字段与云端隔离](2026-08-10-bitable-standard-fields-and-cloud-isolation.md)
- [CRM 批量导出提案](crm-batch-export-proposal.md)

### 验证与审计

- [开发验证报告](VERIFICATION.md)
- [统一职位详情正式接入审核记录（2026-08-28）](frontend-reviews/2026-08-28-job-detail-unification.md)
- [现代职位工作区正式接入审核记录（2026-08-28）](frontend-reviews/2026-08-28-jobs-workspace-integration.md)
- [推荐队列与职位卡片 V2 产品架构审核记录（2026-08-28）](frontend-reviews/2026-08-28-recommendation-queue-v2.md)
- [推荐队列 V2 紧凑布局复审记录（2026-08-28）](frontend-reviews/2026-08-28-recommendation-queue-v2-density.md)
- [推荐队列 V2 卡片位置复审记录（2026-08-28）](frontend-reviews/2026-08-28-recommendation-queue-v2-placement.md)
- [推荐队列 V2 视觉重做复审记录（2026-08-28）](frontend-reviews/2026-08-28-recommendation-queue-v2-visual-reset.md)
- [删除今日决策概览区审核记录（2026-08-28）](frontend-reviews/2026-08-28-remove-today-overview.md)
- [删除批量接单审核记录（2026-08-28）](frontend-reviews/2026-08-28-remove-batch-accept.md)
- [加入我的项目闭环正式接入记录（2026-08-29）](frontend-reviews/2026-08-29-add-to-projects-closure.md)
- [加入项目动作反馈与真实数据复核（2026-08-30）](frontend-reviews/2026-08-30-project-action-feedback.md)
- [跟进操作区与暂不考虑确认层复核（2026-08-30）](frontend-reviews/2026-08-30-engagement-action-layout.md)
- [完整推荐队列搜索修复复核（2026-08-30）](frontend-reviews/2026-08-30-recommendation-search.md)
- [现代职位工作区搜索与筛选修复复核（2026-08-30）](frontend-reviews/2026-08-30-jobs-search-filter.md)
- [决策轨迹时间顺序复核（2026-08-30）](frontend-reviews/2026-08-30-decision-trail-order.md)
- [高频自动推荐与决策轨迹膨胀审计（2026-08-30）](audits/2026-08-30-recommendation-event-growth.md)
- [网站完整任务错误点审计](2026-08-17-网站完整任务错误点审计.md)
- [状态报告（2026-08-19）](status-report-2026-08-19.md)
- [DeepSeek 审查规则提炼（2026-08-24）](audits/2026-08-24-deepseek-review-rule-extraction.md)
- [质量门禁与前端链路测试审计（2026-08-26）](audits/2026-08-26-quality-gate-frontend-test-audit.md)

## 新文档规则

以下内容不能只存在于聊天、commit message 或 Agent 记忆中，必须形成或更新 Markdown 文档：

- 工作流程和协作规则；
- 架构、接口、数据模型和重要技术决策；
- 安全、权限、密钥、部署和运维方法；
- 非代码配置的用途、风险和修改方法；
- 会影响未来协作者判断的重要调查、审计或故障结论。

每篇新文档必须：

1. 在开头链接本总目录或更具体的上级目录；
2. 说明适用场景、规则或结论、验证方法；
3. 在文末链接相关文档；
4. 登记到本目录的任务路由和文档书目录；
5. 避免复制其他文档的完整规则，改用链接指向唯一权威来源。

## 相关入口

- [仓库说明](../README.md)
- [快速开始](../QUICKSTART.md)
- [多 Agent 协作准则](../AGENTS.md)

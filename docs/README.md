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
| 任何代码、测试或配置改动 | [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)、[质量门禁操作手册](standards/QUALITY_GATE_OPERATIONS.md) |
| Commit、协作记录 | [Agent Commit 记录](AGENT_COMMIT_LOG.md) |
| 密钥、登录、权限、数据隔离 | [安全操作手册](SECURITY.md) |
| 构建、发布、服务器、容器 | [部署编排](DEPLOYMENT.md)、[云端恢复清单](cloud-recovery-checklist.md)、[安全操作手册](SECURITY.md) |
| 验证历史行为或已有能力 | [开发验证报告](VERIFICATION.md) |
| 飞书多维表格或数据隔离 | [标准字段与云端隔离](2026-08-10-bitable-standard-fields-and-cloud-isolation.md) |
| CRM 批量导出设计 | [CRM 批量导出提案](crm-batch-export-proposal.md) |
| 带宽监控与告警 | [带宽告警说明](guard-bandwidth-alert.md) |
| 网站问题回溯 | [网站完整任务错误点审计](2026-08-17-网站完整任务错误点审计.md) |
| 代码质量整改或审查规则 | [DeepSeek 审查规则提炼](audits/2026-08-24-deepseek-review-rule-extraction.md)、[上传前完整验证](standards/PRE_PUSH_VERIFICATION.md) |

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

- [BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md)：产品定位、功能范围、已知问题、路线图与验收指标。
- [标准字段与云端隔离](2026-08-10-bitable-standard-fields-and-cloud-isolation.md)
- [CRM 批量导出提案](crm-batch-export-proposal.md)

### 验证与审计

- [开发验证报告](VERIFICATION.md)
- [网站完整任务错误点审计](2026-08-17-网站完整任务错误点审计.md)
- [状态报告（2026-08-19）](status-report-2026-08-19.md)
- [DeepSeek 审查规则提炼（2026-08-24）](audits/2026-08-24-deepseek-review-rule-extraction.md)

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

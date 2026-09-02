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
| BrainX×reloop 工作流总线、身份、Case 或跨系统桥接 | [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) |
| 全景架构、技术施工安排、分步代码逻辑或组件选型 | [全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md)、[Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) |
| 开源组件复用、自建边界或权限最小集 | [复用与自建边界及权限需求 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md)、[全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md) |
| spec-kit、规格驱动开发或 constitution 修订 | [规范驱动研发流程](standards/SPEC_DRIVEN_WORKFLOW.md)、[多 Agent 协作准则](../AGENTS.md) |
| 参考代码镜像、开源仓库学习或外部设计对照 | [参考代码本地镜像清单](standards/REFERENCE_REPOS.md)、[全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md) |
| 飞书群聊工作流、BrainTex 机器人、事件/卡片回调或信息鉴权分工 | [BrainTex 群聊工作流技术 PRD](prd-2026-09-01-braintex-group-workflow.md)、[Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) |
| OpenClaw 壳子、Skill 编写、飞书渠道接入或外部 Agent 边界 | [OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md)、[复用与自建边界及权限需求 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md) |
| DataClaw 交流会索取清单、接口谈判或外部 Agent 边界 | [OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md)、[DataClaw 集成交流会历史底稿](2026-09-02-dataclaw-integration-brief.md) |
| **BrainX 下游交付、MCP server 工具契约、接口打包或部署** | **[BrainX 下游交付文档](2026-09-02-brainx-mcp-deliverable.md)**（用户职责边界内）、[OpenClaw 壳子架构 §6 接口挂载](2026-09-02-openclaw-shell-architecture.md) |
| **后端侧有哪些模块、各自什么状态、下一步做什么（不负责 OpenClaw 接口）** | **[后端侧模块结构与下一步安排](2026-09-02-backend-module-structure.md)**（六层结构 + 已建成/待补对照 + 9/3 排期）、[下游交付文档](2026-09-02-brainx-mcp-deliverable.md) |
| **群消息怎么提炼成 job_facts、信息抽取开源组件选型或抽取层排期** | **[群消息 → job_facts 提炼层研发路径](2026-09-02-job-facts-extraction-roadmap.md)**（开源调研综合 + 挂账本消费者的架构 + E0-E4 时间线）、[后端侧模块结构 §3 待补第 5 项](2026-09-02-backend-module-structure.md) |
| **给 OpenClaw 侧打包对接信息、MCP 接入配置、consultant_id 映射规则或 Skill 交付** | **[BrainX → OpenClaw 接口包](2026-09-02-openclaw-interface-pack.md)**（三接缝一屏 + 15 工具快照 + 交付包清单）、[下游交付文档](2026-09-02-brainx-mcp-deliverable.md) |
| **群消息读取归谁（OpenClaw 还是后端）** | **[后端侧模块结构 §1 边界裁定](2026-09-02-backend-module-structure.md)**（**关键纠正：通道层 `src/gateway/ws-client.js` 已在后端仓库建成，不依赖 OpenClaw**）、[飞书权限清单 §6.1](2026-09-02-feishu-permission-scopes.md) |
| **飞书后台要勾选哪些权限/scope、事件订阅、敏感权限审批** | **[飞书权限清单（9/2 研发对齐会定论版）](2026-09-02-feishu-permission-scopes.md)**、`src/oauth.js` 用户身份 scope 实证注释 |
| **这个架构承担哪些业务工作、每段业务走哪个工具** | **[业务工作全景](2026-09-02-business-work-breakdown.md)**（全链路六段 + MVP 每日循环 + 权限对照）、**[AI leader 工作流 + 日历助手](2026-09-02-ai-leader-workflow.md)**（一面前后两种形态）、[Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) |
| **一面之前怎么串联 AI leader 工作流 / 一面之后的待办提醒** | **[AI leader 工作流 + 日历助手](2026-09-02-ai-leader-workflow.md)**、`src/scheduler.js` `src/engagement.js` `src/push.js` |
| **某个工具能不能外露给 OpenClaw / 生成 Skill** | **[工具外露白名单（全量）](2026-09-02-tool-exposure-whitelist.md)**、[OpenClaw 壳子架构 §5.2](2026-09-02-openclaw-shell-architecture.md) |
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
- [规范驱动研发流程](standards/SPEC_DRIVEN_WORKFLOW.md)：spec-kit（specify CLI）的接入、单功能规格流程、与 AGENTS.md/constitution 的分工。
- [参考代码本地镜像清单](standards/REFERENCE_REPOS.md)：5 个经核实的参考仓库本地快照位置（仓库外 brainx-refs/）、学习用途与禁止复制规则。
- [Agent Commit 记录](AGENT_COMMIT_LOG.md)：每次提交的中文摘要与验证结果。

### 安全与运维

- [安全操作手册](SECURITY.md)：密钥、RDS、授权与数据隔离操作。
- [部署编排](DEPLOYMENT.md)：生产 systemd、本地开发、隔离 Docker 测试和 CI。
- [云端恢复清单](cloud-recovery-checklist.md)：现网唯一入口、标准恢复步骤与历史事件。
- [带宽告警说明](guard-bandwidth-alert.md)：带宽监控与告警规则。

### 设计与数据

- [OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md)：以 OpenClaw 为壳子、自写 Skill 包住官方数据接口的新架构（取代原 DataClaw 集成方案）。含开源工具与飞书渠道接入步骤、7 个现有 SKILL.md 的合规实测、接口挂载的 MCP 与 scripts 两条路径、留痕双轨决策、交流会"抄作业"索取清单。
- [DataClaw 集成交流会历史底稿](2026-09-02-dataclaw-integration-brief.md)：9/2 交流会的原始索取清单与风险列表。**架构结论已被上一条取代**，不得据此施工。
- [飞书权限清单（9/2 研发对齐会定论版）](2026-09-02-feishu-permission-scopes.md)：依据 9/2「研发对一下」妙记，把会议定的 MVP 能力映射成飞书后台要勾选的精确 scope 与事件。含应用身份 7 项（可批量导入 JSON）、用户身份 9 项、**「拉机器人进群 ≠ 能读群消息」的认知纠正**、三条待审批敏感权限与人才库并行方案。**9/2 晚新增 §6.1「群主邀请机器人入群」低敏感路径**——York 作为团队长拉机器人入群即可群维度读消息，把高敏感权限降级为兜底方案。
- [业务工作全景](2026-09-02-business-work-breakdown.md)：这个架构到底承担哪些业务工作。猎头全链路六段（职位录入→接单→推荐→面试→offer→入职）逐段标注现状/承担者/工具/权限，**指出 offer 谈判段是数据盲区**；**9/2 晚新增 §1.5「York 团队实证」**（团队结构、现行 8 个 DataClaw 定时任务、7 个在跑 Offer 项目 + Wendy 名下 11 个群压力面）；MVP 每日七步循环（推 10 岗→确认→后台找人→结果推送→接受或回流→下一轮→群内报备）；支撑类工作（群信息提炼、目标检查、数据验算）；权限档位 × 业务工作对照（**MVP 主循环 + 80% offer 群只依赖低敏感权限**，York 群主邀请路径覆盖）。
- [AI leader 工作流 + 日历助手](2026-09-02-ai-leader-workflow.md)：**一面是产品形态的分界线**——一面之前是 AI leader 主动串联推进，一面之后是日历助手只做「你什么活没干」的提醒。含前半段逐环节现状审计（**发现约面/一面在 `src/` 与 migrations 中零命中，从未被建模**）、串联触发链（含 **9/2 晚 York 群主邀请路径把 ① 段高敏感卡点降级**）、后半段现有家底清单（`scheduler.js` 早晚两次调度 + `commitmentSummary` 的 `need_action_count` 待办判断 + `push.js` 卡片 **均已建成且在跑**）、还缺的三件事（**待办提醒卡**、`next_action` 是硬编码占位符、弹窗时机）。落地顺序建议：**先做后半段 2 天出效果，再做接单自动找人 1 天，最后才碰约面/一面建模**。
- [工具外露白名单（全量）](2026-09-02-tool-exposure-whitelist.md)：挂在 OpenClaw 前哪些工具能外露的唯一权威。含**两套工具集纠正**（registry 15 个与 MCP server 15 个交集仅 8 个，此前被混为一谈）、**MCP 独有 7 个写操作补审**（`brainx_sync_now` 默认 `source='fixture'`+`dry_run=false` 会把决策库刷成测试数据，比 `brainx_talent` 的隐私泄漏更致命）、合并后的最终白名单表、防止再漏守门的测试与 checklist。
- [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md)：BrainX、reloop、TTC、飞书与 OpenMai 的身份纠错、Case 状态机、持久事件、Saga、隐私和施工顺序。
- [BrainTex 群聊工作流技术 PRD](prd-2026-09-01-braintex-group-workflow.md)：群聊驱动的最终信息架构、五信任域、事件与卡片回调、内外部安全视图、P0-P3 权限模型、鉴权模块实现归属与上线门禁。
- [全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md)：全本机规范收拢后的完整业务架构、四进程技术拓扑、9 张新表、分步代码逻辑（Step 0-7）与开源组件选型结论，附 §9.2 逐仓核实修订。
- [复用与自建边界及权限需求 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md)：每步"直接可用/借鉴/必须自建"三色清单、七件自建件、飞书权限最小集与明确不采用清单。
- [AI Native 猎头工作流架构图](design/architecture-workflow.html)：面向业务与 York 的三泳道主循环、人工边界、缺口和数据沉淀视图，附 2026-09-01 施工现状对照。
- [AI Native 猎头技术架构图](design/architecture-tech.html)：面向研发的五层架构与 BrainX、reloop 三套桥接施工视图，附 2026-09-01 施工现状对照与桥 1 门禁现状。
- [OpenClaw 壳子分层架构图](design/openclaw-shell-architecture.svg)：[OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md) §3 的可视化版本——飞书渠道 → OpenClaw Gateway → Skill 层 / MCP 层 → BrainX 领域权威层，标注 7 个已合规 Skill 与 3 个 MCP server。同目录提供 PNG 版 `openclaw-shell-architecture.png`（1360×1332，白底），可直接用于交流会与演示材料。
- [BrainX 下游交付文档（用户职责边界内）](2026-09-02-brainx-mcp-deliverable.md)：把 BrainX 决策库/人才库/reloop/官方接口以 MCP server 形式交付给 OpenClaw 侧。**责任边界**：用户只管工具集、接口契约、数据源读写、打包部署、环境凭据；OpenClaw 侧负责 Skill 编写、飞书渠道、open_id↔consultant_id 映射、Gateway 配置。含 15 个已暴露工具清单、JSON-RPC 2.0 协议、数据源现状、P0/P2 推进计划与红线。
- [后端侧模块结构与下一步安排](2026-09-02-backend-module-structure.md)：用户 9/2 晚明确边界「openclaw 的接口我不负责，我只负责后端其他点」后的**后端侧权威结构**。§1 **边界裁定**：群消息读取拆三段——①飞书后台配置（你手动）②**通道层 `src/gateway/ws-client.js` 已在后端仓库建成（118 行完整实现，非骨架，不依赖 OpenClaw）**③OpenClaw 插件只负责前台对话。**关键纠正：能读群消息的那条通道本来就在后端，OpenClaw 挂了不影响收消息**。§2 六层结构（L0 飞书网关 / L1 事件账本 / L2 领域数据 / L3 业务领域 / L4 调度推送 / L5 MCP 交付）。§3 已建成 vs 待补对照（**待补第 5 项「群消息提炼成业务字段」尚无代码，是 MVP ① 段缺的那一块**）。§4 今晚三件事 + 9/3 优先级。§5 与 OpenClaw 只有三个接缝。
- [群消息 → job_facts 提炼层研发路径](2026-09-02-job-facts-extraction-roadmap.md)：后端模块结构 §3 待补第 5 项的展开。**§2 开源调研综合**（google/langextract 原文锚定、instructor-js zod 约束重试、ai-delegator 先分类后抽取、open_recruiter 抽取确认分离、hiring-agent 双后端可切换、PaddleNLP UIE 中文兜底、dedupe/splink 实体对齐——共 5 大方向 12 个项目）。**§3 选型判断：借思想不引依赖，零新增运行时依赖**。§4 关键架构：**提炼层是 L1 事件账本的一个消费者**（`consumeOnce('job-extract')`，幂等与 DLQ 免费复用），规则层先行 + LLM 层（`AI_JOB_EXTRACT_ENABLED` 默认关）双层管线。§5 抽取 schema：每字段带 `evidence` 原文引用与置信度，staging 转正须确认。§6 时间线 E0-E4 共 2.5 天，对齐 9/3 demo 与 9/14 deadline。
- [BrainX → OpenClaw 接口包（模块化交付信息）](2026-09-02-openclaw-interface-pack.md)：用户指令「后端的结构我打包给对方模块化的信息」的**单一打包文档**。§1 三接缝一屏图 + 三条红线；§2 stdio MCP 接入配置模板 + 15 工具快照（含黑名单 `brainx_sync_now`/`brainx_talent`）+ 调用纪律；§3 consultant_id 身份映射规则（**后端不碰 open_id，映射权威在对方**；群消息通道与身份映射互不相干）；§4 Skill 素材交付与合规基线；§6 交付包清单。
- [AI Native 猎头全链路轨迹图](design/ai-native-headhunter-workflow.html)：环节级轨迹、人工/自动分工与证据来源的蒸馏工作稿，阶段三回填进行中。
- [双项目 14 天作战计划](design/week-plan-brainx-reloop.html)：BrainX × reloop 至 9/14 决赛的双泳道排期、底线条件与不做清单。
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

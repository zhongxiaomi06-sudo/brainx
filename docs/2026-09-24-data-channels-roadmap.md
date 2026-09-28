# 数据渠道全景与接入路线规范

> 上级目录：[BrainX 文档书](README.md)
>
> 适用范围：BrainX **全部可用数据渠道**的盘点（含已接/未接）、每条渠道的最佳读取方式、接入优先级。现有链路怎么读、错位怎么防归 [数据读取链路与错位诊断规范](2026-09-24-data-reading-pipeline.md) 管；本文件管「还有哪些渠道、各自怎么接最合适」。
>
> 技能包来源：`~/Downloads/ttc-recruitment-skills.tar(1).gz`（解压阅读于 /tmp，40 文件 8 技能，2026-09-24 盘点）。

## 1. 渠道全景总表（唯一权威）

### 第一层：飞书侧（事件与协作数据）

| # | 渠道 | 拿什么 | 现状 | 最佳读取方式 |
|---|---|---|---|---|
| F1 | 网关 bot 事件流（小机器人） | 群消息实时（`lark_messages`，bot 在群才有） | ✅ 已接（W1） | 事件驱动；**bot 不在的群零数据**，拉 bot 进群即扩容渠道 |
| F2 | lark-cli 用户身份 | 群历史回填（bot 不在群的补读） | ✅ 已接（W2） | 人工分批；origin=backfill 隔离，不进时效指标 |
| F3 | Bitable 职位盘点 | 公司×职能×优先级盘点表 | ✅ 已接（W3，`bitable.js`） | 定时同步；按中文字段名解析，禁位置假设 |
| F4 | lark-cli 邮箱/日历/云文档 | 顾问邮件、日程、文档 | ⬜ 未接（飞书 connector 已具备） | 按需接入；先邮件（offer 沟通线索）后日历（面试事件） |

### 第二层：TTC 面板侧（顾问 JWT，`api.ttcadvisory.com`）——当前最大缺口

JWT 存 `ttc_tokens`（AES-GCM 加密），归顾问本人；mia/felix/york 的 token **2026-10-13 到期**，接新渠道前先确认续期。

| # | 域 | 接口族 | 拿什么（面板数据） | 现状 | 最佳读取方式 |
|---|---|---|---|---|---|
| T1 | 职位 | `/api/crm/v1/job/search`（`ttcsdk/job.js`） | 职位全量/增量 | ✅ 已接（W3 同步主通道） | 定时增量（searchSince）；任一有效 JWT 均可拉 |
| T2 | 客户公司 | `/api/crm/v1/company/search`（`ttcsdk/company.js`） | 客户公司名录 | ✅ 已接（浅） | 定时；company/batch 批量补详情 |
| T3 | 简历附件 | `/api/talent_store/v1/person_leads/resume/attachment/*`（`ttcsdk/resume.js`） | 候选人简历 PDF | ✅ 已接 | 按需（candidate_ref 触发），注意配额 |
| T4 | 配额/身份 | `/api/crm/v1/user/quota`、`/api/user_service/v1/login/user`（`ttcsdk/user.js`） | token 健康度、当前用户 | ✅ 已接 | 探活与 readiness 检查 |
| T5 | OpenMai 找人 | `gateway.ttcadvisory.com`（`openmai-task.js`） | 按职位查候选人 | ✅ 已接（W5） | 任务驱动 + 结果轮询 |
| T6 | SuperMai sourcing | `app.ttcadvisory.com/app/sourcing/api/sourcing/v1`（`supermai-sourcing.js`） | sourcing 会话找人 | ✅ 已接（GUI 辅助） | 顾问本地载体触发，服务端不做定时 |
| **T7** | **Pipeline 流程** | `/api/pipeline_service/pipeline/list\|info\|log`、`sourcing/list\|count` | **候选人×职位流程进展（StepType：推荐/面试/Offer/入职；ActiveState：进行中/终止/完成）** | ✅ 已接（W8，2026-09-24 第一批：19,579 行/5,431 项目，`latest_step`+`status`+`active_state` 落 `ttc_pipeline_rows`） | **定时同步——`job_facts.current_stage` 的真值源**（档位塌缩 B6 根源的补全渠道）。⚠️ 行语义＝候选人×职位 flow（非职位级）：status/latest_step/active_state 都是候选人 flow 字段，写 job_facts 须职位级聚合；职位级 active_state 真值建议补接 T8 `project/list`。⚠️ `pipeline/list` 是**公司级共享池**（total≈20.9 万，任一 token 返回同一份行集），单 token 深翻页即可，禁止按顾问重复拉 |
| **T8** | **项目/任务** | `/api/pipeline_service/project/list\|info`、`project_ids_by_chat_id`、`task_service/current_user/task/*` | 项目状态、简历状态批量查、**当前用户任务列表（各自面板）**、进行中任务 | ◐ 部分接（W8：`task_service` 已落 1,394 行 `ttc_task_rows`）；`project/*`、`project_ids_by_chat_id` 未接 | 定时（每顾问 token 拉自己的 current_user 面）；`project_ids_by_chat_id` 可做飞书群↔TTC 项目对账 |
| **T9** | **CRM 联系人/备注** | `/api/crm/v1/contact/search`、`/api/crm/v1/note` | 客户联系人、跟进备注（活跃度信号） | ⬜ 未接 | 定时增量；客户健康度指标补客户侧动作数据 |
| **T10** | **人才库直连** | `/api/talent_store/v1/search`、`search/filters`、`person_leads/relation/*`、`operation_logs/list` | 关键词搜人才、人才关系范围、操作日志（触达行为） | ⬜ 未接 | **按需 agent 工具**（`brainx_openmai_search` 之外的直查通道，不占 OpenMai 配额）；操作日志可定时进客户画像 |
| **T11** | **名单/推荐报告** | `/api/talent_store/v1/customized_list/get`、`recommendation_report/list\|get` | 顾问「我的名单」、推荐报告（交付动作真值） | ⬜ 未接 | 定时（每顾问 token）；**outcomes 层交付证据**，比群消息抽取消息更硬 |
| T12 | 员工/组织 | `/api/user_service/v1/user/search`、`internal/user/batch` | 员工 ID 映射、组织关系 | ⬜ 未接 | 按需（开通/审计对账用） |

### 第三层：独立服务（独立鉴权，不走顾问 JWT）

| # | 渠道 | 拿什么 | 现状 | 最佳读取方式 |
|---|---|---|---|---|
| J1 | jobwater（`job-water.ttcadvisory.com`，x-api-key） | 职位表结构（describe_job_table）、**全量职位数据查询**（query_jobs：列筛选/全文/分组统计）、市场行情分析（ask_market_analyst）、机会评估（ask_opportunity_advisor） | ⬜ 未接 | 按需 agent 工具 + 市场分析定时报告；**key 在技能包 SKILL.md 内明文（jw_test_ 前缀测试 key），入库前必须先确认有效期并脱敏——key 不进 Git** |

### 第四层：GUI 浏览器（人工触发，服务端定时架构上做不到）

| # | 渠道 | 拿什么 | 现状 | 最佳读取方式 |
|---|---|---|---|---|
| G1 | LinkedIn RPS（已登录企业账号） | 海外候选人搜索/浏览/排序 | ⬜ 未接（技能包有完整操作文档） | 顾问本地 OpenClaw 载体执行；策略级原子化（单次一个搜索策略） |
| G2 | SuperMai（猎聘/脉脉 GUI） | 国内候选人触达 | ✅ 已定性（09-11 拍板：GUI 性质，本地载体） | 同上；WAF 30 分钟 cookie 决定不能服务端化 |

## 2. 技能包解读（tar 内 8 技能 → brainx 接入映射）

| 技能 | 内容 | 对应上表 | 接入动作 |
|---|---|---|---|
| `ttc-crm-pipeline` | Pipeline/项目/任务/通知/账单 API 全文档（5 reference） | T7/T8 | **P0**：pipeline 同步进 `src/ttcsdk/` 新模块 |
| `ttc-crm-crm` | 客户/职位/联系人/标签/备注/合同/飞书群聊 API | T1/T2/T9 | P1：contact/note 增量 |
| `ttc-crm-talent` | 人才搜索/档案/名单/推荐报告 API | T3/T10/T11 | P1：search 直连 + 名单/报告定时 |
| `ttc-crm-user` | TTC 内部员工服务（飞书通讯录同步、ID 映射） | T12 | P2：对账按需 |
| `ttc-crm-auth`（feishu-auth） | ottin-web 飞书统一授权登录 SDK（popup → postMessage token） | token 获取辅助 | 参考：未来「自助授权」形态可减少贴 JWT 运维 |
| `talent-search` | TalentStore 搜索完整指南（给其他 OpenClaw 实例） | T10 | 与 ttc-crm-talent 同源，采 ttc-crm-talent 权威 |
| `jobwater` | 职位数据与市场分析 Agent 服务 | J1 | P1：先 dry-run 探活 + 表结构摸底 |
| `linkedin-search-skill` | LinkedIn RPS 浏览执行助手（综合文案→策略→排序） | G1 | 按需，顾问本地 |

> 注意：技能包内 `ttc-crm-*` 接口文档标注「线上 `api.ttcadvisory.com` / 测试 `api-int.ttcadvisory.com`」双环境；brainx 只认线上（`BRAINX_TTC_API_BASE`），**测试环境数据不进生产库**。

## 3. 最佳读取方式分类（按触发模式）

| 模式 | 适用渠道 | 设计要点 |
|---|---|---|
| **定时同步**（daemon/worker） | T1/T2/T7/T8/T9/T11 | 幂等 upsert；行级校验只记 warnings 不判废整批（W3 纪律）；时间游标遵守 B 类红线（MySQL 本地墙钟/UTC ISO 不混用） |
| **按需 agent 工具**（OpenClaw/网关） | T10/J1 | kill-switch 控成本；结果落 `openmai_results` 同形结构或新表；配额先查 T4 |
| **事件驱动** | F1 | bot 在群 = 渠道在线；扩渠道动作 = 拉机器人进更多群 |
| **人工分批** | F2/G1/G2 | 顾问本地载体；产出物走回填链路（origin 隔离） |

## 4. 接入优先级（数据缺口 → 渠道的对应）

1. **P0：T7 Pipeline 同步**——档位塌缩（B6）的 `current_stage` 真值就在 `pipeline_service/pipeline/list`（StepType 四阶段 + ActiveState）。接通后 INSUFFICIENT 降档的字段缺失直接补上，**不是调阈值，是补数据**（与 specs/022 C 层方向一致）。
2. **P0.5：T8 任务面板**——`task_service/current_user/*` 每顾问 token 拉各自任务，顾问画像 v4 的行为数据从「卡片/接单推断」升级为「TTC 面板真值」。
3. **P1：T10 人才直连 + T11 名单/推荐报告**——outcomes 层交付证据（11 条 vs 群消息 16,993 条抽空的对照）；T11 是「顾问交付了什么」的硬数据。
4. **P1：J1 jobwater**——市场行情与职位表查询，先探活（dry-run）确认测试 key 有效性再定。
5. **P2：T9 联系人/备注、T12 员工、F4 邮件日历**——健康度指标与对账补充。

## 5. 安全与纪律红线

1. **JWT 生命周期**：mia/felix/york token 2026-10-13 到期；接 T7/T8 前先跑 `readiness --account`，到期前两周提醒续期（REAUTH_SOON_MS 已有 7 天预警，建议新渠道接入时同步校验）。
2. **key 不进 Git**：jobwater 的 x-api-key 只存 `/etc/brainx/*.env`（或本地 .env），文档、代码、commit message 一律不得出现。
3. **测试环境隔离**：`api-int.*` 只用于联调验证，测试数据不得写生产库。
4. **每顾问数据归每顾问**：T8/T11 的 current_user/我的名单类接口，**必须用本人 JWT 拉本人数据**（归属校验 `JWT_OWNER_MISMATCH` 同款纪律），禁止用 A 的 token 拉 B 的面板。
5. **新渠道接入即登记**：接通一条渠道 = 更新本表状态列 + 在[数据读取链路](2026-09-24-data-reading-pipeline.md)入料总表（W1-W7）加行，两个文档同 commit 更新。

## 相关文档

- [数据读取链路与错位诊断规范](2026-09-24-data-reading-pipeline.md)：现有链路 + 错位四类根源
- [数据结构与磁盘用途规范](2026-09-23-data-structure-and-disk-layout.md)：存储归属
- [冷启动规则 v2 与客户画像](2026-09-24-cold-start-rules-v2-profiles.md)：字段补全消费口径
- [安全操作手册](SECURITY.md)

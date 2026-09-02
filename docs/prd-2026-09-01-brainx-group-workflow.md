# BrainTex 群聊工作流技术 PRD（v1.0）

> 上级入口：[BrainX 文档书](README.md)
>
> 状态：目标方案 PRD，不承诺上线时间；阶段排期见[双项目 14 天作战计划](design/week-plan-brainx-reloop.html)
>
> 取代关系：本文档不推翻 [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md)的权威契约（身份、Case 状态机、事件账本、Saga 均沿用），只在其上定义**群聊交互层与权限层**，并把交互架构从"五层系统架构"修正为"群聊驱动的工作架构"。

## 0. 一句话架构

> 飞书负责"谁在什么群里做了什么动作"，BrainTex 负责"理解与编排"，BrainX/Workflow Hub 负责"这个人是否有权在当前状态做这件事"，外部安全视图负责"即使允许回答，也只能回答到什么程度"。

核心纪律：

1. **群是交互界面，不是数据库。** 权威业务状态永远只在 Workflow Hub；群里出现的任何数字都是投影。
2. **一个机器人对外说话。** 用户视角只有一个"BrainTex 飞书机器人"；飞书机器人是嘴和耳朵，BrainTex 是大脑和调度员，BrainX/Hub 是规则、记忆和账本，Codex 是工程师和后台执行器。不允许"飞书机器人"和"BrainTex 机器人"在群里分别说话。
3. **未登记的群默认拒绝。** 机器人不根据群名猜客户、职位或项目归属。
4. **BrainTex 不直接改库，Codex 不当在线权威执行者。** 一切写动作经领域守卫与人工确认。

## 1. 最终信息架构

```text
职位市场群 / 内部项目群 / 客户项目群 / 候选人私聊 / 管理群
                         │
              ① 飞书机器人 Gateway（嘴和耳）
       身份识别 · @消息 · 回复链 · 卡片 · 按钮 · 人工确认
                         │
              ② BrainTex Agent 大脑（理解与编排）
       意图识别 · 上下文组装 · 工作流编排 · 草稿生成
             ┌───────────┴───────────┐
             ▼                       ▼
   ③ BrainX / Workflow Hub      ④ 专业执行器
   权限 · 状态机 · 事件账本      OpenMai / LLM / Codex 受限任务
   Case · 幂等 · 审批 · 投影     （在授权信封内工作）
             │                       │
             ▼                       ▼
   BrainX 职位域        reloop 候选人域
             └──── Evidence Store ────┘
        （消息正文/简历/附件只存 evidence_ref）
```

主循环（架构图最应突出的一条线）：

```text
群里出现职位/反馈 → BrainTex 识别职位与 Case → BrainX 判断合法动作
→ AI 生成草稿或下一步建议 → 飞书卡片让人确认 → 领域服务执行并写事件
→ 结果回到原群、原线程、原卡片
```

### 1.1 群上下文结构化绑定

```text
open_id            → consultant_id / external_actor_id
chat_id            → chat_context（信任域 / client / project）
root_id 或 card_id → project_id / position_id
候选人卡片         → case_id
message_id         → evidence_ref
```

一个群里出现多个职位时，禁止按公司名猜归属；必须让用户回复职位卡片或从卡片按钮进入具体 `project_id / case_id`。

### 1.2 五类群（信任域）

| 信任域 | 典型场景 | 可出现的信息 |
|---|---|---|
| `INTERNAL_TEAM` | 内部职位群、交付群 | 职位、候选人、内部判断、风险、薪资、其他机会 |
| `EXTERNAL_CLIENT` | 含客户成员的项目群 | 经批准的候选人材料、公开进度、面试安排、客户反馈 |
| `CANDIDATE_PRIVATE` | 候选人与机器人单聊 | 本人 Case、推荐同意、面试辅导、本人 Offer 信息 |
| `MANAGEMENT` | 管理群 | 汇总数据、SLA、异常、资源分配；默认不展示完整 PII |
| （未登记） | 任何未知群 | `enabled=false`，`policy=DENY`，只记录进群事件 |

群注册表（最小字段，新增表 `chat_contexts`）：

```text
chat_contexts
├─ tenant_id, chat_id, trust_zone
├─ client_id, allowed_project_ids, allowed_case_ids
├─ bot_mode            -- 首版统一 MENTION_ONLY
├─ data_policy         -- INTERNAL / CLIENT_SAFE
├─ enabled             -- 默认 false
├─ verified_by, verified_at
```

## 2. 外部安全视图与披露清单

外部安全视图**不是把内部 Case 脱敏复制一份**，而是按"候选人同意 × 顾问批准"生成的白名单投影。

| | `case_context_internal` | `case_context_external` |
|---|---|---|
| 允许 | 完整简历与联系方式；真实动机；薪资底线与谈判空间；其他面试/Offer/竞争机会；内部评价与风险；找人渠道与策略；AI 判断与备注 | 客户当前职位信息；已获候选人同意的推荐内容；顾问批准的经历与能力证据；客户已知的面试阶段；双方确认的面试时间；客户自己提供的反馈；已批准发送的报告与附件 |

披露清单（新增表 `disclosure_bundles`）——外部视图只能从 `allowed_fields` 生成：

```text
disclosure_bundle_id, case_id, client_id
candidate_consent_id
allowed_fields[], allowed_documents[]
approved_by, approved_at, expires_at, revoked_at
```

候选人撤回同意 → 停止后续展示，不改写历史事件。

## 3. 事件入口

独立建立 `POST /api/v1/lark/events`，**只承担渠道安全，不做业务判断，不直接调用 LLM**。

处理顺序：

```text
1. 验证飞书签名与 Verification Token
2. 解密事件
3. 处理 URL challenge
4. 按 event_id / message_id 去重
5. 解析 tenant_key / open_id / chat_id / root_id
6. 查询 chat_contexts（未登记 → 只记录，不响应）
7. 识别内部成员或外部成员
8. 写入标准事件信封（消息正文进 Evidence Store，账本只存摘要 + evidence_ref）
9. 异步交给 BrainTex
10. 快速返回 HTTP 200
```

标准事件信封字段：

```text
event_id, event_type, tenant_key, app_id
chat_id, chat_scope, message_id, root_id, parent_id
actor_open_id, actor_tenant_key, actor_type
occurred_at, received_at, evidence_ref, idempotency_key
```

幂等规则：`message_id` 负责业务幂等；`event_id` 负责飞书投递去重；两者不可互相替代。

## 4. 卡片回调

独立建立 `POST /api/v1/card-actions`。**卡片按钮不能直接写业务状态。**

```text
用户点击卡片 → 验证回调 → 解析 operator → 校验能力令牌
→ 权限引擎判断 → 创建 command request → BrainX 领域守卫
→ 写业务事件 → 更新卡片
```

卡片 `value` 里**禁止**放：候选人联系方式、完整简历地址、用户角色、"是否管理员"等可信结论、可直接执行的数据库字段。只放短期**能力令牌**：

```text
capability_token
├─ subject_open_id, action, resource_type, resource_id
├─ chat_id, context_version
├─ expires_at, nonce, signature
```

回调四类结果：`ALLOW` / `DENY` / `REQUIRE_CONFIRMATION` / `REQUIRE_INTERNAL_APPROVAL`。外部客户点击需内部确认的操作时，外部卡片只显示"已记录，等待项目顾问确认"，然后在内部群生成审批卡。

## 5. 动作分类与内外隔离

| 类型 | 示例 | 执行规则 |
|---|---|---|
| 查询 | 看公开进度、本人项目 | 权限通过后直接返回 |
| 草稿 | 推荐报告、回复话术 | AI 生成，不产生外部效果 |
| 内部写入 | 接单、释放、记录进度 | 内部顾问显式确认 |
| 外部发送 | 推客户、联系候选人 | 候选人同意检查 + 顾问终审 |
| 高风险 | Offer、关闭、身份合并、删除 | 专属角色 + 二次确认 |

外部客户**允许**：`public_status.read`、`client_feedback.create`、`interview_slot.propose`、`client_question.create`、`report.view`、`document.request`。

外部客户**禁止**：`job.accept/release`、`candidate.search`、`candidate.internal_notes.read`、`submission.send`、`case.stage.force`、`offer.commit`、`case.close`、`identity.merge`、`knowledge.publish`。

内部顾问在**外部群**同样受限：接单/释放、改候选人内部阶段、Offer 记录、关闭 Case、查看内部风险与薪资底线，一律由机器人转入内部项目群或机器人私聊确认——避免操作过程本身向客户暴露内部信息。

客户反馈不直接推进 Case：先落 `client.feedback_received`，内部顾问确认后才产生 `case.stage_advanced`。

## 6. 权限模型

```text
最终权限 = 角色权限(RBAC) ∩ 资源关系 ∩ 群信任域 ∩ Case 状态守卫 ∩ 数据披露策略 ∩ 候选人同意
```

| 等级 | 动作 | 权限要求 |
|---|---|---|
| P0 查询 | 查职位、查本人项目、看下一步 | 群成员关系 + 资源可见性 |
| P1 内部记录 | 接单、释放、打标、记录反馈 | 本人身份 + 合法状态 + 显式确认 |
| P2 对外动作 | 联系候选人、推客户、发送报告 | Case 负责人 + 候选人同意 + 最终预览 |
| P3 高风险 | Offer 承诺、关闭、身份合并/拆分、删除、策略发布 | 特定角色，部分双确认 |

角色：`CONSULTANT / PROJECT_OWNER / MANAGER / DATA_STEWARD / EXTERNAL_CLIENT / CANDIDATE / SERVICE_AGENT`。

引擎输出五种：`ALLOW / DENY / ALLOW_WITH_REDACTION / REQUIRE_CONFIRMATION / REQUIRE_INTERNAL_APPROVAL`。`ALLOW_WITH_REDACTION` 是外部群的主形态：客户可以问进度，但机器人只能用外部安全视图回答。

所有写事件必须携带：`actor_open_id, consultant_id, chat_id, message_id|card_action_id, project_id/case_id, idempotency_key, confirmation_evidence, occurred_at`。**机器人服务账号本身没有业务决定权**，只能执行某个人明确授权的动作。

## 7. 权限数据结构（8 张表）

```text
actor_links          open_id ↔ consultant_id / external_actor_id
chat_contexts        chat_id ↔ trust_zone / client / project
resource_grants      actor/role ↔ project / case / action
action_policies      role + trust_zone + action → decision
approval_requests    requested_by / action / resource / status / approved_by
disclosure_bundles   候选人同意与允许披露字段（见 §2）
workflow_event_log   所有请求、批准、拒绝与执行结果（沿用权威契约 §6）
evidence_objects     消息、简历、附件、录音及访问控制
```

## 8. 职责分工与鉴权归属（谁写、谁审）

### 8.1 系统职责

| 模块 | 负责 | 不负责 |
|---|---|---|
| 飞书机器人 | 消息、卡片、身份、群上下文、回调、展示结果 | 业务状态与权限裁决 |
| BrainTex | 意图识别、上下文组装、草稿、编排、下一行动 | 直接改库、绕过审批 |
| BrainX/Hub | 权限、状态机、事件、幂等、审批 | 自由生成对外内容 |
| reloop | 候选人、简历、匹配、触达、submission | 职位承接权限 |
| Codex | 网关、权限引擎、投影、连接器、测试、回放 | 生产中直接发客户消息 |
| 人工顾问 | 事实核验、候选人同意、对外终审 | 系统身份与审计实现 |
| 数据管理员 | 身份合并/拆分、权限纠错、群启用 | 替顾问作业务判断 |

### 8.2 鉴权模块归属（重点）

原则：**严格鉴权的"实现"与"裁决权威"分离**——代码可以由 Codex 写，裁决逻辑必须落在 BrainX/Hub 侧并经人工评审；任何 LLM（含 BrainTex）不参与权限判断。

| 鉴权模块 | 实现者（写代码） | 裁决权威 | 验收审核 | 风险等级 |
|---|---|---|---|---|
| 事件网关（验签/解密/去重/challenge） | Codex | BrainX 服务端 | 数据管理员 + 安全评审 | 高 |
| `chat_contexts` 登记与启停 | Codex 写 CRUD | 管理员人工确认（verified_by 必填） | 数据管理员 | 高 |
| 权限引擎（action_policies 裁决） | Codex 实现、规则表由人评审 | BrainX 领域守卫 | 管理者 + 安全评审 | 最高 |
| `capability_token` 签发/校验 | Codex（签名密钥只存 BrainX 服务端 env） | BrainX | 安全评审 | 高 |
| `actor_links` 身份映射 | Codex 建映射，显式绑定 | 数据管理员纠错 | 数据管理员 | 高 |
| `disclosure_bundles` 生成与撤销 | Codex 写数据层 | 顾问人工批准（approved_by 必填） | 顾问 + 数据管理员 | 最高 |
| `case_context_external` 投影 | Codex 实现白名单投影 | BrainX 只从 allowed_fields 取数 | 顾问终审首份样本 | 最高 |
| 审批流（approval_requests） | Codex 写骨架 | 人工点击审批 | 管理者 | 中 |
| BrainTex 意图与草稿 | BrainTex（本仓库 agent loop 扩展） | 无裁决权，只建议 | 顾问逐条采纳 | 中 |
| 卡片回调入口 | Codex | 权限引擎输出决定 | 安全评审 | 高 |
| Evidence Store 访问控制 | Codex | BrainX data policy | 数据管理员 | 高 |

**严禁**：BrainTex 的 prompt 或工具层内嵌权限规则；卡片 value 自带角色结论；Codex 持有顾问长期令牌、直接监听全部群、绕过人工确认发客户消息、直接修改 P3 状态。Codex 若需运行时参与，必须由 BrainTex 创建受限任务信封：`task_id, actor, allowed_tools, allowed_case_ids, data_classification, expires_at, requires_approval`。

### 8.3 Codex 建设面清单

Workflow Hub 表结构与事件信封、状态机与权限策略实现；TTC/reloop/飞书/OpenMai 连接器；幂等、Saga、DLQ、回放、对账与测试；复杂推荐报告与批量数据整理等异步任务；诊断断点、分析失败事件；把 Felix/Miya 验证过的经验转成可执行知识规则。

## 9. 飞书平台权限安排

保留现有：`im:message.group_at_msg:readonly`、`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message:update`、`im:chat:read`、`im:chat.members:read`、`im:resource`、`cardkit:card:read`、`cardkit:card:write`。

外部群需开启应用能力："允许机器人被添加到外部群中使用"；如需客户/候选人单聊，另开"允许外部用户与机器人单聊" + `im:chat.access_event.bot_p2p_chat:read`。

**第一版不申请** `im:message.group_msg`（读取外部群全部消息的敏感权限）——只有明确决定机器人需要读取外部群全部消息时再申请。首版交互统一 `bot_mode = MENTION_ONLY`：外部群只处理 @机器人、回复机器人、卡片操作。

## 10. 现状差距（2026-09-01 代码审计）

| 目标能力 | 现状 | 差距 |
|---|---|---|
| 事件入口 `/lark/events` | 不存在；现靠 bridge.js 轮询"事实消息" | 全新建：网关 + chat_contexts + 信封 |
| 卡片回调 `/card-actions` | 无回调链路（现只私聊推卡跳 Web） | 全新建：回调 + capability_token |
| BrainTex 写动作 | `src/agent/persona.js` 明确严格只读 | 扩展写通道须经 §6 四级权限与领域守卫，先卡片确认后执行 |
| 接单触发找人 | `openmai-task.js` 已实现 ACCEPT 自动触发 | 上游可复用；缺 reloop 建岗（桥 1）与事件信封 |
| 群上下文绑定 | `job_message_visibility` 只做个人可见性 | 缺 chat_contexts、actor_links、卡片→case 绑定 |
| 外部安全视图 | 不存在 | 全新建：disclosure_bundles + 白名单投影 |
| 隐私边界 | bridge.js"不是群成员就看不到"、OAuth 最小权限 | 边界正确，作为新网关的既有约束沿用 |

## 11. 分阶段施工（不承诺上线时间，只定义验收）

| 阶段 | 范围 | 关键验收 |
|---|---|---|
| 一、权限与身份底座 | BrainTex 团队应用配置（外部群能力/卡片回调）；lark-cli 专用 profile；`actor_links` 重建；停用旧 Mia 应用 | 测试群发消息成功；@机器人有回执；无 `open_id cross app`；日志无完整 open_id/令牌/PII |
| 二、群消息与权限网关 | `/lark/events`、`/card-actions`、challenge/验签/去重、3 秒回调响应、chat_contexts + 待配置队列 | 未登记群 DENY；重复事件幂等；卡片回调 3 秒内响应 |
| 三、内部群先跑通 | `@BrainTex 今天优先做什么 / 查看这个职位 / 生成推荐草稿 / 记录客户反馈`；写动作走卡片确认 | 外部用户进不了内部上下文；重复点击不重复写入；非法状态返回明确原因；写动作带 actor + message_id |
| 四、外部测试群试点 | 仅三能力：公开进度查询（ALLOW_WITH_REDACTION）、客户反馈（落 `client.feedback_received`，不直接推进 Case）、面试时间记录 | 客户问内部信息时只得到外部视图答案；反馈需内部确认才推进阶段 |
| 五、内外部内容桥 | reloop 事实 → BrainTex 草稿 → 内部群终审 → 同意检查 → 外部投影 → 顾问点击发送 → `submission.sent` | 这条链全程走通才算"推人闭环打通"；撤回同意后停止展示 |
| 六、决赛版本 | 联排、真实用户演练、冻结代码 | 全部上线门禁通过 |

**门禁一票否决**：如果对外共享审核未通过，就只上内部群——不为时间表绕过外部群安全门禁。

## 12. 上线门禁（外部群启用前逐条核对）

- [ ] 对外共享版本已审核发布
- [ ] BrainTex 团队应用身份统一（actor_links 重建完成）
- [ ] 事件签名与回调验证通过
- [ ] 外部群已登记 `EXTERNAL_CLIENT` 并由管理员 `verified`
- [ ] 外部用户调用内部动作被 DENY（实测）
- [ ] `case_context_external` 白名单投影已实现并经顾问审样本
- [ ] 候选人 PII 默认不展示（实测客户群问"薪资底线"类问题）
- [ ] 推荐发送需候选人同意 + 顾问终审（实测撤回同意后停止展示）
- [ ] 重复消息、重复点击幂等（实测双击/重放）
- [ ] 真实外部成员完成一次完整演练
- [ ] 日志无完整 open_id、令牌、候选人 PII

## 13. 不做清单

- 第一版不读取外部群全部消息（不申请 `im:message.group_msg`）。
- 不做"两个机器人在群里说话"的架构。
- 不让 BrainTex/Codex 直接改库或绕过审批。
- 不为赶时间跳过外部群门禁。
- R7 PDF 简历、R10/R13 撞库互通：决赛后事项。

## 相关文档

- [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md)：身份、Case 状态机、事件账本、Saga 的权威契约
- [AI Native 猎头工作流架构图](design/architecture-workflow.html) · [技术架构图](design/architecture-tech.html)：待按本文档 §1 升级为"群聊驱动"视图（v2）
- [双项目 14 天作战计划](design/week-plan-brainx-reloop.html)：阶段排期与底线条件
- [AI Native 猎头全链路轨迹图](design/ai-native-headhunter-workflow.html)：环节级自动化分级
- [安全操作手册](SECURITY.md)：密钥、令牌与数据隔离操作
- [BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md)：产品功能范围

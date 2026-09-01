# Workflow Hub 与猎头全链路架构

> 上级入口：[BrainX 文档书](README.md)
>
> 配套视图：[工作流架构图](design/architecture-workflow.html) · [技术架构图](design/architecture-tech.html)
>
> 适用范围：BrainX、reloop、TTC、飞书、OpenMai 与招聘网站之间的身份、Case、事件和桥接契约

## 1. 结论

Workflow Hub 不是新的业务产品，也不是把所有数据复制进一个中央库。首版是在 BrainX 现有事件、同步、行动和结果表之上定义统一契约，再连接 reloop；各系统继续维护自己的权威事实。

全链路只有两条业务主轴：

1. **职位主轴**：职位验真 → 接单/释放 → 投入优先级 → 当前行动。
2. **人选 Case 主轴**：Mapping/找人 → 评估与同意 → 推给客户 → 面试 → Offer → 入职/关闭。

跨系统的唯一连接单位是 `case_id`，表示一个“职位 × 人选”的业务实例。一个职位可以同时拥有多个 Case，职位级状态不能替代人选级进展。

## 2. 素材边界与架构影响

### Felix v0.5

- 用户于 2026-09-01 明确确认该素材全部为本人确认内容，知识状态按 `CONFIRMED` 处理；14/14 个标准环节已覆盖，但“五维采全”完成度、案例密度和数据完整度是另一组质量指标，不能与确认状态混为一谈。
- 已确认的架构信号包括：接岗后优先跑公司库/个人库并争取 24 小时首批；客户反馈质量决定继续投入还是后调；流程中约 3–5 人时可暂停新增；后期人选存在单点风险时补 1–2 名 backup；出现 Offer 后停止新增交付。
- 推荐报告已不是空白：小麦进入驾驶舱后自动总结，本人按客户关注点微调；候选人对具体推荐的同意仍是人工守门。
- 面试辅导已不是空白：约面后电话沟通、补充客户资料、记录顾虑、不能解答的问题转客户侧。
- 入职维护已有本人确认的节点节奏；Offer 谈判虽有历史方法素材，实际记录位置、自动化等级和错误可发现性仍待确认。

### Miya v0

- 用户于 2026-09-01 明确确认该素材全部为本人确认内容，知识状态按 `CONFIRMED` 处理。
- 已确认的架构需求包括：公司→部门/业务线→候选人的 Mapping；同一人多份简历去重；区分“候选人本身强弱”和“岗位匹配度”；一人多岗对比；推荐和面试材料的证据包；高价值候选人的长期跟进。
- Offer 谈判和入职后维护仍是本人确认的素材缺口；触达、推荐和漏斗数据也缺少完整量化证据。这里的“缺口”表示信息尚未采全，不表示素材未经本人确认。

因此，两份素材都可以进入知识库的 `CONFIRMED` 层；但确认状态不等于自动执行授权。具体规则仍需满足证据、适用范围、automation、detectability 和发布审核后，才可升级为 `PUBLISHED` 并参与自动执行。

## 3. 信息所有权

| 信息域 | 权威系统 | Hub 保存内容 | 禁止做法 |
|---|---|---|---|
| 职位、HC、招聘状态 | TTC | ID 映射、快照引用、新鲜度 | 用 BrainX/reloop 覆盖 TTC 权威事实 |
| 顾问判断、项目、行动 | BrainX | 标准事件和当前投影 | 让前端或 AI 猜合法动作 |
| 人选、简历、匹配、触达 | reloop | opaque candidate ref、Case 事件 | 把完整简历和联系方式复制进事件账本 |
| 对话证据 | 飞书/招聘网站 | message/evidence ref、分类结果 | 用公司名长期猜职位或人选归属 |
| OpenMai 找人 | OpenMai/reloop | sourcing run、结构化候选引用 | 只保存一份会被覆盖的 Markdown 结果 |
| 蒸馏知识 | 已审核知识库 | 版本、来源人、确认状态 | 把素材稿当成团队正式规则 |

## 4. 身份层

### 4.1 职位身份

```text
TTC job_id
  ↔ BrainX project_id
  ↔ reloop position_id
```

`entity_links` 必须支持候选匹配、人工确认和拆分：

```text
link_id, tenant_id, entity_type, canonical_id
source_system, external_id, status
confidence, match_method, evidence_ref
created_by, created_at, verified_by, verified_at, verification_action
split_from, superseded_by, invalidated_at, invalidation_reason, version
```

规则：

- 显式外部 ID 可以直接验证。
- 模糊匹配只能产生 `PENDING` 候选 link，进入人工确认队列。
- 错误合并通过 `link.split_requested/completed` 纠正，不静默改历史。
- `verified_at` 只有在明确的验证动作完成后才能填写。

### 4.2 人选与多简历

reloop 拥有人选 canonical identity。TTC、OpenMai、招聘网站只提供外部身份和简历文档。

```text
candidate_identity  一个人
resume_document     一来源、一时间的一份简历
candidate_field_fact 字段值 + 来源 + 时间 + 可信度
```

字段冲突默认优先级：人工已确认 > 最新权威 API > 最新简历解析 > 历史值 > AI 推断。旧值保留 provenance，不覆盖删除。

BrainX 只保存 `candidate_ref` 和必要脱敏摘要，不保存手机号、邮箱或完整简历。

## 5. Case 状态机

### 5.1 双轴投影

单一 `current_stage` 无法同时表达触达和客户流程，Case 使用两条状态轴。

业务里程碑：

```text
DISCOVERED → QUALIFIED → CONSENTED → SUBMITTED → INTERVIEW → OFFER → PLACED
                                                               └→ CLOSED
```

触达状态：

```text
NOT_CONTACTED → DRAFT_READY → APPROVAL_PENDING → SENT → DELIVERED → REPLIED
                                                        ├→ NO_RESPONSE
                                                        └→ BOUNCED
REPLIED → WITHDREW 也允许作为关闭原因
```

每次触达拥有独立 `outreach_id`，不能用 Case 的一个字段覆盖多轮触达历史。

### 5.2 守卫与纠正

- `SUBMITTED` 前必须存在 `candidate.consent_confirmed`，或带操作者和原因的人工 override；不能只要求某个渠道的 `outreach.replied`。
- 业务里程碑按 rank 单调前进；迟到的低 rank 事件可补证据，但不让阶段后退。
- 阶段回退只能发 `case.stage_corrected`，记录原阶段、目标阶段、原因和操作者。
- 投影带 `version`，更新使用乐观锁；冲突时重新读取事件归约。

### 5.3 时间质量

事件同时保存：

```text
occurred_at, received_at
time_quality = SOURCE_CONFIRMED | SOURCE_INFERRED | RECEIVED_FALLBACK
source_timezone
```

`occurred_at` 缺失或不可解析时使用 `received_at`，但必须降低 `time_quality`，不能伪装成精确业务时间。

## 6. 事件与传输边界

### 6.1 持久领域事件

`workflow_event_log` 是回放、审计、投影重建和跨系统消费的持久账本。标准信封至少包含：

```text
event_id, event_type, schema_version
occurred_at, received_at, time_quality
tenant_id, consultant_id
project_id, position_id, candidate_ref, match_id, case_id
correlation_id, causation_id, idempotency_key
source, payload, evidence_refs
```

### 6.2 瞬态 relay

现有 `worker_events` 只用于 worker→API→SSE 的跨进程接力，一小时 GC、启动不回放历史。它不能作为事件账本、统计源或业务回放来源。

文档和代码统一称：

```text
worker_events      transient relay
workflow_event_log durable ledger
```

### 6.3 消费者幂等

每个消费者按 at-least-once 设计，并维护：

```text
processed_events(consumer_name, event_id, processed_at, result_hash, status)
UNIQUE(consumer_name, event_id)
```

本地投影和 `processed_events` 必须在同一事务中提交。入口 `idempotency_key` 不能替代消费者幂等。

## 7. 三座桥都是 Saga

### 桥 1：接单 → 建岗

```text
job.accepted
→ position.create_requested
├→ position.created
├→ position.create_failed
└→ position.create_timed_out
```

成功后写 `project_id ↔ position_id`。接单后的建岗失败不回滚顾问决定，而是生成可恢复任务。

若随后释放职位：

```text
job.released → position.close_requested
├→ position.closed
├→ position.close_failed
└→ position.close_timed_out
```

### 桥 2：推荐 → 人工终审 → 推人

```text
candidates.ready
→ candidate_case.created
→ ai.draft_created
→ outreach.approval_requested
├→ outreach.approved → outreach.sent → delivered/replied/bounced
└→ outreach.rejected
```

推荐内容必须同时关联 `case_id`、候选人同意和证据版本。展示草稿不等于已经发送。

### 桥 3：结果 → 下一行动/下一轮

```text
interaction.resulted
→ case 投影 + BrainX 下一行动
├→ submission/interview/offer/placement
├→ followup.requested
└→ sourcing.retry_requested
```

Felix 已确认的编排信号先作为人工建议，不直接自动执行：

- 流程中约 3–5 人时提示暂停新增。
- 后期存在单点风险时提示补 1–2 名 backup。
- 客户明确否决且理由清楚时，用反馈校准画像并继续找人。
- 客户长期不明确反馈却持续要人时，提示后调项目优先级。
- 出现 Offer 时提示停止新增交付，但 Offer 不等于入职终局。

## 8. 对账、版本与失败恢复

- 每个 request 事件必须有 succeeded、failed、timed_out 三种结局。
- Watchdog 只发 timeout 事件，不静默修改业务状态。
- 对账结果也进入事件管道：`reconciliation.discrepancy_found/resolved`。
- 第一个消费者上线时同时交付 v1→v2 upcaster 注册表、DLQ 和 re-drive 工具。
- 旧事件永不原地改写；消费者读取前先 upcast 到当前内存结构。

## 9. 隐私与证据

事件 payload 按字段分级。手机号、邮箱、完整消息、录音、简历和附件只进入 Evidence Store；账本只保存 `evidence_ref`、脱敏摘要和分类结果。

Evidence Store 要求：

- envelope encryption，预留按 candidate 独立 data key；
- TTL、访问审计和删除工作流；
- 删除时同步处理缓存、索引和备份恢复路径；
- 未确认录音授权、保存位置和保留期限前，不自动采集或转发电话录音。

需要不可变账本与候选人删除权同时成立时，采用 crypto-shredding：删除 candidate data key，使历史密文不可读，而不是改写事件历史。

## 10. AI 与可回放上下文

AI 的业务产出也进入事件账本：

```text
ai.context_built
ai.draft_created
ai.suggestion_shown
ai.suggestion_accepted
ai.suggestion_edited
ai.suggestion_rejected
```

`case_context` 物化读模型至少保存：

```text
case_id, context_version, case_projection_version
source_event_high_watermark, recent_event_ids
job_snapshot_id, candidate_snapshot_id
knowledge_bundle_version, prompt_template_version, model_id, built_at
```

知识项分为 `DRAFT / CONFIRMED / PUBLISHED / RETIRED`。Felix 与 Miya 素材当前均为 `CONFIRMED`；只有完成规则化和发布审核、升级为 `PUBLISHED` 的知识，才能参与自动话术或判断。界面必须同时显示来源、确认状态和知识版本。

## 11. 复用现有 BrainX 资产

| 现有资产 | Hub 角色 |
|---|---|
| `decision_runs` | 推荐运行上下文 |
| `decision_events` | 职位决策历史种子 |
| `sync_runs` | 来源同步运行 |
| `bridge_cursor` | 旧连接器游标 |
| `commitment_actions` | 职位级下一行动投影 |
| `job_outcomes` | 历史职位级结果种子 |
| `worker_events` | 瞬态 relay，禁止作为账本 |

现有表通过 Hub Contract Adapter 转换成标准信封。`decision_events` 的有限职位枚举和 `project_id` 边界不能承载完整 candidate/case/outreach 事件，因此它只能作为种子，不能无限扩成跨域总线。

## 12. 最小施工顺序

### 第 0 步：先立不可逆边界

1. 定义 envelope、持久账本与瞬态 relay 边界。
2. 建立可拆分的 `entity_links` 与人工确认队列。
3. 定义 Case 双轴状态机、守卫、纠正和乱序规则。
4. 建立 consumer inbox、upcaster、DLQ 和 re-drive。
5. 用 `fixtures/` 回放桥 1 的成功、失败、超时、重复、乱序和补偿。

### 第 1 步：桥 1

接入真实 BrainX `ACCEPTED`，由 reloop 幂等建岗并回传映射。未通过第 0 步回放门禁，不得把演示成功称为“桥 1 已打通”。

### 第 2 步：结构化候选 Case

把 OpenMai/reloop 结果从 Markdown 或列表转为 sourcing run、candidate ref、match 和 case；保留每次运行历史，不覆盖旧结果。

### 第 3 步：桥 2 与桥 3

打通草稿→候选人同意→人工终审→发送→回复归因，再连接面试、Offer、入职和失败重搜。

### 第 4 步：知识与学习

接入已发布的蒸馏知识和 AI 接受/拒绝反馈，在可回放 `case_context` 上评估建议质量。

## 13. 首日指标

- 每来源 freshness；
- `received_at - occurred_at` lag 分布；
- DLQ depth；
- case SLA violation count；
- saga stuck count。

阈值可以后调，但事件采集、来源标签和时间质量必须从第一天存在。

## 相关文档

- [BrainX 最终交付蓝图与施工总清单](brainx-final-delivery-blueprint.md)
- [推荐队列与职位决策产品架构](recommendation-queue-product-architecture.md)
- [前端交互架构](frontend-interaction-architecture.md)
- [猎头经验蒸馏器](hunter-distillation.md)
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)

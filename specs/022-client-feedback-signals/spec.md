# Feature Specification: 客户反馈信号回流与推送精准度（specs/022）

**Feature Branch**: `main`（本仓库以 main 直接协作）

**Created**: 2026-09-23

**Status**: Draft（四项关键决策已由用户拍板，见 §6）

**Input**: 2026-09-23 客户健康指标报告讨论（200 家客户 × 近 90 天飞书客户群，规则版指标 v2：6,024 次推荐 / 3,685 位去重候选人，每条记录带 chat_id）；上游关联：[specs/019 Hub 事件骨干](../019-hub-event-backbone/spec.md)、[specs/016 判断抽取](../016-judgment-extract-loop/spec.md)、[labeling-standard-v1](../../docs/labeling-standard-v1.md)、[岗位推荐算法与评分标准](../../docs/BrainX岗位推荐算法与评分标准.md)

> 上级目录：[specs/](../)

## 背景与立项依据

生产库回流漏斗（2026-09-23 实测）暴露标签层近乎真空：`job_facts_drafts` 确认率 4/8,037；`recommendation_impressions` served 仅 340/7,820（4.3%）；`recommendation_feedback` 72 条且 100% NOT_INTERESTED；`job_outcomes` 仅 11 条。LTR 训练集 203 行（NDCG@10 0.61 / recall@50 0.31）已到标签天花板——**标签不厚，任何匹配模型都是在沙地上建房**。

同一时段的客户健康指标报告指出了被浪费的最厚资产：`lark_messages`/`workflow_event_log` 已有 16,993 条客户群消息原文，但目前只喂了职位事实抽取（specs/003），**尚未喂标签层**。客户在群内的真实反馈（兴趣/婉拒/催促/约面）是不依赖产品录入的 outcome 信号——比加新特征更先值得做。

本规格把「推送更准」拆为三层，按依赖顺序施工：

```text
A 信号层：群消息 → 客户反馈事件 → client_metrics（客户健康指标日常化）
B 特征层：ltr-feat-v2 客户健康特征 + 归因分层（防脏标签）
C 时机层：断档事件触发定向跑批 + 生命周期分档推送策略
```

## 范围与非目标

**非目标**：
- 不修复 `job_facts_drafts` 确认闭环（specs/003 范畴，另案推进）；
- 不改动推荐五层混合架构与影子评估纪律（算法文档 §3/§7）；
- 不替代 specs/019 dispatcher——**直接注册为它的消费者**（dispatcher 已于 2026-09-23 上线，首轮 dispatched=125，无需再立独立管道）；
- 不触碰 `recommendation_feedback` 通道（labeling-standard-v1 红线：反馈通道只收 NOT_INTERESTED，业务结果走 `job_outcomes`）。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 存量群消息客户反馈抽取回填 (Priority: P1)

对存量 16,993 条客户群消息按规则引擎分类（零 token），产出客户反馈事件写入账本 `workflow_event_log`（与 specs/019 同口径，事件类型 `client.feedback_observed`），重跑幂等。

**Why this priority**: 标签层的根。不依赖任何新管道，dispatcher 已具备消费者注册能力。

**Independent Test**: 对同一批消息连续跑两轮回填，第二轮零新增事件；抽样人工核对分类正确率可接受（规则版口径见 §5）。

**Acceptance Scenarios**:
1. **Given** 任一客户群消息原文，**When** 规则引擎执行，**Then** 客户侧消息（发言人非本方顾问）按模式分为 `INTEREST / REJECT / URGE / INTERVIEW_REQUEST` 之一或无事件，每条事件含 chat_id、message_id、event_at 与证据锚点。
2. **Given** 同一消息重放，**When** 回填脚本再次执行，**Then** 以 message_id+event_type 为幂等键，不产生第二条事件。
3. **Given** 规则无法覆盖的口语变体，**When** LLM 增强开关（`BRAINX_CLIENT_FEEDBACK_LLM=1`）关闭，**Then** 该消息静默落「未分类」计数而非编造事件。

### User Story 2 - client_metrics 日常化 (Priority: P1)

把报告的 8 指标口径沉淀为 `bin/brainx-client-metrics.mjs`：每日增量重算 200+ 客户的健康指标并物化进 `client_metrics` 表（含大盘 p25/p50/p75 分位锚点），结果可与报告对账。

**Independent Test**: 用同一 SQL 口径对报告中的 ≥30 家客户重算，指标与报告快照完全一致；此后每日 timer 增量更新。

**Acceptance Scenarios**:
1. **Given** 报告 200 家客户任一抽样 ≥30 家，**When** 计算器跑近 90 天窗口，**Then** 反馈速度、决策效率、响应速度、推荐节奏、最大断档、意向覆盖、催促频次与报告值零偏差。
2. **Given** 每日增量执行，**When** 某客户新增群消息，**Then** 该客户指标在下一轮重算后更新，且历史快照可追溯（指标带 computed_at 与窗口边界）。

### User Story 3 - 客户兴趣事件回写 job_outcomes (Priority: P2)

`INTEREST / INTERVIEW_REQUEST` 事件按 job_facts.chat_id 关联职位，写入 `job_outcomes`（新 stage='群内客户反馈'），使 outcome 标签获得不依赖产品录入的真实供给；`REJECT` 仅作为弱负信号记录，不写 outcomes（与人工标注通道隔离）。

**Acceptance Scenarios**:
1. **Given** 某客户在群内表达对某职位候选人兴趣，**When** 事件经 chat_id 关联到 job_facts 行，**Then** `job_outcomes` 新增一条可回放（brainx_replay 可见）的 outcome 行，value_json 含证据 message_id。
2. **Given** 同一 INTEREST 事件重放，**When** 关联执行，**Then** 幂等不重复写入。

### User Story 4 - ltr-feat-v2 客户健康特征 + 归因分层 (Priority: P2)

新增 6 个客户侧特征进特征层，分位锚点随特征版本冻结（可重放）；意向覆盖低于 p25 的客户产生的负样本标 `supply_issue=1` 并在训练时降权，避免把供给侧问题错怪给排序模型。**只进影子评估**，不直接替换线上排序。

**Acceptance Scenarios**:
1. **Given** 任一冻结推荐行，**When** 提取 ltr-feat-v2 特征向量，**Then** 含 6 个客户特征且取值来自冻结时点可得的 client_metrics 快照（无特征泄漏）。
2. **Given** 影子评估执行，**When** v1 与 v2 对比，**Then** 产出 NDCG@10 / recall@50 对照报告，v2 未达门槛（任一指标不低于 v1）不得进入线上替换流程。
3. **Given** 意向覆盖低于 p25 客户的负样本，**When** 构建训练集，**Then** 带 supply_issue=1 标记且默认权重 0.3（系数可配）。

### User Story 5 - 断档事件触发定向跑批 (Priority: P2)

客户最大断档逼近停摆阈值（默认取大盘 p75 对应天数，env 可调）时，触发该客户名下 OPEN 职位与其归属顾问的定向 decision_run，**绕过 2h 全局限流但范围严格限定触发客户**；push_log 记录 `trigger_source='stall_trigger'` 供审计。

**Acceptance Scenarios**:
1. **Given** 某客户断档天数达到阈值，**When** 触发检查执行，**Then** 该客户名下 OPEN 职位产生一轮定向跑批，且 push_log 带触发来源标记。
2. **Given** 触发执行，**When** 与其他客户比对，**Then** 未触发客户的 decision_runs / 推送行为不受任何影响。
3. **Given** 同一客户断档持续，**When** 已在冷却窗内（env `BRAINX_TRIGGER_SILENT_COOLDOWN_HOURS`，默认 24），**Then** 不重复触发。

### User Story 6 - 生命周期分档推送策略 (Priority: P3)

按 client_metrics 生命周期分档执行差异化推送：稳定/校准维持现状（仅 material change 推送）；冷启动提高探索配比；**休眠完全静默**（autopush 跳过）并每周产出移交 BD 挽回清单。策略映射进配置而非硬编码。

**Acceptance Scenarios**:
1. **Given** 休眠档客户，**When** autopush 检查重大变化，**Then** 零推送且该客户出现在 BD 移交清单中。
2. **Given** 冷启动档客户，**When** 新一轮推荐生成，**Then** 探索配比按策略配置上调（scorer 配置项，可回放）。

### User Story 7 - served 曝光回传断点诊断 (Priority: P3)

`served` 仅 340/7,820（4.3%）意味着 CTR 类标签地基缺失。先诊断后修：定位卡片展示→`recommendation_impressions.served` 回写链路的断点（前端未回传 / 路由缺失 / 状态机条件过严），产出诊断报告，修复方案按根因另立小步提交。

**Acceptance Scenarios**:
1. **Given** 一次真实卡片展示，**When** 链路走通后查询，**Then** 对应 impression 行 served 置位率显著高于 4.3% 基线。
2. **Given** 诊断未完成，**When** 本 story 验收，**Then** 至少交付「断点定位 + 根因 + 修复项清单」报告。

## Requirements（数据契约与约束）

### FR-1 事件契约
- 事件类型 `client.feedback_observed`，payload 必含：`chat_id`、`message_id`、`event_type`（4 枚举之一）、`event_at`、`side`（client/consultant）、`evidence`（原文锚点）；幂等键 `message_id+event_type`。
- 事件进 `workflow_event_log` 账本，不立第二事实源（specs/019 口径）。

### FR-2 client_metrics 表
- 主键 `chat_id`；字段含报告 8 指标 + 生命周期分档 + `computed_at` + 窗口边界；大盘分位锚点存常量表并随特征版本冻结。
- 计算器 `bin/brainx-client-metrics.mjs` 只读主库，支持 `--backfill` 与每日增量两种模式，供 systemd timer 调度。

### FR-3 特征层
- `LTR_FEATURE_VERSION='ltr-feat-v2'`，新增：`client_resp_p50_ratio`、`client_decision_days`、`client_lifecycle`、`client_intent_coverage`、`client_silent_days`、`client_blocked`。
- 归一化一律用相对水位（÷ 大盘锚点），不用原始小时数——跨客户可比。
- 归因分层：`supply_issue=1` 负样本默认训练权重 0.3（`train_ltr.py` 配置项）。

### FR-4 成本与开关
- 规则抽取默认零 token；LLM 增强受 `BRAINX_CLIENT_FEEDBACK_LLM` kill-switch 控制，默认关。
- 触发器绕限流仅限触发客户范围，双重 env 门（`BRAINX_STALL_TRIGGER=1` 总开关 + 冷却窗）。

### FR-5 观测
- 触发器与策略分档的每次生效都留审计字段（push_log.trigger_source / decision_runs.trigger_source）。
- 未展示不等于负反馈（算法文档 §2.5 纪律继续有效）：served 修复前，静默不计入任何负标签。

## 成功度量（SC）

| 编号 | 度量 | 基线 | 目标 |
|---|---|---|---|
| SC-1 | 存量回填幂等（重跑零新增） | — | 100% 幂等 |
| SC-2 | client_metrics 与报告对账 | 报告快照 | 抽样 ≥30 家零偏差 |
| SC-3 | job_outcomes 供给 | 11 条 | 新 stage 行数 >0 且周增可观测 |
| SC-4 | ltr-feat-v2 影子对比 | NDCG@10 0.61 / recall@50 0.31 | 两指标均不低于 v1 才可进入线上替换流程 |
| SC-5 | 触发器审计 | — | 每次 bypass 均 push_log 留痕 |
| SC-6 | 休眠零推送 | — | autopush 对休眠档 100% 跳过 |
| SC-7 | served 根因 | 4.3% | 诊断报告 + 修复后置位率显著回升 |

## 决策记录（2026-09-23 用户拍板）

1. **抽取引擎**：规则先行 + LLM 带 kill-switch（默认关）。
2. **事件落位**：进 `workflow_event_log` 账本，与 specs/019 同口径，不立第二事实源。
3. **触发器**：事件触发绕过 2h 限流，范围严格限定触发客户名下职位。
4. **休眠策略**：完全静默 + 移交 BD 清单（不做降频月推）。

## 红线

- 影子纪律不可破：v2 未过 SC-4 门槛不得触碰线上排序。
- 分位锚点与特征版本绑定冻结，锚点漂移必须 bump 版本，否则基线不可重放。
- `recommendation_feedback` 通道不收任何业务结果（labeling-standard-v1）。
- 触发器 bypass 必须限范围 + 留审计，绝不允许扩散成全量跑批（token 成本纪律）。

## 施工记录

- 2026-09-25（kimi-code-main）：US6 第一批增量落地——`client_metrics` 表（0058）+ 报告快照导入脚本 + 生命周期策略层 + `bin/brainx-first-batch-push.mjs`（dormant 剔除 / cold_start 标注，不改线上排序）。US6 的 BD 移交清单、US1/US2/US4/US5/US7 未动。详见 [docs/2026-09-25-first-batch-push.md](../../docs/2026-09-25-first-batch-push.md)。

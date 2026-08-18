# 顾问个人决策 Agent 1.0
## 工程可执行 PRD / Codex 开工方案

**版本**：1.0.0  
**状态**：可开工  
**产品负责人**：Felix  
**技术目标**：先跑通单个顾问的“事实同步—自主排序—人工承接—结果回流—可回放”闭环  
**默认运行方式**：本机运行，使用已有 OpenClaw 登录态只读读取 TTC；不新增飞书授权；驾驶舱 Adapter 不作为 1.0 的启动前置条件  
**实现建议**：Node.js 20 + TypeScript + SQLite + 本地 Web 工作台

---

## 1. 给技术老师和 Codex 的执行结论

请把本项目实现为一个“个人决策工作台”，而不是职位展示表。

1. TTC 是 1.0 的必选事实来源；驾驶舱只有在已有合法只读 Adapter 可用时才作为可选来源。所有事实只读、可追溯、不可由 Agent 改写。
2. Agent 根据事实和个人历史行为自动筛选、排序，判断“建议关注/建议接单/暂不建议”。
3. 顾问只负责确认是否关注、是否接单和填写反馈，不手工调权重。
4. 每次推荐、查看、点击、接单、释放、结果都写入不可变事件账本。
5. 个人化模型只能由该顾问自己的事件更新，必须可回放、可回滚。
6. 1.0 只做内部 TTC 事实闭环；外部渠道、自动触达、自动建群放到 2.0。

本版本不接受以下实现方式：

- 用 LLM 猜测顾问是否参与项目；
- 用 Excel 单元格直接充当状态数据库；
- 用团队项目 Pipeline 冒充个人业绩；
- 没有结果数据却宣称 Agent 已完成自主学习；
- 让 LLM 直接修改 TTC、飞书或 Pipeline；
- 用一个没有版本和命名空间的 JSON 文件保存所有顾问 Memory。

---

## 2. 现有能力与真实边界

### 2.1 直接复用

已有 ttc-project-market-radar 能力：

- 通过本机 OpenClaw 已登录浏览器会话读取 TTC；
- 只读读取职位市场和 TTC“我的职位”；
- 用当前登录顾问用户 ID 核验项目关系；
- 输出 project_id、客户、职位、关系、标签、HC、项目级 Pipeline、创建时间和来源链接；
- 区分 Felix 主 PM、我的职位（有推荐/流程）、未加入；
- 支持投放、增长、营销等方向筛选；
- 不新增飞书授权，不读取 Cookies、Token、localStorage 或认证头；
- 不修改 TTC 和原始飞书表格。

现有脚本入口：

~~~~bash
node /Users/felix/.codex/skills/ttc-project-market-radar/scripts/export-project-radar.mjs \
  --include '投放|增长|营销|市场|GTM|DTC' \
  --output ./outputs/ttc-project-radar/verified-projects.json
~~~~

### 2.2 1.0 不假设已经存在的数据

以下数据目前没有在现有导出中稳定提供，不能直接写成“已实现”：

- 顾问个人候选人资源数量和可触达状态；
- 顾问个人推荐、面试、Offer、入职流水；
- 客户反馈原文；
- 接单后的个人结果归因；
- 外部招聘平台职位。

因此 1.0 的结果反馈默认提供一个人工录入入口，同时预留只读 Adapter。等稳定数据源确认后再自动接入。

---

## 3. 产品目标、非目标和成功定义

### 3.1 目标

单个顾问可以完成：

~~~~text
同步 TTC 事实
→ Agent 生成候选集
→ Agent 自动排序并给出建议
→ 顾问关注或接单
→ 记录执行结果
→ 回放当时决策
→ 样本达到门槛后启用个人化策略
~~~~

### 3.2 非目标

1. 不做公司统一派单。
2. 不做完整候选人寻访；内部人才库继续由原系统负责。
3. 不接入外部职位源。
4. 不自动给客户、人选发消息。
5. 不自动修改 TTC、飞书或原始业绩数字。
6. 不自动创建作战群；1.0 只保留项目链接。
7. 不在冷启动阶段使用复杂强化学习。
8. 不把“推荐后成单”直接解释成完全由 Agent 造成。

### 3.3 1.0 成功定义

- 每条推荐能追溯到真实 TTC 数据；
- 每条推荐有明确理由、风险和证据覆盖率；
- 关注/接单/反馈能够稳定记录；
- 同一事实快照和同一策略版本可重复得到同一结果；
- 个人反馈不会污染另一顾问；
- 可以回放一次完整决策；
- 个人化策略在达到样本门槛后才生效。

---

## 4. 领域模型

### 4.1 领域对象

| 对象 | 含义 | 来源/性质 |
|---|---|---|
| TTCProject | TTC 返回的一条项目/职位事实记录 | 外部事实，只读 |
| ProjectMembership | 某顾问与某项目的关系 | TTC“我的职位”快照，随时间变化 |
| Opportunity | Agent 内部可被决策的一条机会 | 1.0 默认映射到一条 TTC 记录 |
| Recommendation | 某次同步中对机会的决策结果 | Agent 派生对象 |
| Engagement | 顾问对机会的个人承接生命周期 | Agent 自己维护 |
| DecisionEvent | 推荐曝光、查看、关注、接单等动作 | 不可变事件 |
| OutcomeObservation | 面试、Offer、入职、关闭原因等结果观察 | 人工或合法只读源 |
| PersonalPolicy | 某顾问当前使用的决策策略 | 版本化、可回滚 |
| SyncRun | 一次数据同步任务 | 包含完整性和错误信息 |

### 4.2 数据真相等级

系统必须区分四种信息：

~~~~text
FACT       原始来源事实
DERIVED    由规则计算出的特征
JUDGMENT   Agent 的评分、理由和风险
ACTION     顾问真实点击和反馈
~~~~

LLM 只能生成 JUDGMENT 的解释和分类，不能改变 FACT。

### 4.3 项目、职位、HC 边界

1. 1.0 以 TTC 返回的 project_id 作为 Opportunity 主键来源。
2. 如果未来发现一个项目包含多个独立职位或 HC，新增 role_slot_id，形成：
   opportunity_id = source + project_id + role_slot_id
3. 在未确认 role 级唯一 ID 前，不声称系统已经实现职位级别归因。

---

## 5. 状态机

### 5.1 顾问个人承接状态

~~~~text
NEW
 └─ Agent 推荐 → RECOMMENDED
                  ├─ 顾问查看 → VIEWED
                  │             ├─ 关注 → WATCHED
                  │             │          ├─ 接单 → ACCEPTED
                  │             │          │          ├─ 释放 → RELEASED
                  │             │          │          └─ 完成 → COMPLETED
                  │             │          └─ 90天无有效动作 → EXPIRED
                  │             └─ 暂不考虑 → DISMISSED（进入冷却期）
                  └─ 未查看不等于拒绝
~~~~

### 5.2 状态约束

- PUBLIC 不是 TTC 的状态，只是“尚未进入该顾问承接状态”的 Agent 投影；
- EXPIRED 只允许从 WATCHED 进入，不能让 ACCEPTED 静默退回公共池；
- ACCEPTED 必须有接单人和接单时间；
- RELEASED 必须有释放原因；
- DISMISSED 必须有原因或系统冷却规则；
- WATCHED 默认最多 10 个，限制可配置；
- “有效动作”定义为查看、备注、接单、释放或结果更新，单纯同步不算；
- 所有状态变化只能通过命令进入，不能由前端直接改数据库字段。

### 5.3 状态命令

~~~~text
watch(opportunity_id)
accept(opportunity_id)
dismiss(opportunity_id, reason_code)
release(opportunity_id, reason_code)
complete(opportunity_id, outcome_summary)
~~~~

---

## 6. 1.0 功能需求

### FR-01：只读事实同步

输入：TTC 职位市场、TTC“我的职位”、当前登录顾问身份。  
输出：SyncRun、TTCProject、ProjectMembership、原始快照。

必须记录：

~~~~text
sync_id
source
query
filter
started_at
completed_at
as_of
rows_expected
rows_read
complete
schema_version
errors
input_hash
~~~~

规则：

- complete=false 时不得进入正式推荐；
- 重复同步不得产生重复项目；
- 登录失效、接口超时、字段变化必须显式报错；
- 保留原始 JSON 快照，方便后续回放；
- 只允许读，不允许通过 Adapter 写 TTC。

### FR-02：机会候选集

候选集生成顺序固定为：

~~~~text
全量活跃项目
→ 去重
→ 基础字段校验
→ 业务方向筛选
→ 排除技术/设计等误匹配
→ 排除已关闭/不活跃项目
→ 排除冷却期项目
~~~~

每个机会必须保留过滤原因和缺失字段：

~~~~json
{
  "included": true,
  "filter_reasons": ["active", "growth_keyword_match"],
  "missing_fields": []
}
~~~~

### FR-03：顾问状态摘要

1.0 只使用当前可验证数据生成摘要：

- 当前顾问身份；
- 我的项目数量；
- 主 PM 项目数量；
- 未加入机会数量；
- 当前关注数量；
- 当前接单数量；
- 最近一次同步时间；
- 数据完整性状态。

候选人资源、客户反馈和个人结果如果暂时没有数据，必须显示 UNKNOWN，不能推断为 0。

### FR-04：决策引擎

决策链路：

~~~~text
硬约束过滤
→ 特征计算
→ 默认策略评分
→ 个人策略修正
→ 探索位分配
→ 稳定排序
→ LLM 生成解释/风险
~~~~

硬约束：

- 只推荐活跃项目；
- complete=false 的同步不推荐；
- 冷却期内不重复推荐；
- 已 ACCEPTED/COMPLETED 的机会不进入新接单推荐；
- 关键证据不足时只能进入低置信观察，不能输出建议接单。

默认评分：

| 维度 | 初始权重 | 目前数据是否必需 |
|---|---:|---:|
| 职位方向匹配 | 25% | 是 |
| 项目活跃度和 Pipeline | 20% | 是，但为项目级事实 |
| 与顾问已有项目的相似度 | 15% | 是 |
| 当前承接容量 | 15% | 是 |
| 顾问历史行为证据 | 15% | 冷启动可为空 |
| 探索额度 | 10% | 是 |

缺失维度不得静默当作 0。S2 统一采用以下规则：

1. 只对有证据的维度求加权平均，分母使用“可用权重之和”；
2. evidence_coverage = 可用权重之和 / 总权重；
3. evidence_coverage < 0.50 时强制输出 OBSERVE；
4. evidence_coverage 在 0.50–0.70 时最多输出 RECOMMEND_WATCH；
5. 关键字段（活跃状态、project_id、职位名）缺失时直接 EXCLUDE；
6. 所有阈值和缺失策略写入 policy_version。

决策输出：

~~~~json
{
  "decision_id": "dec_xxx",
  "opportunity_id": "ttc:JXXXX",
  "action": "RECOMMEND_WATCH",
  "score": 78.4,
  "confidence_band": "MEDIUM",
  "evidence_coverage": 0.72,
  "reasons": [
    "职位方向与最近有效项目相近",
    "项目处于活跃交付阶段"
  ],
  "risks": [
    "尚无该职位的个人候选人资源证据"
  ],
  "evidence_refs": [
    {"snapshot_id": "snap_xxx", "field": "role"},
    {"snapshot_id": "snap_xxx", "field": "pipeline"}
  ],
  "policy_version": "baseline-1.0"
}
~~~~

不要输出未经校准的概率 confidence。1.0 使用 LOW/MEDIUM/HIGH 置信区间和证据覆盖率；样本足够后再做概率校准。

action 枚举固定为：

~~~~text
RECOMMEND_WATCH   建议关注
RECOMMEND_ACCEPT  建议接单，但仍需顾问明确点击
OBSERVE           证据不足，只观察
EXCLUDE           不进入推荐列表
~~~~

Agent 永远不能自动执行 ACCEPT。排序 tie-breaker 固定为：

~~~~text
score desc → evidence_coverage desc → freshness desc → opportunity_id asc
~~~~

DecisionEngine 必须接收注入的 clock，不能直接读取系统当前时间，否则无法稳定回放。

### FR-05：个人工作台

1.0 必须有一个可写的轻量工作台，不能只展示 Excel。

最小页面：

1. 今日推荐：Top K、行动建议、理由、风险、来源链接；
2. 我的承接：关注、接单、释放、完成；
3. 决策回放：查看某次推荐的原始输入、特征、策略版本和动作；
4. 同步状态：最近同步、完整性、错误信息；
5. 反馈录入：结果和拒绝原因。

Excel/飞书只作为导出层：

~~~~text
数据库/事件账本 → 工作台 → Excel/飞书导出
~~~~

### FR-06：事件账本

事件类型：

~~~~text
RECOMMENDED
EXPOSED
VIEWED
WATCHED
ACCEPTED
DISMISSED
RELEASED
EXPIRED
COMPLETED
OUTCOME_RECORDED
CORRECTION
~~~~

每条事件必须包含：

~~~~text
event_id
consultant_id
opportunity_id
event_type
previous_state
next_state
actor
occurred_at
recorded_at
idempotency_key
decision_id
policy_version
reason_code
metadata
~~~~

事件只追加，不更新历史事件。纠错通过新增 CORRECTION 事件实现。

### FR-07：结果观察

1.0 支持两种输入：

1. 人工录入：推荐数、有效沟通、面试、Offer、入职、关闭原因；
2. 只读 Adapter：未来接入稳定的 Pipeline 事件源。

人工录入必须带 recorded_by 和 idempotency_key；修改结果只能新增纠正事件，不能覆盖原记录。

必须区分：

- consultant_scoped：可归因到当前顾问；
- team_aggregate：团队项目汇总，只能用于项目质量，不能更新个人策略。

没有个人范围证据时，结果只能作为项目级参考。

### FR-08：个人策略调优

冷启动阶段使用 baseline-1.0。

个人策略满足以下条件后才允许从 Shadow 转为 Active：

- 至少 20 条有效决策事件；
- 至少 5 条结果观察；
- 离线回放不低于 baseline；
- 没有连续两次数据不完整；
- 策略通过版本校验。

调优规则：

- 只读取当前顾问自己的事件；
- 每次更新有上限和下限；
- 最小样本不足时不更新；
- 保留旧版本；
- 新策略先 Shadow Run；
- 发现推荐质量下降时自动回滚 baseline。

1.0 不做强化学习。使用 EMA、逻辑回归或有界增量权重即可。

### FR-09：LLM 边界

LLM 可以做：

- 职位方向语义分类；
- 理由和风险的自然语言表达；
- 反馈文本归类；
- 结构化 JSON 输出。

LLM 不可以做：

- 判断项目关系事实；
- 修改来源字段；
- 修改 Pipeline 或业绩；
- 自动接单；
- 没有证据时编造候选人、客户和结果。

所有 LLM 输出必须通过 JSON Schema 校验，失败则使用规则解释或标记解释生成失败。

---

## 7. 数据库核心设计

推荐 SQLite；单人和 3 人试用均可支持。所有表预留 consultant_id，后续迁移 PostgreSQL 时不改领域模型。

### 7.1 sync_runs

~~~~sql
CREATE TABLE sync_runs (
  sync_id TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL,
  query_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  rows_expected INTEGER,
  rows_read INTEGER NOT NULL,
  complete INTEGER NOT NULL,
  errors_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
~~~~

### 7.2 fact_snapshots

~~~~sql
CREATE TABLE fact_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  sync_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  company TEXT,
  role TEXT,
  relation TEXT,
  tags_json TEXT,
  pipeline_json TEXT,
  headcount INTEGER,
  source_url TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE INDEX idx_fact_project_time
ON fact_snapshots(opportunity_id, captured_at);
~~~~

### 7.3 candidate_sets

候选集必须独立保存，避免只保存 Top K 后无法解释某条机会为什么被排除。

~~~~sql
CREATE TABLE candidate_sets (
  candidate_set_id TEXT PRIMARY KEY,
  sync_id TEXT NOT NULL,
  consultant_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  included_json TEXT NOT NULL,
  excluded_json TEXT NOT NULL,
  sort_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
~~~~

### 7.4 project_memberships

顾问与项目关系是随时间变化的事实，不能只覆盖在当前职位表的一个 relation 字段里。

~~~~sql
CREATE TABLE project_memberships (
  membership_id TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE (consultant_id, opportunity_id, observed_at)
);
~~~~

### 7.5 engagements

事件账本是事实来源，engagements 是供工作台快速读取的当前状态投影；投影损坏时可以由事件重建。

~~~~sql
CREATE TABLE engagements (
  consultant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  state TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  last_decision_id TEXT,
  last_event_id TEXT NOT NULL,
  last_action_at TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (consultant_id, opportunity_id)
);
~~~~

### 7.6 recommendations

~~~~sql
CREATE TABLE recommendations (
  decision_id TEXT PRIMARY KEY,
  candidate_set_id TEXT NOT NULL,
  consultant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  action TEXT NOT NULL,
  score REAL NOT NULL,
  confidence_band TEXT NOT NULL,
  evidence_coverage REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
~~~~

### 7.7 decision_events

~~~~sql
CREATE TABLE decision_events (
  event_id TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  decision_id TEXT,
  event_type TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT,
  actor TEXT NOT NULL,
  reason_code TEXT,
  metadata_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
~~~~

### 7.8 outcome_observations

~~~~sql
CREATE TABLE outcome_observations (
  outcome_id TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  stage TEXT,
  value_json TEXT NOT NULL,
  evidence_ref TEXT,
  recorded_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  source_event_id TEXT UNIQUE
);
~~~~

### 7.9 policy_versions

~~~~sql
CREATE TABLE policy_versions (
  policy_version TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  weights_json TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  parent_version TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL,
  rollback_reason TEXT
);
~~~~

---

## 8. 模块接口

### 8.1 FactSource

~~~~ts
interface FactSource {
  sync(context: SyncContext): Promise<SyncResult>;
}
~~~~

接口约束：

- 返回原始快照和规范化事实；
- 明确 complete、错误和来源；
- 重复运行幂等；
- 不暴露浏览器认证细节给上层。

### 8.2 DecisionEngine

~~~~ts
interface DecisionEngine {
  decide(context: FrozenDecisionContext): Promise<DecisionSet>;
}
~~~~

接口约束：

- 输入必须冻结，包含 as_of、候选集、个人策略版本；
- 同一输入和版本得到稳定结果；
- 不允许写数据库；
- 只返回决策，不触发接单等副作用。

内部再拆成两个纯模块：

~~~~ts
interface Scorer {
  score(context: FrozenDecisionContext): ScoreSet;
}

interface ExplanationGenerator {
  explain(decisions: ScoreSet, context: FrozenDecisionContext): Promise<ExplanationSet>;
}
~~~~

Scorer 不依赖 LLM、不写数据库；ExplanationGenerator 失败时降级为规则模板。

### 8.3 EngagementLedger

~~~~ts
interface EngagementLedger {
  transition(command: EngagementCommand): Promise<StateChange>;
}
~~~~

接口约束：

- 校验状态转移合法性；
- 使用 idempotency_key；
- 事务写入状态和事件；
- 不允许绕过命令直接 update 状态字段。

### 8.4 Personalizer

~~~~ts
interface Personalizer {
  update(observations: OutcomeObservation[]): Promise<PolicyVersion>;
}
~~~~

接口约束：

- 只接受 consultant_scoped 结果；
- 样本不足返回原策略；
- 新策略先 Shadow；
- 每次更新可回滚。

---

## 9. 推荐代码目录

~~~~text
src/
  domain/
    opportunity.ts
    membership.ts
    engagement.ts
    decision.ts
    events.ts
    policy.ts
  application/
    sync-facts.ts
    build-candidate-set.ts
    generate-recommendations.ts
    transition-engagement.ts
    record-outcome.ts
    replay-decision.ts
    update-personal-policy.ts
  adapters/
    ttc/
      ttc-fact-source.ts
      ttc-schema.ts
      ttc-mapper.ts
  infrastructure/
    db/
      migrations/
      repositories/
    llm/
    clock/
    ids/
  interfaces/
    cli/
    web/
  config/
    policy.ts
    feature-flags.ts
tests/
  fixtures/
  contract/
  domain/
  replay/
  integration/
~~~~

不要先建立通用多渠道平台。当前只有 TTC 一个真实 Adapter，先把 TTC Adapter 做深；第二个真实数据源出现后再抽象外部渠道。

---

## 10. CLI 和工作台命令

~~~~bash
npm install
npm run check
npm test

npm run sync -- --source ttc --include '投放|增长|营销'
npm run recommend -- --limit 10
npm run dev
npm run replay -- --decision-id dec_xxx
npm run export -- --format xlsx --output ./outputs/personal-board.xlsx
~~~~

工作台默认只监听 127.0.0.1，不开放公网，不需要新增飞书授权。

---

## 11. 垂直切片开发计划

### S1：事实同步和完整性（P0）

交付：

- TTC Adapter；
- sync_runs、fact_snapshots；
- 去重、schema 校验、完整性标记；
- 当前顾问关系核验；
- 原始快照保存。

验收：

- 抽查 20 条项目 ID、客户、职位和关系；
- 重复同步无重复事实；
- complete=false 时阻止推荐；
- 登录失效时有明确错误。

### S2：固定候选集和规则推荐（P0）

交付：

- 候选集生成；
- 硬约束过滤；
- baseline-1.0 评分；
- 推荐理由、风险、证据；
- recommendations 表；
- 推荐曝光和查看事件。

验收：

- 同一快照+同一策略版本排序稳定；
- 每条推荐都有 evidence refs；
- LLM 失败不影响规则推荐；
- LLM 不能写入事实表。

### S3：承接状态和事件账本（P0）

交付：

- 本地工作台；
- 关注/接单/释放/暂不考虑；
- 10 个关注位；
- 90 天无有效动作退回；
- 状态转移校验；
- 幂等事件写入。

验收：

- 非法状态转移被拒绝；
- 重复点击不重复产生事件；
- 已接单不会被 90 天规则静默退回；
- 原始 TTC 无任何写入。

### S4：结果录入和决策回放（P1）

交付：

- 人工录入结果；
- consultant/team scope 区分；
- 决策回放页面；
- 结果导出。

验收：

- 可以完整复现一次推荐；
- 团队汇总结果不会更新个人策略；
- 修改结果只能新增纠正事件，不覆盖历史。

### S5：个人化策略 Shadow Run（P1）

交付：

- 事件统计；
- 有边界策略更新；
- Shadow 推荐与 baseline 对比；
- 策略版本、激活、回滚。

验收：

- 样本不足不更新；
- 新策略不自动立即接管；
- 可以回滚到 baseline；
- A 顾问事件不影响 B 顾问。

---

## 12. 测试要求

### 12.1 领域测试

- 关注榜超过 10 个时拒绝新增；
- 只有 WATCHED 能进入 EXPIRED；
- ACCEPTED 只能释放或完成；
- DISMISSED 在冷却期不能重复推荐；
- 非法状态转移返回明确错误。

### 12.2 Adapter Contract Test

使用 20 条脱敏快照测试：

- 字段映射；
- 关系判定；
- 分页完整性；
- API 字段缺失；
- 登录失效；
- 重复同步。

### 12.3 回放测试

固定：

~~~~text
fact_snapshot + candidate_set + policy_version
~~~~

重复运行必须得到相同的排序、决策和过滤原因。

### 12.4 隔离测试

- A 顾问事件不能查询到 B 顾问；
- A 顾问策略更新不改变 B 顾问；
- 导出时只能导出当前顾问数据。

### 12.5 故障测试

- complete=false；
- TTC 登录过期；
- API 超时和 429；
- LLM 返回非法 JSON；
- 数据库写入失败；
- schema 变化。

---

## 13. 效果指标与验证方法

1.0 只验证可观测指标，不宣称因果结论。

| 指标 | 定义 |
|---|---|
| 事实准确率 | 推荐字段与 TTC 快照一致的比例 |
| Top K 可行动率 | 顾问实际关注或接单的推荐比例 |
| 接单率 | 接单数 / 曝光推荐数 |
| 7 日有效动作率 | 接单后 7 天内有有效动作的比例 |
| 超期率 | 90 天无有效动作的关注比例 |
| 推荐覆盖率 | 顾问原本未主动查看但后来进入关注/接单的机会比例 |
| 回放成功率 | 能完整重建推荐上下文的比例 |
| 策略提升 | 个性化策略相对 baseline 的离线指标变化 |

评估时必须保留 baseline，不能只记录 Agent 的结果而没有对照。建议保留 10% 探索位，用于发现顾问历史行为之外的新方向；探索位不能绕过硬约束。

---

## 14. 安全、权限和运维

- 默认只监听本机 127.0.0.1；
- 当前用户身份必须来自 TTC 登录态返回的用户 ID；本地请求中的 consultant_id 与当前登录身份不一致时拒绝读取和写入；
- 1.0 单人模式不假设已有通用登录系统；3 人试用前必须补充登录或服务端行级权限；
- 不读取或持久化 Cookies、Token、Authorization 头；
- 不把候选人个人信息写入 LLM 日志；
- 顾问数据按 consultant_id 隔离；
- 事件账本和原始快照设置保留策略；
- 所有策略更新可回滚；
- TTC 读取失败时不产出正式推荐；
- LLM 超时或失败时降级为规则理由；
- 关键操作写审计日志；
- 外部渠道接入前重新评估权限、隐私和网站条款。

### 14.1 开工前技术确认

技术老师在开始 S1 前确认以下事项：

1. TTC 的 project_id 是否已经能唯一代表一个可承接职位；如果一个项目有多个职位，role_slot_id 如何取得；
2. 当前 OpenClaw 会话返回的 consultant_id 是否稳定；
3. 工作台采用本地 SQLite 还是团队已有数据库；
4. 人工结果录入由谁负责，结果的 recorded_by 如何记录；
5. baseline 的默认关键词、排除词和 10 个关注位是否作为配置文件维护；
6. 1.0 是否只开放 RECOMMEND_WATCH，还是同时展示 RECOMMEND_ACCEPT；两者都不能自动接单。

---

## 15. Codex 直接执行提示词

以下内容可以直接交给 Codex：

~~~~text
你现在负责实现《顾问个人决策 Agent 1.0：工程可执行 PRD》。

工程约束：
1. 使用 Node.js 20 + TypeScript + SQLite。
2. 先实现 S1，再实现 S2；每完成一个切片运行测试并汇报，不要一次性生成全部功能。
3. 复用现有脚本：
   /Users/felix/.codex/skills/ttc-project-market-radar/scripts/export-project-radar.mjs
4. TTC 只读，不新增飞书授权，不读取 Cookies、Token、localStorage、sessionStorage 或 Authorization 头。
5. Excel/飞书只做导出，不作为事件数据库。
6. 所有事实必须保存来源、快照时间、schema_version 和 sync_id。
7. 所有推荐必须保存 decision_id、candidate_set_id、snapshot_id、policy_version、evidence_refs。
8. 所有用户动作必须通过状态命令写入不可变事件账本，并使用 idempotency_key 防重复。
9. LLM 只能做分类、解释和风险生成，不能判定事实、修改事实或自动接单。
10. 缺数据时返回 UNKNOWN/LOW evidence，不要猜测。

实现顺序：
S1：事实同步、快照、校验、去重、完整性阻断、TTC 关系核验。
S2：候选集、硬过滤、baseline-1.0 评分、推荐理由、回放数据。
S3：本地工作台、关注/接单/释放/暂不考虑、状态机、事件幂等。
S4：人工结果录入、个人/团队范围区分、决策回放。
S5：个人策略 Shadow Run、有界更新、策略版本和回滚。

每个切片必须提供：
- 代码；
- 数据库迁移；
- 单元测试和集成测试；
- CLI 运行方式；
- 一条可复现的演示命令；
- 已知限制和下一步。

禁止事项：
- 不要实现外部招聘平台；
- 不要自动发消息；
- 不要自动建群；
- 不要把团队 Pipeline 当个人结果；
- 不要先搭复杂的多 Agent 框架；
- 不要用不可解释的强化学习替代 baseline。
~~~~

---

## 16. 1.0 完成标准

技术老师交付以下结果，才算 1.0 完成：

1. 能用现有登录态同步真实 TTC 事实；
2. 能识别当前顾问的项目关系；
3. 能生成稳定、可解释、可回放的 Top K 推荐；
4. 顾问可以在工作台关注、接单、释放和反馈；
5. 所有动作均有不可变事件；
6. 数据不完整时停止正式推荐；
7. A 顾问与 B 顾问数据隔离；
8. 能导出个人决策记录；
9. 能运行测试和回放命令；
10. 个人策略只有满足样本门槛后才进入 Shadow/Active 流程。

完成以上 1.0 后，才进入 2.0：外部职位源、外部寻访、自动提醒、自动建群、跨顾问协作和更复杂的 Agent 规划。

# Feature Specification: 字段补全 Agent 与 served 埋点闭环（specs/023）

**Feature Branch**: `main`（本仓库以 main 直接协作）

**Created**: 2026-09-24

**Status**: Approved for development（用户拍板「②先行」，MVP 边界已确认）

**Input**: 2026-09-24 推荐档位塌缩诊断（生产库只读实测，全量数字见 [data-baseline.md](./data-baseline.md)）；用户拍板：agent 的产出是「特征/字段」不是「决定」，评分继续走确定性管线。上游关联：[specs/003 群消息职位事实回路](../003-group-message-job-facts-loop/spec.md)、[specs/022 客户反馈信号](../022-client-feedback-signals/spec.md)、[数据渠道全景与接入路线](../../docs/2026-09-24-data-channels-roadmap.md)、[岗位推荐算法与评分标准](../../docs/BrainX岗位推荐算法与评分标准.md)

> 上级目录：[specs/](../)

## 背景与立项依据

生产推荐轮 OBSERVE 占比 90.1%（2,000 条冻结推荐实测），根因是 dataConfidenceOf 的 INSUFFICIENT 降档：关键事实 4 项（招聘状态/职位关系/HC/当前阶段）缺 ≥2 项或事实超 30 天未更新 → 无条件强制 OBSERVE。生产实测证实两个结构性缺口：

1. `current_stage` 唯一自动来源是 `cockpit_facts`（全库仅 20 行，覆盖 23,294 个职位中的 20 个）；
2. `active_state` 填充率仅 12%；`captured_at` 语义是「事实最后变化时间」，稳定职位时钟永不走，78% 职位超 90 天。

同时 lark_messages 已沉淀 18,763 条客户群消息（147 个职位绑定群占 16,493 条），其中含可抽取的阶段/状态/HC 信号消息存量约 2,237 条、增量约 75 条/天。specs/003 的抽取管线（job_facts_drafts）已验证富文本解析可行性（8,657 条 active_state 草稿），但**该管线不产 current_stage，也不刷新合成层**。

模拟实验（未改代码，对最新轮重放闸门逻辑）证明：仅解 stale 与补 current_stage/active_state 两个字段，linda 的 ACCEPT 档从 8 升到 20、WATCH 从 77 升到 101；york rank1（score 75.5 / coverage 0.85）从 OBSERVE 解锁 ACCEPT。完整数字与实验口径见 [data-baseline.md](./data-baseline.md)。

**与 T7 Pipeline 渠道的关系**（[数据渠道全景](../../docs/2026-09-24-data-channels-roadmap.md) P0 项）：T7 接通后 `current_stage` 获得结构化真值，是**第一供给线**；本 spec 的 agent 抽取是**第二供给线**（覆盖 T7 不同步的历史职位、以及 T7 之外的群内口语状态如「暂停了」「HC 不限」）。两线在合成层汇合，优先级见 FR-3。T7 落地后本管线不退役——消息里有 T7 拿不到的增量信号。

## 范围与非目标

**MVP 一句话**：存量信号消息回填 + 每日增量跑批，agent 抽取的阶段/状态字段进合成层，解除 INSUFFICIENT 降档；同时卡片打开动作回写 served，曝光率从 4.3% 基线变得可测。

| 做（MVP 范围） | 不做（明确出界） |
|---|---|
| 新表 `job_agent_facts` + migration 0057 | direction 语义分（MiniLM embedding，后续模块） |
| post 富文本解析 + 规则预筛（零 token，复用 003 管线模式） | 冷启动画像模块（六顾问 coverage<0.5 是另一个病，见 data-baseline §4） |
| GLM 抽取：存量回填（--backfill）+ 增量每日 timer | LLM 直接打总分/定档位（不可重放，红线） |
| chat→job 消歧三分叉（见 FR-2） | 推送四件套（文案诚实化/Top3 保底/push_log 补 UUID/demo 群过滤，另案） |
| `effectiveJob` 合成层插 AGENT 档 | S1 时钟改动（chat_last_at 计入 latestFactAt，一行级但属 policy 变更，独立提交并 bump POLICY_VERSION） |
| `dataConfidenceOf` 对 AGENT 字段打折 | LTR / specs/022 其余 story |
| served 埋点闭环（卡片 URL 带 decision_id → 工作台打开回写） | 群级信号的合成（MVP 只信职位级，群级仅落表） |
| kill-switch `BRAINX_FACT_AGENT`（默认关）+ 幂等 + 全量验证 | hc/relation 的 agent 抽取（hc 生产填充率 99.3% 不缺；relation 是身份问题不是抽取问题） |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 存量信号消息回填 (P0，施工序 ③)

对 lark_messages 中命中信号规则的消息（存量约 2,237 条）执行 GLM 抽取，结果写 `job_agent_facts`，幂等可重跑。

**Acceptance Scenarios**:
1. **Given** 同一批消息连续跑两轮 `--backfill`，**When** 第二轮执行，**Then** 零新增行（幂等键 message_id+field+project_id）。
2. **Given** 某消息含「约了二面」，**When** 抽取执行，**Then** 产出 `{field: 'current_stage', value: '二面', confidence≥0.7, evidence: 原文锚点}` 且带 message_id 可回溯。
3. **Given** `BRAINX_FACT_AGENT` 未设或非 1，**When** CLI 执行，**Then** 只跑解析+预筛并输出统计（未抽取计数），零 token 消耗、零落库。

### User Story 2 - 消歧三分叉 (P0，施工序 ③)

chat→job 归属判定：生产实测 1,353 个 1:1 群、长尾到 135 职位/群，一对一与一对多并存。

**Acceptance Scenarios**:
1. **Given** 群只绑定 1 个职位，**When** 抽取产出，**Then** 直接落职位级（project_id 非空）。
2. **Given** 群绑定多个职位且 GLM 能从文本指认唯一职位（公司名/职位名匹配），**When** 抽取产出，**Then** 落该职位级，confidence 需 ≥0.7 才合成。
3. **Given** 群绑定多个职位且无法指认，**When** 抽取产出，**Then** 落群级（project_id 为 NULL），**仅存储展示，永不进合成层**。
4. **Given** GLM 返回 confidence < 0.7，**When** 落库，**Then** 该行不参与合成（等人工核验通道，非本 spec 范围）。

### User Story 3 - 合成层插档与置信打折 (P0，施工序 ④)

effectiveJob 四层优先级 + dataConfidenceOf 对 AGENT 来源的打折规则。

**Acceptance Scenarios**:
1. **Given** 同一 (consultant, project, field) 存在 manual override 和 agent 行，**When** effectiveJob 计算，**Then** manual 生效（人工永远最高）。
2. **Given** current_stage 仅有 agent 行且 confidence≥0.7，**When** dataConfidenceOf 计算，**Then** 该字段不再计入 missing_fields，reasons 含「agent 抽取待核验」。
3. **Given** agent 行的 extracted_at 在 30 天内且为该职位最新事实，**When** latestFactAt 计算，**Then** 事实时钟被刷新，stale 解除。
4. **Given** AGENT 来源字段与 SYNC 来源字段同时在，**When** confidence band 计算，**Then** AGENT 字段按打折规则（FR-4）不抬高 band 上限（agent 填补不能把 INSUFFICIENT 直接洗成 SUFFICIENT——最多到 PARTIAL）。

### User Story 4 - 每日增量 timer (P1，施工序 ⑥)

systemd timer 每日执行 `--since` 增量抽取（近 7 天消息滚动窗口，幂等键天然去重）。

**Acceptance Scenarios**:
1. **Given** 每日 ~75 条信号消息增量，**When** timer 触发，**Then** 新消息被抽取落库，重复窗口消息零新增。
2. **Given** GLM 调用失败（超时/限流），**When** 本轮执行，**Then** 失败批次留待下轮重试（exit code 非 0 供 systemd 观测），已成功批次不回滚。

### User Story 5 - served 埋点闭环 (P0，施工序 ⑤)

DAILY_TOP3 卡片按钮深链追加 decision_id → 工作台打开对应职位时上报 → `recommendation_impressions.served_at` 置位。

**Acceptance Scenarios**:
1. **Given** 卡片按钮 URL 含 impression/decision 标识，**When** 用户在工作台打开该职位，**Then** 对应 impression 行 served_at 置位（幂等：重复打开不产生副作用）。
2. **Given** 用户从未打开，**When** 查询，**Then** served_at 保持 NULL——**未展示不等于负反馈**（算法文档 §2.5 纪律，静默不计入任何负标签）。
3. **Given** 修复上线满一周，**When** 统计置位率，**Then** 相对 4.3% 基线显著回升（观测项，不设硬阈值，详见验收表）。

## Requirements（数据契约与约束）

### FR-1 数据模型（migration 0057）

```sql
CREATE TABLE job_agent_facts (
  message_id   TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  project_id   TEXT,              -- NULL = 群级信号（仅存储展示，不进合成）
  field        TEXT NOT NULL,     -- current_stage / active_state（MVP 两项）
  value        TEXT NOT NULL,
  confidence   REAL NOT NULL,     -- [0,1]，≥0.7 才进合成
  evidence     TEXT NOT NULL,     -- 原文锚点，截断 200 字符
  model        TEXT NOT NULL,     -- 引擎标识+版本，如 glm-4-flash-v1
  extracted_at TEXT NOT NULL,
  PRIMARY KEY (message_id, field, project_id)
);
CREATE INDEX idx_agent_facts_job ON job_agent_facts(project_id, field, extracted_at);
```

- 时间戳一律 ISO 8601 UTC（与库内既有约定一致）；value 归一化：current_stage 用受控枚举映射（一面/初面→「一面」，二面→「二面」，终面→「终面」，offer→「Offer」，入职/到岗→「入职」；映射表在代码常量，不在本文档复制）；active_state 映射到 OPEN/CLOSED/COOLING（「暂停/满了/招完」→COOLING 或 CLOSED，由 GLM 判断 + 规则校验，非法值丢弃）。
- **migration 三服务同启撞列是已知坑**（AGENT 遗留教训）：timer 首启前必须确认主服务已完成 0057 migration。

### FR-2 抽取管线与消歧

- 输入候选：`lark_messages` 中命中信号正则的消息（阶段/offer/HC/状态四类关键词，存量 2,237 条口径见 data-baseline §3）；消息正文是 post 富文本 JSON，先解析成纯文本（复用 003 管线的解析函数，不重写）。
- GLM 契约：输入 = `{chat_id, 群绑定职位清单[project_id, company, role], 消息纯文本}`；输出 = `[{field, value, project_id|null, confidence, evidence}]`，JSON Schema 校验后落库；批量每批 ≤20 条消息，单条失败不阻塞批次。
- 消歧三分叉：1:1 群直落职位级；多职位群 GLM 指名（company/role 模糊匹配，相似度阈值 0.7）才落职位级；指不出落群级。**群级行永不进合成**。
- 模型配置走既有个人模型配置体系（specs/004），生产 `.env` 增 `FACT_AGENT_KEY`；kill-switch `BRAINX_FACT_AGENT=1` 默认关——关掉时 CLI 只跑解析+预筛输出统计。

### FR-3 合成层优先级

`effectiveJob`（src/facts.js）字段取值优先级调整为：**manual override > AGENT（confidence≥0.7）> cockpit_facts > sync（job_facts）**。`fact_sources` 对应标记新增 `AGENT` 枚举值；AGENT 行的 `fact_updated_at` 取 extracted_at。hc/relation 两字段不引入 AGENT 档（理由见范围表）。

### FR-4 置信打折（recommendation-presentation.js）

- AGENT 来源字段：解除 missing 计数，但 band 上限压到 PARTIAL——**agent 填补不能把 INSUFFICIENT 直接洗成 SUFFICIENT**，SUFFICIENT 必须由人工核验或 cockpit/SYNC 真值达成。
- reasons 追加 `{code: 'AGENT_FACT_UNVERIFIED', text: 'agent 抽取待核验'}`。
- `DATA_CONFIDENCE_RULE_VERSION` bump 到 `data-confidence-1.1`（band 语义变化必须版本化，锚点纪律同 specs/022 FR-3）。

### FR-5 成本与开关

- 存量回填 2,237 条 × ~600 token ≈ 1.4M token（一次性）；增量 ~75 条/天 × 600 ≈ 4.5 万 token/天。flash 级模型月成本个位数人民币量级。
- 三重开关：`BRAINX_FACT_AGENT`（总开关）+ CLI 显式参数（--backfill/--since 必须显式传）+ 幂等键（重跑防护）。

### FR-6 观测与审计

- 每轮回填/增量输出结构化统计：候选数、预筛命中数、GLM 调用数、成功/失败数、职位级/群级/低置信分布、字段分布。日志落 ECS 并显式重定向（`> /tmp/xxx.log 2>&1`，SSH 静默失败教训）。
- 抽取行必须可回溯：evidence 原文锚点 + message_id + model 标识，缺一不落库。

## 模块结构（施工清单）

| 序 | 模块 | 文件 | 职责 | 新/改 |
|---|---|---|---|---|
| ① | 数据模型 | `migrations/0057_job_agent_facts.sql` | 建表 + 索引 | 新 |
| ② | 存储层 | `src/agent-facts.js` | 表读写、按职位取最新有效值、幂等 upsert | 新 |
| ② | 单测 | `tests/agent-facts.test.mjs` | 幂等/取值/优先级 | 新 |
| ③ | 抽取管线 | `src/fact-agent-extract.js` | 富文本解析→预筛→GLM→消歧→落库 | 新 |
| ③ | 单测 | `tests/fact-agent-extract.test.mjs` | 三分叉/非法值丢弃/开关关闭路径 | 新 |
| ③ | CLI | `bin/brainx-fact-agent.mjs` | --backfill / --since 双模式 | 新 |
| ④ | 合成层 | `src/facts.js` | effectiveJob 插 AGENT 档 | 改（~+20 行） |
| ④ | 置信层 | `src/recommendation-presentation.js` | FR-4 打折 + 版本 bump | 改（~+15 行） |
| ④ | 单测 | `tests/effective-agent-facts.test.mjs` | 四层优先级 + 打折分支 | 新 |
| ⑤ | served 回写 | `src/server.js` | 上报端点（幂等置位） | 改（~+15 行） |
| ⑤ | 卡片带 id | `src/push.js` | 按钮深链追加标识 | 改（~+5 行） |
| ⑤ | 前端上报 | `frontend/btex-frontend/` 工作台入口 | 打开职位时上报 | 改（~+20 行） |
| ⑥ | 部署 | `deploy/brainx-fact-agent.{service,timer}` | systemd 每日增量 | 新 |

全部新文件 ≤500 物理行红线内；`facts.js`/`server.js`/`push.js` 为小改不增长。

## 施工依赖序（非优先级，按依赖强制）

```text
① migration → ② 存储层+单测 → ③ 抽取管线 dry-run 回填（抽样人工核对 ≥80% 后才准 --write）
→ ④ 合成+打折+单测+影子对照 → ⑤ served 埋点链路 → ⑥ timer 上生产 + npm run verify full
```

- 每步一个独立 commit（中文说明 + AGENT_COMMIT_LOG 登记）。
- ②③ 不动现有运行行为，可先行合入；④ 起影响推荐输出，commit 必须附影子对照报告（开启前后 dataConfidence 分布 + action 分布对比，口径见 data-baseline §5.3）。
- ⑤ 的前端改动须同步前端审核台账（docs/frontend-reviews/README.md 五维状态，缺一不得标完成）。

### 施工进度

| 序 | 状态 | 说明 |
|---|---|---|
| ①②③ | ✅ 已合入（2026-09-24） | `0057_job_agent_facts.sql` / `src/agent-facts.js` / `src/fact-agent-extract.js` / `bin/brainx-fact-agent.mjs` + 两套单测；框架级——LLM 走注入、kill-switch 默认关（关=只跑解析+预筛统计，零 token 零落库）；④⑤⑥ 未动 |
| ④⑤⑥ | ⬜ 待施工 | 合成插档 / served 埋点 / timer，依赖 ③ 的 dry-run 抽样人工核对 ≥80% |

## 达成的验收效果（Definition of Done）

| 编号 | 验收项 | 判据 | 量级锚点（来自模拟实验） |
|---|---|---|---|
| AC-1 | 回填幂等 | 同批重跑第二轮零新增 | — |
| AC-2 | 抽取质量 | 抽样 30 条人工核对，字段级正确率 ≥80% | 低于 80% 停工修 prompt/映射表，不降标准 |
| AC-3 | 合成正确 | 单测全绿：四层优先级 + 三分叉 + 打折分支 + 版本 bump | — |
| AC-4 | 档位效果 | 生产影子对照报告归档随 commit | linda 类 ACCEPT 8→20、WATCH 77→101；york rank1 解锁 ACCEPT；六冷启动顾问不动（预期内，见 data-baseline §4） |
| AC-5 | served | 真实打开→served_at 置位（幂等）；上线满一周置位率相对 4.3% 显著回升 | 观测项不设硬阈值，周报呈现趋势 |
| AC-6 | 门禁 | `npm run verify` full 全绿，`.quality-gate/reports/latest.md` 结论「通过」 | — |
| AC-7 | 可审计 | 任一 agent 字段可由 evidence+message_id 回溯到原文 | — |
| AC-8 | 成本护栏 | kill-switch 关闭时零 token；开启时日志含每轮 token 消耗统计 | 增量 ≤5 万 token/天 |

## 数据质量验证方法（跑动验证，详见 data-baseline.md §5）

四层验证体系，每层有明确执行口径与失败处置：

1. **回填前**（抽样人工核对）：随机 30 条信号消息，人工标注期望字段值，与 dry-run 输出对比，正确率 <80% 不得进入 --write。
2. **回填中**（幂等校验）：同一批连跑两轮，第二轮零新增；DB 行数与 CLI 统计对账。
3. **回填后**（影子对照）：对最新冻结轮重放 dataConfidenceOf + actionOf（只读，不改生产推荐），产出开启前后分布对比报告；模拟实验口径见 data-baseline §5.3，施工时必须先用真实 job_agent_facts 数据复算。
4. **上线后**（持续观测）：每日增量统计 + served 置位率周报；异常（抽取成功率骤降/群级占比异常升高/档位分布突变）触发回查流程。

**当前数据结论的不足（已知局限，开发须知）**：

- 模拟实验的「群有信号→可补字段」是**乐观假设**：用关键词正则近似了 GLM 的抽取能力，真实抽取率与置信度分布只有跑完 Story 1 才知道；AC-4 的量级锚点可能偏高。
- 信号消息样本（2,237 条）是**单轮快照**，未验证长周期稳定性；75 条/天增量基于近 7 天窗口，节假日/淡季可能显著低于此值。
- linda/york/shanon 的档位提升依赖「active_state 群活着→OPEN」的推断，**群活跃不等于职位在招**，这正是 FR-4 把 band 上限压到 PARTIAL 的原因——不能让推断直接产生 ACCEPT 级信任。
- 六个冷启动顾问（frankie/hiroshi/miya/otto/felix/wendy）100% OBSERVE 的主约束是 coverage<0.5（无画像无历史→direction 维 null），**本 spec 治不了**，预期 AC-4 中他们纹丝不动，不是回归。
- served 4.3% 基线本身是断链状态的读数（前端未回传），修复后置位率的「正常值」没有历史参照，AC-5 只验证链路通与趋势，不设绝对阈值。

## 决策记录（2026-09-24 用户拍板）

1. **agent 定位**：产出是「特征/字段」不是「决定」——agent 把数据补成标准的，评分继续走确定性管线（可重放、可审计、成本可控）。
2. **MVP 范围**：字段补全 agent + 卡片 served 埋点先行（specs/022 讨论中的「②」方案）。
3. **消歧策略**：多职位群指不出落群级，宁可少补不可错补。
4. **置信折扣**：AGENT 填补上限 PARTIAL，SUFFICIENT 必须人工或真值渠道（与 T7 汇合后由 sync/cockpit 层达成）。

## 红线

- **LLM 不得直接打总分或定档位**（不可重放，违反审计链要求）；agent 只产结构化字段 + evidence。
- **群级行永不进合成层**；confidence<0.7 永不进合成层。
- **人工 override 永远最高优先**；agent 行不得覆盖任何 manual_fact_overrides。
- **kill-switch 默认关**；上线灰度顺序 = dry-run → 影子对照 → 生产 --write，跳步即违规。
- **幂等键不可削弱**：message_id+field+project_id 缺一不可（⚠️ 唯一性两层机制：职位级行靠主键；**群级行 NULL 不被主键唯一性覆盖（SQL 复合主键 NULL≠NULL）**，靠存储层写前存在性预检防重——2026-09-24 审核实证后修正机制描述，契约本身不变）。
- **未展示不等于负反馈**（算法文档 §2.5）：served 修复前静默不计入任何负标签。
- 修改 recommendation-presentation.js 必须 bump `DATA_CONFIDENCE_RULE_VERSION`（锚点纪律，specs/022 同款）。

## 相关文档

- [数据基线与验证方法论](./data-baseline.md)（本 spec 的全部实测数字来源与验证口径）
- [specs/003 群消息职位事实回路](../003-group-message-job-facts-loop/spec.md)（富文本解析复用来源）
- [specs/022 客户反馈信号](../022-client-feedback-signals/spec.md)（同为 lark_messages 消费者，事件口径参照）
- [数据渠道全景与接入路线](../../docs/2026-09-24-data-channels-roadmap.md)（T7 Pipeline = current_stage 第一供给线）
- [数据读取链路诊断](../../docs/2026-09-24-data-reading-pipeline.md)（读取纪律六条红线）
- [岗位推荐算法与评分标准](../../docs/BrainX岗位推荐算法与评分标准.md)（评分与影子评估纪律）

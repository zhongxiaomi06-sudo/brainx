# 数据读取链路与错位诊断规范

> 上级目录：[BrainX 文档书](README.md)
>
> 适用范围：BrainX 全部数据的**读取链路**（怎么进来、怎么被消费）与**错位事故的根源分类**。
> 数据放哪（存储/磁盘/生命周期）归 [数据结构与磁盘用途规范](2026-09-23-data-structure-and-disk-layout.md) 管；本文件管「怎么读、为什么会错位、怎么防」。两者互不重叠。
>
> 诊断方法：本文全部结论来自逐文件阅读代码实证（文件名+行为），未实证的不写。改了读取链路代码必须同步本文对应行。

## 1. 数据入料通道总表（写侧，唯一权威）

| # | 通道 | 入口代码 | 解析层 | 落表 | 触发方式 |
|---|---|---|---|---|---|
| W1 | 群消息实时（网关事件） | `src/gateway/ws-client.js` → `src/job-extract/bridge-producer.js` | `normalizeCreateTime`：毫秒/秒时间戳、无时区字符串按 **+08:00** 补 | `lark_messages` + `workflow_event_log`（idem_key=`lark.message_received:<message_id>`） | bridge 拉到消息即生产；**bot 必须在群内**，不在群=零数据 |
| W2 | 群消息历史回填 | `bin/brainx-lark-backfill.mjs` + `src/lark-backfill.js` | `localToUtcIso`：飞书工作区时区 +08:00、**分钟精度**；`parseLarkCliOutput` 固定取 `data.messages` | `lark_messages`（`origin='backfill'`，`received_at`=回填时刻） | 人工触发；`INSERT OR IGNORE` 幂等 |
| W3 | 职位同步 | `src/sync.js`（source=fixture/feishu/payload） | `src/bitable.js#parseBitableRecord`（**按中文字段名**取列，非位置）；`flatLark`/`flatApi` 双通道拍平 | `job_facts` UPSERT（project_id 主键）+ `job_memberships`（关系行有属主守卫） | 定时/手动；行级脏数据只 skip 记 warnings |
| W4 | 消息提炼（职位/判断草稿） | `src/hub/dispatcher.js` → `src/job-extract/index.js` / `src/judgment-extract/index.js` | 规则层 `extractRules`/`extractJudgmentRules`（永远在）→ LLM 层 `extractLlm`（`AI_JOB_EXTRACT_ENABLED`/`AI_JUDGMENT_EXTRACT_ENABLED` 开关） | `job_facts_drafts` / `judgment_drafts`（status=pending） | 账本事件派发；`consumeOnce` 幂等 |
| W5 | 找人结果 | `src/openmai-task.js` → `src/openmai-result.js` | `extractOpenmaiCandidates`：只认 `<!-- BRAINX_CANDIDATES_V1 … -->` 机器块 | `openmai_results`（content-addressed ID） | engagement ACCEPTED / 工具调用 |
| W6 | 顾问人工修正 | `src/facts.js#updateFactOverrides` | `normalizeOverride`（枚举+长度校验） | `manual_fact_overrides` + `fact_override_events`（幂等键） | 顾问 Web 操作 |
| W7 | GLM 语义清洗 | `bin/brainx-draft-cleanup.mjs` | 云端 GLM 判定（kill-switch `BRAINX_LLM_CLEANUP`） | 草稿复活（`source='llm-recovery'`，**UPDATE 平反**）/ 拆稿（`source='llm-split'`，INSERT 新行） | 人工分批跑 |
| W8 | TTC Pipeline/任务拉取（T7/T8） | `data/probe/ttc-pull.mjs`（ECS 临时脚本；正式化目标 `src/ttcsdk/pipeline.js`，见渠道文档 §4 P0） | Bearer JWT（`getValidTtcJwt`，本人 token 拉本人任务面）；`pipeline/list` offset 翻页——**服务端每页实际返回 99-100 行**，退出判据必须是「整页无新增 ID」而非 `length < 100`（09-24 实证：后者在 offset≥100 处提前断流） | `ttc_pipeline_rows`（pipeline_id PK，upsert）/ `ttc_task_rows`（task_id PK） | 人工分批（第一批 2026-09-24：19,579 行/5,431 项目，job_facts 命中 89.1%）；**`pipeline/list` 是公司级共享池**——任一 token 返回同一行集，单 token 深拉即可 |

## 2. 数据消费链路总表（读侧，唯一权威）

| # | 读取方 | 入口代码 | 读什么 | 关键约束（违者即事故） |
|---|---|---|---|---|
| R1 | 推荐轮 | `src/recommend.js` | `latestCompleteSnapshot`（`sync_runs` 取 **complete=1** 最新行）+ 全量 `effectiveJobs` | **fail-closed**：无完整快照不落轮（2026-09-04 事故后修复）；轮次受 2h 限流 + input_hash |
| R2 | 有效职位事实 | `src/facts.js#effectiveJob` | `job_facts` + `cockpit_facts` + `job_occupancy` + `manual_fact_overrides` **四表合成** | 优先级：MANUAL override > cockpit 快照 > job_facts 兜底；每字段带 `fact_sources`（MANUAL/SYNC/UNKNOWN）；**`current_stage` 不在 job_facts 表内**，结构性依赖 cockpit 覆盖率 |
| R3 | 前端工作台 | `frontend` → `server.js` | `latestRun`（decision_runs 最新 COMPLETED）整行展开 | **已知问题**：raw_json 整段出网（VERIFICATION.md #6，待剥） |
| R4 | 每日推送 | worker `push.js` | `decision_runs` 最新 COMPLETED Top3 + `push_log` | **push_log.run_id 是波次合成键（`YYYY-MM-DD#HHMM`），与 decision run UUID 无法 JOIN**——审计断链，specs/022 待修 |
| R5 | LTR 特征 | `src/ltr-features.js` | 职位侧 + 顾问维分 | 特征版本冻结（ltr-feat-v1/v2），分位锚点随版本冻结 |
| R6 | 人才库（MySQL） | `src/db.js#withMysql` | RDS `reloop` 7 表 | **DATETIME 游标必须用 `mysqlLocalDatetime`（本地墙钟串），禁用 toISOString**；与 SQLite 主库互不干扰，懒加载 |
| R7 | 档位判定 | `src/recommend.js` dataConfidenceOf | R2 合成字段 | criticalFields（active_state/relation/hc/current_stage）缺 ≥2 → INSUFFICIENT → 强制 OBSERVE（档位塌缩根源） |

## 3. 错位事故根源分类目录（唯一权威）

生产机反复出现的「数据读取错位」不是一类 bug，是四类。**每次新增读取代码前，先对号入座查这张表**；新错位形态必须登记新行并写明根源类。

### A 类：位置映射错位（按下标/顺序/固定段取值，结构一变就错位）

| 编号 | 事故 | 根源代码 | 状态 | 防复发规则 |
|---|---|---|---|---|
| A1 | 中间插迁移文件导致错位/重复执行 | 旧 `db.js` 按 `PRAGMA user_version` 序数跳文件 | ✅ 已修：`schema_migrations` 按文件名记账 | 迁移记账只认文件名，`user_version` 仅兼容保留 |
| A2 | Bitable「职位」列被当职位名（实为职能类别）→ 22/86 行假职位名 + md5 漂移重复行 | 旧解析层直接拼接 | ✅ 已修：`parseBitableRecord` 公司×单职能展开，`deriveProjectId(company, role)` | 外部表字段名 ≠ 语义；接入前先 field-list 实测全量扫描（bitable.js 头注方法论） |
| A3 | Bitable「还做吗」原文塞进 pipeline，优先级信号全丢 | 旧解析层 | ✅ 已修：`mapPriority` 结构化 + STANDBY→COOLING | 同上；语义字段必须结构化映射，不许原文透传 |
| A4 | Bitable 列序按位置配对（`fields.map((c,j)=>[c,cells[j]])`） | `sync.js#fetchFeishuJobs` | ⚠️ 在用，按字段名配对（列序由 API 返回保证） | 若 lark-cli 输出格式变化需复核；**禁止**在任何新代码里按下标取外部结构 |
| A5 | Offer 群名位置切分 `Offer-{团队}-{候选人}-{岗位}` | `classify.js#parseOfferGroupName` | ⚠️ 仅测试引用，未接生产 | 接生产前必须加：段数异常时拒绝解析而非错位猜字段 |
| A6 | lark-cli 输出数据键不稳定（items/messages 都出现过） | 回填脚本 | ✅ 已修：固定取 `data.messages` 并在缺失时抛错 | 外部 CLI JSON 键不稳定：**解析层显式校验 + 缺失抛错**，禁止静默空数组 |

### B 类：时间语义错位（UTC / 本地墙钟 / 精度混用）

| 编号 | 事故 | 根源代码 | 状态 | 防复发规则 |
|---|---|---|---|---|
| B1 | MySQL 游标 `toISOString()` 把 CST 墙钟转 UTC → 游标永不推进（SOURCE_CURSOR_STALLED） | 旧同步代码 | ✅ 已修：`db.js#mysqlLocalDatetime` 只取本地字段原样往返 | **DATETIME 游标回写一律走 `mysqlLocalDatetime`**；库内时间戳一律 UTC ISO（`now()`） |
| B2 | lark-cli create_time 是分钟精度本地时间，误按 UTC/秒解析 | 回填脚本 | ✅ 已修：`localToUtcIso` 显式 `+08:00` | 外部时间串必须先确认时区与精度，解析函数写死假设 |
| B3 | bridge 传入时间形态三种（毫秒/秒/上海本地串）混合 | `bridge-producer.js#normalizeCreateTime` | ✅ 在用，无时区串按 +08:00 补 | 新通道传时间必须归一到该函数，不许各写各的 |
| B4 | captured_at 每轮同步回刷 → scorer 新鲜度恒满分失去意义 | 旧 sync.js | ✅ 已修：仅十二事实字段真变化才前进（`IS NOT` 比较） | captured_at 语义=「事实最后变化时间」，新增事实字段要同步进比较清单 |
| B5 | backfill 行 `received_at`=回填时刻 ≠ 消息产生时刻 → 时效指标失真 | `lark-backfill.js` | ⚠️ 语义已隔离（origin 列区分） | **送达时效类指标必须 `WHERE origin='gateway'`**；backfill 行只用于内容/信号分析 |
| B6 | 档位塌缩：facts 缺失被当数据问题误判为阈值问题 | `recommend.js` dataConfidenceOf | 🔧 specs/022 修法已定：字段补全（hc/阶段/状态抽取），不是调阈值 | 诊断「数据不对」先查字段缺失率，再动阈值——顺序不能反 |

### C 类：字段语义错位（弱规则把非目标实体抽成目标字段）

| 编号 | 事故 | 根源代码 | 状态 | 防复发规则 |
|---|---|---|---|---|
| C1 | **项目名/产品名被当公司名**（生产 pending 草稿实证「字段错位：项目名当公司名」） | `classify.js` COMPANY_SUFFIX 含「智能/数据/科技」等弱后缀，2-16 字任意串命中即 high | 🔧 规则 v2 待施工（docs/2026-09-24-cold-start-rules-v2-profiles.md） | 弱后缀命中的 company **不得标 high**；规则层与 LLM 层字段必须同过 schema + evidence 锚定 |
| C2 | role 漏抽/过抽：role_missed_by_rules 1,128 / rules_over_extracted 1,199 | role 正则触发词泛（招/寻/找）+ 懒匹配跨句 | 🔧 同上，规则砍长尾、语义归 LLM | 规则层只保底不追全量；命中率缺口用 LLM 层补，不无限加正则 |
| C3 | 一稿多职位（一条消息 6 公司 5 岗）——草稿粒度=消息粒度，不是职位粒度 | W4 消费者一条消息产一条草稿 | 🔧 GLM 拆稿（llm-split）已跑通，未常态化 | 草稿表天然按消息粒度落；**消费 job_facts 前必须过确认/拆稿**，不许直接从 drafts 读进推荐 |
| C4 | evidence 锚定弱校验：只查前 12 字符是否在原文（`src.includes(evidence.slice(0,12))`）即给 high | `classify.js#mapLlmFields` / `judgment-extract#mapJudgmentLlmFields` | ⚠️ 在用 | LLM 输出字段凡 evidence 不完整命中的，置信度上限 medium；改锚定逻辑要同时改两处 map 函数 |
| C5 | judgment subject 类型启发式（含「公司/科技」即 CLIENT_COMPANY） | `judgment-extract#guessSubjectType` | ⚠️ 在用，规则层故意保守 | 与 C1 同根源：弱词表命中不等于语义成立 |

### D 类：键/身份错位（主键、唯一键、幂等键、归因错位）

| 编号 | 事故 | 根源代码 | 状态 | 防复发规则 |
|---|---|---|---|---|
| D1 | content-addressed ID 未纳入 tenantId → 跨 tenant 撞主键被 `INSERT IGNORE` 静默跳过 | openmai 结果入库 | ✅ 已修（ID 纳入 tenantId） | **合成 ID 必须含隔离维度（tenantId）**；`INSERT IGNORE` 的表必须事后核对 changes 数 |
| D2 | message_id 部分唯一索引 `WHERE origin='p2p_jd'` → 复活 INSERT 新行必撞 | migrations + 草稿复活 | ✅ 已修：UPDATE 原行平反（`WHERE status='rejected'` 幂等） | 有部分唯一索引的表，改写策略先查索引定义；「平反」语义优先于「新行」 |
| D3 | push_log `UNIQUE(consultant_id,kind,run_id)` 遇 NULL 失效可重复插 | 旧表定义 | ✅ 已修：'' 哨兵 + 0006 回填 | **NULL 不进 UNIQUE 列**，用 '' 哨兵 |
| D4 | push_log.run_id（波次合成键）与 decision run UUID 无法 JOIN → 审计断链 | push.js 波次键设计 | 🔧 specs/022 待修（记 decision run 引用） | 凡落库引用，键必须能与被引用表 JOIN；合成键要在设计时声明不可 JOIN 的后果 |
| D5 | fixture 关系污染：非属主同步把 Felix 的 MY_JOB 继承成自己的关系 | 旧 sync.js | ✅ 已修：`writeRels` 属主守卫 + relation=null 纪律 | 同步源带属主语义时，关系行只许属主本人触发 |
| D6 | idempotency_key 通道归因：project-launch 自动 ACCEPTED 记成顾问本人操作（84 条中 41 条归因错位） | accept 链路幂等键设计 | 🔧 specs/019 事件账本吸收 | **幂等键前缀=通道签名**（bot:/web:/project-launch:/demo）；统计「本人行为」必须按前缀过滤，代点/自动通道降权或不计 |

## 4. 读取纪律（防复发红线，新增代码逐条对照）

1. **时间三律**：库内一律 UTC ISO；外部本地串显式标 `+08:00`（复用 `localToUtcIso`/`normalizeCreateTime`）；MySQL DATETIME 游标只走 `mysqlLocalDatetime`。
2. **解析禁位置假设**：外部结构（Bitable 列、lark-cli 键、群名段）一律按字段名/前缀锚定；键不稳定时显式校验+抛错，禁止静默空值。新位置解析必须「段数/形态异常即拒绝」。
3. **键四律**：合成 ID 纳入 tenantId；写前先查目标表全部唯一索引（含部分索引）；NULL 不进 UNIQUE 列；落库引用必须可 JOIN。
4. **置信度纪律**：弱词表命中（弱后缀公司名、启发式 subject）不给 high；evidence 锚定两处 map 函数同改；规则层只保底，语义缺口归 LLM 层并留 kill-switch。
5. **通道分层纪律**：`origin`（gateway/backfill/p2p_jd）区分数据怎么来的；`source`（rules/llm/llm-recovery/llm-split/ttc-owner/demo-offer-seed/launch 自动）区分谁写的。**任何指标/画像/统计必须先声明用哪个通道的行**，混用即错位（york 189 假承接、mia 系统代点两次实证）。
6. **诊断顺序**：见「数据不对」先查字段缺失率与通道分层（B6/C 类），确认是数据问题再动阈值/算法——顺序反了会把数据问题修成算法问题。

## 5. 与既有文档的分工

- 存储归属/磁盘/生命周期 → [数据结构与磁盘用途规范](2026-09-23-data-structure-and-disk-layout.md)
- 备份/retention/归档操作 → [数据治理运维手册](2026-09-23-data-governance-ops.md)
- 抽取层架构与契约 → [群消息 → job_facts 提炼层研发路径](2026-09-02-job-facts-extraction-roadmap.md)、[顾问判断抽取回路](2026-09-22-judgment-extraction.md)
- 事件契约 → [specs/019 contracts/event-types.md](../specs/019-hub-event-backbone/contracts/event-types.md)
- 规则 v2 与画像消费口径 → [冷启动规则 v2 与客户画像](2026-09-24-cold-start-rules-v2-profiles.md)
- 历史验证记录 → [开发验证报告](VERIFICATION.md)

## 相关文档

- [数据结构与磁盘用途规范](2026-09-23-data-structure-and-disk-layout.md)
- [数据治理规格](../specs/021-data-governance/spec.md)
- [Hub 事件骨干重整规格](../specs/019-hub-event-backbone/spec.md)

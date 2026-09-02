# 群消息 → job_facts 提炼层：开源调研综合与研发路径

> 上级入口：[BrainX 文档书](README.md) · [后端侧模块结构与下一步安排](2026-09-02-backend-module-structure.md)
>
> 定位：回答后端模块结构 §3 待补第 5 项「群消息提炼成业务字段」**怎么做**——先广泛调研 GitHub 开源算法与组件，再给出与技术蓝图、复用自建边界 PRD 不冲突的研发路径。
>
> 本文是调研与路径文档，不含代码。实施时按 §6 时间线走 spec-kit 流程。

## 1. 问题定义（一句话契约）

**输入**：L0 网关落进 `workflow_event_log` 的一条飞书群消息（`im.message.receive_v1` 解密归一后的文本 + chat_id + message_id）。

**输出**：一条结构化的 `job_facts` 草稿，字段对齐 [migrations/0001_init.sql](../migrations/0001_init.sql) 的既有表结构：

| job_facts 字段 | 含义 | 来源示例（York 群名 `Offer-{团队}-{候选人}-{岗位}`） |
|---|---|---|
| `company` | 客户公司 | 群消息文本「XX科技后端岗暂停了」 |
| `role` | 岗位 | 群名第三段 + 文本 |
| `city` | 城市 | 文本「base 上海」 |
| `pipeline` | 流程阶段 | 文本「约了周四一面」 |
| `hc` | 招聘人数 | 文本「这个岗要 2 个人」 |
| `active_state` | OPEN/CLOSED/ON_HOLD/COMPLETED/COOLING/UNKNOWN | 文本「暂停」「关闭了」「offer 接了」 |

**约束**（来自既有裁定，不可违反）：

- deps 上限 4 个运行时依赖（现 3 个：mysql2、zod、@larksuiteoapi/node-sdk），[复用与自建边界 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md)。
- 提炼结果**不得直接覆盖权威字段**——必须走 staging / 置信度分级 + 人工或 MCP 工具确认（红线：数据破坏比隐私泄漏更致命）。
- AI 调用必须有 kill-switch（用户既有偏好 `AI_ENABLED` 式开关，控制 DeepSeek token 成本）。
- 事件消费必须幂等——直接复用 Step 0 的 `consumeOnce()`。

## 2. 开源调研综合（2026-09-01 广泛检索）

> 检索方向：JD/职位信息抽取、LLM 结构化输出、聊天消息→结构化事实、招聘 agent、中文信息抽取、实体对齐去重。以下为对**本项目有直接启发**的代表性项目。

### 2.1 结构化抽取框架（借鉴机制，不引依赖）

| 项目 | 核心机制 | 对本项目的启发 | 是否引入 |
|---|---|---|---|
| **google/langextract**（38k★，Apache-2.0） | LLM 抽取后把每个字段**对齐回原文字符区间**（source grounding）；对不上原文的输出标记 `char_interval=None` 可过滤，天然挡掉 LLM 幻觉与从 few-shot 示例抄答案 | **原文锚定 = 可审计**。每个抽取字段带 `evidence`（原文引用片段），与账本 `envelope.evidence_refs` 的证据链理念完全同构。这是本项目最值得抄的一个思想 | ❌ Python 栈，不引。机制自实现 |
| **instructor-js**（instructor 的 TS 版，MIT） | 把 zod schema 传给 LLM，输出经 zod 校验；校验失败自动**重问（reask）**，多 provider 统一 | 「zod schema 约束 + 校验失败带错误信息重试」是保证输出结构的最低成本模式。DeepSeek 兼容 OpenAI `response_format=json_object`，够用 | ❌ 不引。zod 已在 deps，自建 ~40 行 |
| **CorrDyn/job-posting-structure**（亚马逊团队，论文发表） | 职位结构化抽取的生产级 prompt 架构：先 extract 主字段，可选二次 prompt 补技能/职业归类；**HTML 确定性解析类与 LLM 类并存** | 「规则层先行、LLM 层兜底」的双层架构有论文背书；还给了**用抽样对比调查数据做验证**的评测方法论 | 仅借鉴 prompt 结构 |

### 2.2 聊天消息→结构化事实（场景最接近）

| 项目 | 核心机制 | 对本项目的启发 |
|---|---|---|
| **ReNodeX/ai-delegator**（Telegram 群→线索） | 群消息 → GPT 分类「是否线索」→ 结构化保存 → 去重 → 限速外呼。分类与抽取分离、prompts 独立成文件、人工可调 | **先分类后抽取**：不是每条群消息都值得抽。加一个零成本的「职位相关」前置分类（规则即可命中 `Offer-` 群名 + 关键词），能砍掉大部分 LLM 调用。多群监控/去重/工作窗口的工程结构也值得对照 |
| **AmirrG1/ai-automation-agent** | 非结构化消息 → 清洗 → 字段抽取 → JSON 记录 → 入库，字段含 intent/location/budget/urgency | 证明「消息→记录」无需复杂框架，一个纯函数管线即可；字段分级（必抽/选抽/枚举）思路一致 |
| **megaDeathChav/asapp-project**（多模型对比） | 对 BERT/LLaMA/Gemini 做会话抽取精度对比，给了**字段级 accuracy 评测脚本**结构 | 提醒：换模型/换 prompt 必须有字段级评测集。本项目应从第一天就攒「消息原文 → 人工标准答案」的 gold set（fixtures 目录现成） |

### 2.3 招聘 agent 链路（可直接对照的完整实现）

| 项目 | 核心机制 | 对本项目的启发 |
|---|---|---|
| **punkisnotdead3/open_recruiter**（本地镜像见 [REFERENCE_REPOS](standards/REFERENCE_REPOS.md)） | JD/简历上传→LLM 自动抽取结构化字段；姓名+邮箱去重；向量匹配（ChromaDB+本地 embedding）+ LLM 深评双轨；**抽出的候选人/职位先建 profile 再人工关联**；Slack 群收简历→解析→去重→Top3 匹配回帖 | 与「Offer 群收消息」场景几乎同构。重点学它的：①**抽取与确认分离**（LLM 抽完先落草稿，不直接当真值）；②群渠道消息同样走「解析→去重→入 profile」管线；③PII 过滤（SSN/护照等剥离）对应本项目脱敏红线 |
| **interviewstreet/hiring-agent**（2.3k★） | 规则评分与 LLM 评分**双后端可切换**（Swappable Scoring Backends）；LLM 挂了规则层照跑 | 印证 kill-switch 设计：AI 层永远可选，规则层是保底。82% top-10 命中率说明纯 LLM 抽取（非微调）对招聘字段够用 |
| **farahdimshawy/RecruitmentAgent** | 抽取→检索→评分→排名分模块，模块边界清晰可测 | 模块划分方式与本项目 L1-L5 分层一致，确认现架构不缺东西 |

### 2.4 中文信息抽取（备选与兜底）

| 项目 | 定位 | 何时考虑 |
|---|---|---|
| **PaddleNLP UIE / PP-UIE**（百度，产业级） | schema 提示词驱动的中文抽取，零样本可用、5 条标注微调大涨；PP-UIE 0.5B 零样本 F1 超过 13B 级通用模型 | 仅当 DeepSeek 成本不可接受且需要离线/私有化时。Python/Paddle 栈与本项目 JS 运行时不匹配，**MVP 不采用**；作为路线图上的降级选项记录 |

### 2.5 实体对齐与去重（后期）

| 项目 | 核心机制 | 何时考虑 |
|---|---|---|
| **dedupeio/dedupe**（4.5k★）/ **moj-analytical-services/splink**（2.2k★） | 概率化记录链接、模糊匹配去重（Fellegi-Sunter 模型）；splink 支持 DuckDB 后端 | 「XX科技」vs「XX 科技有限公司」这类 company 归一。MVP 用**规范化键**（去空格/统一全半角/去「有限公司」后缀）+ 既有 `entity_links` 别名机制已够；语料上千条后再评估引入模糊匹配算法（JaroWinkler 纯 JS ~30 行可自建） |

## 3. 选型判断：借思想，不引依赖

**结论：全部机制自建，零新增运行时依赖。**理由：

1. 上述项目均为 Python 栈或引入即超 deps 上限；唯一 TS 可选的 instructor-js 的核心（schema 注入 + zod 校验 + 失败重试）约 40 行。
2. AGENTS.md §2 第一性原理：zod 已在 deps，DeepSeek 的 OpenAI 兼容接口自带 `response_format=json_object`，标准能力已解决。
3. 提炼层本质是「一个账本消费者 + 一个纯函数管线」，复杂度在 prompt 与评测，不在框架。

| 开源机制 | 本项目落法 | 落点 |
|---|---|---|
| langextract 原文锚定 | 每个抽取字段必须带 `evidence`（≤50 字原文引用），无 evidence 的字段降级为 `confidence='low'` 且不入权威字段 | `src/job-extract/schema.js` |
| instructor-js schema 约束 + 重试 | zod `jobFactsDraftSchema` parse；失败把 zod 错误拼回 prompt 重试 ≤2 次 | `src/job-extract/llm.js` |
| ai-delegator 先分类后抽取 | 规则分类器先行：`Offer-` 群名 + 职位关键词词典命中才进 LLM；未命中直接 `skip_irrelevant` 落账本 | `src/job-extract/classify.js` |
| hiring-agent 双后端可切换 | `AI_JOB_EXTRACT_ENABLED`（默认关）kill-switch；关着时纯规则层照跑，抽到的字段标 `source='rules'` | `src/job-extract/index.js` |
| open_recruiter 抽取与确认分离 | LLM 抽取落 **staging 表**（`active_state='UNKNOWN'`），经人工/MCP `brainx_confirm_facts` 才转正 | 迁移 0030 |
| asapp 字段级评测 | fixtures 攒 gold set：真实群消息（脱敏）→ 人工标注字段；`npm run extract:eval` 输出字段级准确率 | `fixtures/job-extract/` |

## 4. 架构：提炼层挂在账本上，是一个消费者

关键架构决策：**job_extract 不是新服务，是 L1 事件账本的一个消费者**。与既有 Step 0/1 设备完全咬合：

```text
L0 网关 processLarkEvent → appendEvent（账本，幂等）
                                │
                                ▼
              consumeOnce(db, eventId, 'job-extract', fn)   ← Step 0 幂等消费器，直接复用
                                │
              ┌───────────────┴────────────────┐
              ▼                                ▼
   ① 规则层（零成本，永远在）          ② LLM 层（AI_JOB_EXTRACT_ENABLED，默认关）
   群名解析 Offer-{团队}-{候选人}-{岗位}   DeepSeek json_object + zod schema
   状态关键词（暂停/关闭/offer/入职…）     失败重试 ≤2，仍失败 → toDlq('extract_failed')
   城市/HC 正则                          每字段带 evidence 原文引用
              │                                │
              └──────────┬─────────────────────┘
                         ▼
          job_facts_draft（staging，active_state='UNKNOWN'）
                         │  人工确认 / MCP brainx_confirm_facts
                         ▼
          job_facts 权威表（UPSERT，带 sync_id 血缘）
```

要点：

- **幂等免费拿到**：`consumeOnce` 保证同一条 message_id 不会被抽两次（LLM 调用也是钱，这点直接省钱）。
- **失败不丢**：LLM 抽取失败走既有 `event_dlq`（Step 0 已建），可重放。
- **实体对齐复用**：抽出的 company/role 先查 `entity_links` 五列解析（Step 0 已建），命中即关联既有 project_id，未命中才新建——去重第一层免费。

## 5. 抽取 schema（「信息需要结构」的具体答案）

`jobFactsDraftSchema`（zod，与 0001_init 的 job_facts 字段一一对应）：

```js
{
  company:  { text, evidence, confidence },   // confidence: high | medium | low
  role:     { text, evidence, confidence },
  city:     { text, evidence, confidence } | null,
  pipeline: { stage: 'SOURCING'|'SCREENING'|'INTERVIEW'|'OFFER'|'ONBOARD'|'CLOSED',
             evidence, confidence } | null,
  hc:       { number, evidence, confidence } | null,
  active_state: 'OPEN'|'CLOSED'|'ON_HOLD'|'COMPLETED'|'COOLING'|'UNKNOWN',
  event_refs: [{ table, id }],   // 指回 workflow_event_log，证据链闭合
}
```

- `evidence` 是 langextract 思想的落点：LLM 必须引用原文片段，规则层天然有（正则命中的就是原文）。
- `confidence` 规则：rules 命中 = high；LLM 有 evidence = medium；无 evidence = low。**low 不进 staging 的候选字段展示**，只留档。
- staging 转正规则：`active_state` 变更类（CLOSED/ON_HOLD 等）必须人工或 MCP 确认，杜绝「群聊一句气话把项目标停」。

## 6. 研发路径与时间线（对齐 9/3 demo → 9/14 deadline）

与[后端侧模块结构 §4](2026-09-02-backend-module-structure.md) 的排期合并视图（该表 P0/P1 不变，本表细化待补第 5 项）：

| 阶段 | 内容 | 工期 | 前置 | 可复用开源机制 |
|---|---|---|---|---|
| **E0（9/3 随 demo 顺带）** | 攒 gold set：York demo 当天真实群消息脱敏入库 `fixtures/job-extract/`，人工标 10-20 条 | 0.5 天（并行） | 网关跑通 | asapp 评测结构 |
| **E1 规则层 MVP** | `classify.js` + 群名解析 + 状态关键词 + staging 迁移 0030；挂 `consumeOnce('job-extract')`；**先不接 LLM** | 1 天 | L1 账本（已建成） | ai-delegator 分类先行 |
| **E2 LLM 层** | `llm.js`：DeepSeek json_object + zod 约束 + 重试 + evidence + DLQ；`AI_JOB_EXTRACT_ENABLED` 开关；`extract:eval` 对照 gold set | 1 天 | E1 | instructor-js 重试、langextract 锚定 |
| **E3 确认闭环** | MCP 新增 `brainx_confirm_facts`（带 jobVisibleTo 守门，遵守白名单规则）；staging→权威 UPSERT | 0.5 天 | 硬前置三件做完 | open_recruiter 抽取确认分离 |
| **E4（post-deadline）** | company 归一（规范化键 + entity_links 别名）；必要时 JaroWinkler；评测驱动的 prompt 迭代 | 按需 | E3 数据积累 | dedupe/splink 思想 |

**总计 E1-E3 = 2.5 天**，与模块结构文档给的「2 天」估算一致量级。P0（硬前置三件 + OpenMai 暴露 + talent cid 隔离 + 白名单）优先级不变，提炼层排其后。

### 不做清单

- 不引 PaddleNLP/UIE（栈不匹配，DeepSeek 够用且成本低）；
- 不做向量匹配式 job 匹配（open_recruiter 的 ChromaDB 那套）——本项目评分走既有 `scorer` 六维确定性评分，职责不重叠；
- 不让 LLM 直接写 `job_facts` 权威表（红线）；
- 不在 MVP 做跨块/多轮抽取（群消息天然短，langextract 的长文机制用不上）。

## 7. 验收标准

1. 一条真实 Offer 群消息（脱敏 fixture）入账本后，`consumeOnce('job-extract')` 产出一条 staging 草稿，字段带 evidence；重放同 message_id 不产生第二条（幂等）。
2. `AI_JOB_EXTRACT_ENABLED` 关闭时管线照跑且字段标 `source='rules'`；开启时才调 DeepSeek。
3. `extract:eval` 对 gold set 输出字段级准确率报告，company/role ≥ 80%（对照 hiring-agent 82% 基准）。
4. staging → 权威表必须经显式确认；`active_state` 变更无确认不落库（测试覆盖）。
5. deps 不新增；`npm run verify:quick` 基线不破。

## 相关文档

- [后端侧模块结构与下一步安排](2026-09-02-backend-module-structure.md) — 六层结构与待补清单（本文是其待补第 5 项的展开）
- [复用与自建边界及权限需求 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md) — 三色清单与 deps 约束的权威来源
- [全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md) — Step 0-7 总体施工顺序
- [参考代码本地镜像清单](standards/REFERENCE_REPOS.md) — open_recruiter 等镜像位置
- [工具外露白名单（全量）](2026-09-02-tool-exposure-whitelist.md) — `brainx_confirm_facts` 外露前必须遵守的守门规则
- [OpenClaw 接口包（给对方模块化信息）](2026-09-02-openclaw-interface-pack.md) — 同日产出的接缝文档

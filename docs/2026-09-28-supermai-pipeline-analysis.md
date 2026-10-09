# SuperMai 找人链路完全解析（2026-09-28 结构验证 + 生产实证）

> 上级目录：[BrainX 文档书](README.md)
>
> 验证方法：逐文件通读 `src/supermai-sourcing.js`、`src/openmai-task.js`、`src/openmai-delivery.js`、`src/agent-gateway/tools-jobs.js`、`src/ttcsdk/auth.js`、`src/openmai-result.js`、`src/search-rounds.js`、`src/project-launch.js`，对照 [specs/007](../specs/007-dual-sourcing-entries/spec.md) 契约逐条核对；生产侧只读查 47.110.93.137 `/opt/brainx/data/brainx.db`（openmai_results / ttc_tokens / ttc_credential_grants / workflow_event_log）+ openclaw 白名单与插件副本。本文是 SuperMai 链路结构与数据的**唯一权威解析**；规格契约归 specs/007，数据地基问题归[数据地基体检报告](2026-09-28-data-foundation-audit.md)。

## 1. 结论速览

| 维度 | 结果 |
|---|---|
| 代码结构 vs specs/007 契约 | ✅ 全部吻合（合成键/两段式/机器块/事件/白名单五项逐条过） |
| 生产运行数据 | ✅ 健康：sm_ 任务 47 条终态，成功率 89.4%，09-10 起**零失败**，running 残留 0 |
| 白名单/插件副本 | ✅ `brainx_supermai_scout` 与 `brainx_openmai_search` 均在生产 tools.allow 与插件真实副本中 |
| 结构差异点（两入口不对齐） | 🟡 3 处：凭证降级路径、needs_input 语义、判据太窄时的兜底文案——均低风险，登记备查 |
| 审计回溯 | 🟡 续搜 UPSERT 覆盖前轮 result_text，历史轮次文本只能靠事件表（无正文）+ 飞书卡片 |
| 凭证到期风险 | 🔴 york 2026-10-13 到期（15 天）、otto needs_reauth=1 已失效 |

## 2. 链路全景（四层）

```
入口层（两个，共用引擎）
├─ A1 私聊/群聊自然语言 → agent-gateway
│    brainx_supermai_scout(args, principal)          tools-jobs.js:386
│    ├─ 无 job_id：自由找人（判据模式）
│    └─ 有 job_id：项目模式（SuperMai 渠道给已接单职位找人）
└─ A2 项目群卡片「SuperMai 找人」按钮                project-launch.js:102,113
     按钮注入指令 → openclaw → 同 A1（必带 job_id）

凭证层
└─ getValidTtcJwt(db, consultant_id)                  ttcsdk/auth.js:48
   仅认本人 ttc_tokens（AES-GCM 解密；过期/needs_reauth → null 快速失败）
   ⚠️ 与 openmai 入口不同：不吃 ttc_credential_grants 团队授权（见 §5-D1）

引擎层（与 openmai 入口同一引擎）
└─ callOpenmaiContent(jwt, buildScoutPrompt(criteria, exclusions), {})   openmai-task.js:143
   ├─ POST gateway.ttcadvisory.com/api/openmai/v1/completions（SSE，无 job_id）
   ├─ SESSION_ISOLATION_PREAMBLE 会话隔离前言（防账号级上下文污染）
   ├─ SSE 帧解析 → deferred 异步轮询（35min 上限）→ 持久化消息兜底
   └─ looksLikeSessionPollution 污染检测 → 自动重试一次 → 仍污染则失败关闭

落库/交付层
├─ openmai_results（主键 project_id+consultant_id，task_id 前缀 sm_）
│    ├─ 自由模式：project_id = supermai:<sha256(criteria) 前 12 位>（合成键
│    │   匹配不到 project_launches → 不会触发项目群投递副作用，specs/007 契约）
│    └─ 项目模式：真实 project_id → 完成后 worker enqueueOpenmaiDeliveries 投递回原群
├─ 结果解析：BRAINX_CANDIDATES_V1 机器块 → extractOpenmaiCandidates（≤10 人）
├─ 发卡：buildOpenmaiDeliveryCard（freeform 模式无深链、电话/邮箱脱敏、soloAction 右对齐）
└─ 事件：sourcing.search_started / search_finished（specs/019，idem_key 幂等留痕）
```

## 3. 触发/读取两段式语义（工具行为）

**触发侧**（首次或 `continue_search=true`）：
1. 三重闸门：`running` 内存集合 → `already_done`（done 复用）→ 失败 60s 冷却。
2. 项目模式附加闸门：职位可见性 `jobVisibleTo` / `jobAccessibleFromGroup`，状态须 ACCEPTED/COMPLETED 或群上下文，否则 `JOB_NOT_ACCEPTED`；另有 `activeProjectSearch` 共享任务短路（openmai/supermai 任一渠道 RUNNING 即复用，不双跑烧钱）。
3. `continue_search=true` 必须先 `nextSearchExclusions` 生成累计排除名单（无排除项时 `missingExclusions` 拒绝新一轮），`force=true` 才覆盖 done。
4. 触发成功返回 `triggered` + 提示词纪律：「回复顾问正在找人并结束本轮，不要原地轮询」（项目模式）/「每隔约 1 分钟读取，最多守候 10 分钟」（自由模式）。

**读取侧**（同参数再调）：
- `running` → 返回进度 + 轮询纪律提示；`done` → 结构化 candidates + result_text。
- `done` + 群上下文 → **确定性发结果卡**（`card_delivered: true`，envelope 不带名单——模型只回一句话引导，2026-09-16 linda 实证后固定）。
- `done` + result_text 为 NO_REPLY/空 → `empty_reason: NO_MATCHES_FOUND`（语义化为「未搜到」而非假成功）。

## 4. 防重与费用控制四层

| 层 | 机制 | 位置 |
|---|---|---|
| 1 | 内存 `running` Set（进程内并发互斥） | supermai-sourcing.js:26 |
| 2 | DB 主键 (project_id, consultant_id) UPSERT，重跑清空 error/result_text | supermai-sourcing.js:101 |
| 3 | done 默认复用（already_done），新一轮必须显式 continue_search | supermai-sourcing.js:67 |
| 4 | 失败 60s 冷却；无凭证快速失败（落 failed + 引导扫码，不空转） | supermai-sourcing.js:69,72 |

僵尸回收：worker `failStaleOpenmaiTasks` 每 60 分钟把超龄 running 置 failed（按 task_id 前缀 `sm_` 识别 supermai 渠道），避免服务中断后任务永久卡 running、重复烧费。

## 5. 结构验证结果（对照 specs/007 契约逐条）

| 契约条目 | 实现现状 | 判定 |
|---|---|---|
| 合成键 `supermai:<sha256 前 12>` 不触发群投递 | supermai-sourcing.js:29 + enqueueOpenmaiDeliveries 的 JOIN 天然不命中 | ✅ |
| 两段式触发/读取、BRAINX_CANDIDATES_V1 机器块 | buildScoutPrompt 与 job 模式同格式，渠道表述「猎聘、脉脉」 | ✅ |
| 移除旧 web sourcing API 全部代码 | 仓库 src/ 无 callApi/searchLinkedin 等残留（本轮 grep 复核） | ✅ |
| 完成后 emit supermai_result 事件 | bus.emit + workflow_event_log 双留痕 | ✅ |
| 工具名不变（白名单免改） | 生产 tools.allow 含两工具；插件真实副本（/var/lib/brainx/.openclaw/extensions/）同步 | ✅ |
| 判据自由模式 5..2000 字 | criteria ≥5 字校验 + 2000 截断 | ✅ |

**发现的结构差异点（两入口不对齐，非契约违约）**：

- **D1 凭证降级路径**：supermai 用 `getValidTtcJwt`（仅本人凭证）；openmai 用 `getAuthorizedTtcJwt`（本人 + `ttc_credential_grants` OPENMAI 共享授权）。生产 grants 表当前为空，实际能力等价；但若未来某顾问无凭证想借团队凭证，只有 openmai 入口能走。specs/007 未明确该差异——如需对齐，属一次最小改动（supermai 换 getAuthorizedTtcJwt），需先拍板。
- **D2 needs_input 语义缺失**：openmai 入口对「需要补充职位信息」类回复落 `needs_input` 状态；supermai 侧 settle 只用 done/failed，判据太窄的澄清回复会落 done + 空候选人，靠读取侧 `empty_reason: NO_MATCHES_FOUND` 与群卡「候选人不足」兜底。生产 107 条终态里 needs_input 为 0，该分支从未触发，风险极低。
- **D3 项目模式判据合成**：supermai 项目模式 `criteria = projectCriteria(job, extra)`（拼职位事实 + 顾问补充），判据质量依赖 job_facts 字段完备率——受[池子数据准确度诊断](audits/2026-09-28-pool-data-accuracy-diagnosis.md)记录的字段缺口影响。

## 6. 生产数据实证（2026-09-28 只读查询）

**任务分布**（openmai_results，task_id 前缀区分引擎）：

| 引擎 | done | failed | 成功率 | 失败时间分布 |
|---|---|---|---|---|
| sm_（supermai） | 42 | 5 | 89.4% | 全部集中 09-08/09-09「stream interrupted」 |
| om_（openmai） | 47 | 11 | 81.0% | — |

- sm_ 总量 47：自由找人（supermai:% 合成键）43 条 + 项目模式（真实 project_id）4 条。
- **09-09 会话隔离前言上线后 sm_ 零失败**（最后一条失败 09-09 09:30）——污染防护实证有效。
- running 残留 0，worker 回收健康。
- 最近使用：09-23 frankie 自由找人、09-24 mia JLPJBV9 第 7 轮续搜（多轮续搜链路实际在用）。

**事件留痕对账**（workflow_event_log，specs/019 上线后）：
- supermai 4 对 started/finished + openmai 1 对，全部 success；与 09-20 后 sm_ 任务逐条对上（JLPJBV9 的 10:07/10:17 事件行数多于 openmai_results 行数，是 force 续搜 UPSERT 覆盖同一主键行所致，append-only 事件表是完整审计线）。
- 019 上线前的历史任务无 sourcing 事件（历史缺口，非现行问题）。

**凭证状态**（ttc_tokens，10 顾问有凭证）：

| 风险 | 顾问 | 详情 |
|---|---|---|
| 🔴 到期 | york | 2026-10-13 到期（15 天），到期前需本人重新粘贴 JWT |
| 🔴 失效 | otto | needs_reauth=1，当前不可用 |
| 🟢 正常 | mia/felix/linda/wendy/shanon | 2026-10-19 到期（21 天） |
| 🟢 正常 | frankie / hiroshi / miya | 2026-10-26 / 11-09 到期 |

注意 JWT 为 ~60 天周期滚动凭证，**每月固定动作**：到期前让对应顾问回 TTC 重新登录复制粘贴。

## 7. 续搜与排除名单机制（正确理解 openmai_results 主键语义）

主键 (project_id, consultant_id) 决定：**每顾问每项目只保留最后一轮**。force 续搜时：

1. 读取侧 `nextSearchExclusions`（search-rounds.js:32）汇总该 project_id 下所有行的 `excluded_candidate_refs_json`（累计名单）+ 当前 result_text 提取的 TTC 编号（supermai 自由找人产出的编号无 talent_url，靠 `task_id 前缀 om_` 才默认信任 TTC 编号——sm_ 行必须有 talent_url 才计入排除，防误排）。
2. 新一轮把合并后名单写回 `excluded_candidate_refs_json`，result_text 被清空重写。
3. **前几轮的 result_text 不留档**：回溯审计只有 workflow_event_log（只有 count/status 无正文）+ 飞书群卡片快照。如需完整轮次留档，须改表结构（非目标，未立项）。

## 8. 相关文档

- [specs/007 找人双入口规格](../specs/007-dual-sourcing-entries/spec.md)：契约唯一权威
- [数据地基体检报告](2026-09-28-data-foundation-audit.md)：本轮任务的结构问题登记（S1-S10）
- [数据读取链路与错位诊断规范](2026-09-24-data-reading-pipeline.md)：W/R/A-D 分类体系
- [池子数据准确度诊断](audits/2026-09-28-pool-data-accuracy-diagnosis.md)：D3 判据质量的字段缺口来源
- [OpenClaw 多顾问生产运行手册](2026-09-03-openclaw-production-runbook.md)：白名单与插件副本运维

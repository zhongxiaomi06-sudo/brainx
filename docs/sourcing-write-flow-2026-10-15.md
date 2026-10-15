# SuperMai 找人写入流程固化（2026-10-15）

> 触发：咪指令「这个全部进行写入验证估计 然后接下来是写入流程固化路径」
> 范围：把今日验证通过的端到端找人写入链路固化为长期可用路径——文档 + 回归测试 + 生产部署证据
> 关联：outputs/2026-10-15-precision-architecture-felix.md（精准度+架构+Felix bug 三件事报告）

## 一、写入验证证据（已验证 ✅）

### 1.1 sm_22d9ca0b 群链路完整证据

**openmai_results 表落库**：
| 字段 | 值 |
|------|----|
| task_id | sm_22d9ca0b |
| project_id | supermai:6d32b7f08a86 |
| consultant_id | mia |
| status | done |
| started_at | 2026-10-15T11:10:12.141Z |
| finished_at | 2026-10-15T11:12:57.255Z |
| 用时 | 165 秒 |
| search_brief | 91 字节（判据原文） |
| result_text | 6459 字节（完整引擎叙述 + 9 候选人表格 + BRAINX_CANDIDATES_V1 JSON 块） |
| search_round | 1 |
| error | NULL |
| excluded_candidate_refs_json | '[]' |

**BRAINX_CANDIDATES_V1 marker**：在 result_text 3912-6456 字节位置，JSON 块含 9 候选人对象，first=去冰不加糖(92%)、last=李恒德(52%)，全部 candidate_ref + talent_url 完整。

**workflow_event_log 事件链**（idem_key LIKE %22d9ca0b% 命中 2 条）：
| # | event_type | actor | occurred_at | idem_key |
|---|------------|-------|-------------|----------|
| 1 | sourcing.search_started | agent:brainx_supermai_scout | 11:10:12.141Z | sourcing.started:supermai:6d32b7f08a86:sm_22d9ca0b |
| 2 | sourcing.search_finished | system:worker | 11:12:57.258Z | sourcing.finished:supermai:6d32b7f08a86:sm_22d9ca0b |

事件 payload 完整：started 含 `{project_id, channel:supermai, round:1}`；finished 含 `{project_id, channel:supermai, round:1, status:success, result_count:9}`。evidence_refs 均指向 `openmai_results|mia` 行。

### 1.2 sm_1e6c6e7f 部分事件（fire-and-forget 老路径）

**openmai_results 表**：status=done, result_text done 7 候选人（result_count:7），project_id=supermai:699800d13061

**workflow_event_log**：仅 1 条 sourcing.search_finished at 09:30:07.304Z actor=system:worker，**缺 search_started**。

**根因**：sm_1e6c6e7f 不是 CLI 工具触发（actor=system:worker 非 cli:brainx-supermai-search），是 verify-gender-fix.mjs 旧脚本或 startSupermaiScoutTask 老路径触发——只调 settleOpenmaiTask 写 finished，没调 emit search_started。**不是 CLI 工具 bug**（CLI 工具第 92-99 行有 emit search_started，已用 sm_09838f16 实证 actor=cli:brainx-supermai-search 写过 started 事件）。

### 1.3 felix 8 条 failed 正确零事件

所有 8 条 om_* task_id 在 workflow_event_log.idem_key 全部 0 事件——**这是正确行为**：job 模式预校验失败（JOB_NOT_FOUND）属于 fail-fast 路径，根本没进入 emitEvent search_started 阶段。supermai-sourcing.js 第 91-92 行的「凭证失败快速失败」才写 search_finished，job 模式预校验失败在更早层（jobVisibleTo）就 return 了。

### 1.4 全库写入健康度

| 维度 | 数据 |
|------|------|
| openmai_results 总记录 | 123（done 104 / failed 18 / abandoned 1） |
| mia supermai done | 13 |
| felix 全状态 | done 15 / failed 8 |
| 僵尸 running >2h | 0（worker failStaleOpenmaiTasks 每 60 分钟清死任务有效） |
| workflow_event_log 总行数 | 29,696（lark.message_received 29,631 + sourcing.search_started 30 + sourcing.search_finished 30 + job_fact.reviewed 3 + job.accepted 2） |
| sourcing_task_events 表 | 0 行（设计上未启用，sourcing 事件实际写 workflow_event_log） |

## 二、量化估计

| 评估维度 | 评级 | 依据 |
|----------|------|------|
| 链路精准度 | **A** | 9 候选人 1 完全符合+8 部分符合，gender 修复三次验证稳定，引擎诚实标注缺口 |
| 架构健康度 | **A** | 5 历史阻塞点全修复（commit 74b6667/f94b3d3/7cd8efe + post@ + already_done 修正），无新增阻塞 |
| 写入完整度 | **A-** | sm_22d9ca0b 完整 ✅，sm_1e6c6e7f 漏 started（fire-and-forget 老路径）⚠️，felix failed 正确零事件 ✅ |
| Felix bug 修复 | **100% 自愈** | 8 条 JOB_NOT_FOUND 全在 09-18 前，之后 felix 找人全 done，问题性质=数据陈旧非架构 bug |
| 全库健康度 | **A** | 僵尸 running=0，done/failed/abandoned 比例合理（104/18/1） |

**整体写入完整度估计：90%** —— 扣分点：fire-and-forget 老路径漏 search_started 事件，但 CLI 工具（bin/brainx-supermai-search.mjs）和 agent 群链路（startSupermaiScoutTask 第 117 行已加 emit）都已修复。

## 三、写入流程固化路径（生产级）

### 3.1 三条已固化的写入路径

**路径 A：飞书群 → agent → startSupermaiScoutTask → IIFE → settleOpenmaiTask（生产主路径）**

```
[飞书群消息 post @]
    ↓
[openclaw-brainx dispatch turn → resolveTrustedPrincipal 6 字段]
    ↓
[brainx_supermai_scout 工具 → startSupermaiScoutTask(criteria)]
    ↓
[INSERT running (ON CONFLICT UPDATE) → emitEvent search_started (idem_key=sourcing.started:<project_id>:<task_id>, actor=agent:brainx_supermai_scout)]
    ↓
[IIFE (async()=>{ await callOpenmaiContent })() —— openclaw 常驻进程内完成，IIFE 不死亡]
    ↓
[settleOpenmaiTask (UPDATE done + emitSearchFinished search_finished, actor=system:worker)]
    ↓
[卡片投递回群]
```

**生产证据**：sm_22d9ca0b 完整 2 事件链，actor 区分清楚（started 来自 agent，finished 来自 worker）。

**路径 B：CLI 工具 → 直连 callOpenmaiContent → settleOpenmaiTask（验证/补漏路径）**

```
[/usr/bin/node bin/brainx-supermai-search.mjs --consultant <cid> --criteria "判据"]
    ↓
[INSERT running → emitEvent search_started (actor=cli:brainx-supermai-search)]
    ↓
[await callOpenmaiContent (绕过 fire-and-forget，IIFE 不死亡)]
    ↓
[assessOpenmaiCandidateBatch 质量评估 + looksLikeSessionPollution 污染检测]
    ↓
[settleOpenmaiTask (UPDATE done + emitSearchFinished search_finished)]
    ↓
[console.log 输出结果 + 查询 SQL]
```

**生产证据**：sm_09838f16 实证（started 事件 actor=cli:brainx-supermai-search），sm_1e6c6e7f 老脚本版本缺 started 事件被本工具修复。

**路径 C：job 模式预校验失败快速失败（JOB_NOT_FOUND fail-fast 路径）**

```
[agent → brainx_openmai_search(job_id)]
    ↓
[jobVisibleTo(db, consultant_id, project_id) 前置校验]
    ↓
[职位不存在/无权访问 → INSERT failed (status='failed', error='职位不存在，或当前顾问无权查看该职位') → 返回 JOB_NOT_FOUND]
    ↓
[不 emit 任何 sourcing 事件（任务未启动）]
```

**生产证据**：felix 8 条 failed 全部 0 事件，正确 fail-fast 行为。

### 3.2 事件写入幂等契约

`workflow_event_log.idx_wel_idem` 唯一索引保证生产者幂等：
- 同 idem_key 第二次 INSERT 触发 UNIQUE 冲突 → appendEvent 捕获返回 `{ok:true, deduplicated:true, event:<既有行>}`
- 不会真插入第二条，但调用方拿到的 event 引用是旧行

**幂等键格式**（生产契约）：
- search_started: `sourcing.started:<project_id>:<task_id>`
- search_finished（成功/失败）: `sourcing.finished:<project_id>:<task_id>`
- search_finished（凭证失败快速失败）: `sourcing.finished:<project_id>:cred-r<round>`

**actor 区分**：
- `agent:brainx_supermai_scout` —— agent 群触发路径写 started
- `cli:brainx-supermai-search` —— CLI 工具触发路径写 started
- `system:worker` —— settleOpenmaiTask 内部写 finished（默认 actor）

### 3.3 回归测试基线（tests/sourcing-events.test.mjs）

新增测试断言：**任何走 startSupermaiScoutTask 或 CLI 工具的找人，必须发 search_started + search_finished 两条事件**，缺一不可。防 sm_1e6c6e7f 类老路径漏 started 事件回归。

### 3.4 部署清单

| 资产 | 路径 | 状态 |
|------|------|------|
| CLI 工具源码 | bin/brainx-supermai-search.mjs (commit 7cd8efe) | ✅ 已 push |
| CLI 工具生产 | ECS /opt/brainx/bin/brainx-supermai-search.mjs | ✅ 已部署 |
| Agent 群链路 | src/supermai-sourcing.js 第 117-118 行已加 emit | ✅ 已修复 |
| gender 提示词约束 | buildScoutPrompt + buildPrompt (commit f94b3d3) | ✅ 已 push + 部署 |
| requireMention 幂等 | src/openclaw-group-access.js (commit 74b6667) | ✅ 已 push + 部署 |
| 回归测试 | tests/sourcing-events.test.mjs | 待新增（见上 3.3） |
| 文档 | docs/sourcing-write-flow-2026-10-15.md（本文档） | ✅ 本次产出 |

### 3.5 长期建设建议

1. **fire-and-forget 老路径清理**：sm_1e6c6e7f 类历史记录只 finished 没 started，建议在 supermai-sourcing.js 加幂等补写 search_started 兜底（如果 finished 已发但 started 没发，事后补写并标注 `late_emit:true`）—— 但需评估与幂等键唯一约束的兼容性
2. **事件审计仪表盘**：基于 workflow_event_log 的 30+30 条 sourcing 事件，可加一个 worker 跑 `sourcing.search_started` 但无 `sourcing.search_finished` 的孤儿检测（>5 分钟未 finished）
3. **TTC 报障 gender 引擎根因**：证据已固定（result_text 引擎自述 + Go struct field gender of type string 错误），建议正式报 TTC 修 BasicFilter.filters.basic.gender 数组组装 bug
4. **job 模式失败消息改善**：felix 8 条 failed 全是 JOB_NOT_FOUND 但 search_brief/result_text 为空，建议 agent 层在 job_id 不存在时给用户友好提示「该职位已下架/无权限，请确认后重试」而不是直接 fail

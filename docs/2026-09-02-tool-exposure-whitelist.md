# 工具外露白名单（全量）

> 上级入口：[BrainX 文档书](README.md) · [OpenClaw 壳子架构](2026-09-02-openclaw-shell-architecture.md) §5.2
>
> 定位：**挂在 OpenClaw 之前，哪些工具允许外露的唯一权威**。Skill 生成流水线（架构文档 §5.1）只能遍历本文白名单内的工具。
>
> 拆分说明（9/2 晚）：本内容原属架构文档 §5.2-§5.4，因白名单需持续增补、且原文已超 500 行上限，按仓库规矩独立成文。

## 1. Agent 内部工具集白名单（registry.js 那套，9/2 实测）

（本节依据：逐个读 `src/agent/registry.js` 与 `src/agent/tools/*.js` 的 schema + 隔离实现。挂进 OpenClaw 之前必须先定白名单——[架构文档 §5.1](2026-09-02-openclaw-shell-architecture.md) 的 Skill 生成流水线只能遍历白名单内的工具。）

按外露难度分三档：

#### 第一档 ✅：直接外露（9 个）

| 工具 | 隔离性 | 判定理由 |
|---|---|---|
| `brainx_consultants` | 全局（仅 consultant_id + display_name） | 花名册，不含业务数据 |
| `brainx_workbench` | 恒为会话 cid | 工作台首屏仅本人 |
| `brainx_recommendations` | 恒为 cid；同步不完整时返回 blocked | 自身有守门 |
| `brainx_profile` | 仅本人 | 顾问自己的画像 |
| `brainx_radar` | 当前顾问可见 | 雷达不含候选人 |
| `brainx_clients` | 当前顾问可见 | 客户公司聚合不含候选人 |
| `brainx_progress_suggestion` | jobVisibleTo 守门 | 仅本人可见职位 |
| `brainx_push_preview` | 仅本人 | 推送卡预览 |
| `brainx_replay` | 跨人 = NOT_FOUND | 决策回放 |

#### 第二档 ⚠️：需脚本级脱敏后外露（3 个）

| 工具 | 问题 | 改造方向 |
|---|---|---|
| `brainx_opportunity` | `job_facts` 表里若含客户 BD 联系人字段，会跨出"顾问可见"边界 | **先看 `job_facts` 的 migrations 字段**确认无客户敏感字段；否则在 `scripts/` 输出脚本内投影 |
| `brainx_openmai_result` | 结果是候选人池 markdown，可能含候选人摘要/联系方式 | 输出脚本只回 `run_id` + `status` + 候选人 ID 列表；候选人详情走 `evidence_ref` |
| `brainx_talent_supply` | Top 匹配含候选人 | 只回可匹配人数/难度/命中词，不回候选人 ID 以外的字段 |

#### 第三档 ❌：禁止外露（3 个）

| 工具 | 硬指标 |
|---|---|
| **`brainx_talent`** | **没有 cid 隔离**——它从 MySQL 全局查任何人，挂进群里等于任何群成员都能查所有候选人的手机号/邮箱/简历。**最危险的工具** |
| **`query_sql`** | 让 agent 直查 SQLite 决策库，SQL 注入面从 Web 直接扩到群里 |
| `brainx_load_skill` | 元工具（加载技能手册），对外没价值；只会让用户拿到内部 agent 协议 |

#### 改造项落地顺序（9/14 前）

1. **`talent_supply` 输出脚本脱敏**（看 `src/talent-supply.js` 找到字段出口）——今天可搞
2. **`openmai_result` 输出脚本脱敏**——明天可搞
3. **`opportunity` 看 `job_facts` 字段**——看 migrations 0024 之类的 job_facts 表定义，1 小时内可决；有问题再改脚本
4. **`talent` 改造为"我承接过的候选人"视角**（受 cid 隔离）→ 改名 `brainx_talent_mine`——**涉及接口签名变更和 MySQL 查询改造，9/14 前不一定能完成，列入决赛后清单**

#### 与 §5.1 流水线对接

白名单是流水线的输入。生成 Skill 时 AI 只遍历：
- 第一档全部（9 个）
- 第二档中脱敏脚本完成后的项
- 第三档始终排除——`registry.js` 的 `TOOL_ROWS` 里可以加 `exposeable: false` 标记，AI 跳过

`brainx_talent` 因为历史 SKILL.md（`skills/brainx-talent/SKILL.md`）已经存在且描述里含 `brainx_talent({...})` 工具调用记号，**生成前要从 schema 里移除它的可见性，或在 MCP server 启动时直接挂黑名单**。否则 MCP server 一挂上它就暴露。

## 2. 工具集纠正：是两套，不是一套（9/2 晚核实）

**§5.1 与 §5.2 之前默认「15 个只读工具」是同一个集合，这是错的。** 仓库里有两套工具，各 15 个，**交集只有 8 个**：

| 集合 | 位置 | 用途 | 读写构成 |
|---|---|---|---|
| **Agent 内部工具集** | `src/agent/registry.js` 的 `TOOL_ROWS` | Codex CLI / Claude Code / OpenCode 等本地 agent 调用 | 以读为主 |
| **对外 MCP 工具集** | `mcp/server.mjs` 的 `TOOLS` | 经 MCP 协议暴露给外部 Agent（含 OpenClaw） | **7 读 + 8 写** |

```text
registry.js（15）                    mcp/server.mjs（15）
├─ radar            ← 独有          ├─ recommend_run   ← 独有（写）
├─ clients          ← 独有          ├─ feedback        ← 独有（写）
├─ talent           ← 独有          ├─ engage          ← 独有（写）
├─ talentSupply     ← 独有          ├─ record_progress ← 独有（写）
├─ openmai          ← 独有          ├─ terminal_result ← 独有（写）
├─ query_sql        ← 独有          ├─ record_outcome  ← 独有（写）
├─ load_skill       ← 独有          ├─ sync_now        ← 独有（写）
└─ 交集 8 个 ────────────────────────┘
   consultants / workbench / recommendations / opportunity
   progress_suggestion / replay / profile / push_preview
```

**直接影响两处：**

1. **§5.1 生成素材要指明用哪一套。** 生成 Skill 应基于 **MCP server 那套**（因为 Skill 经 MCP 调用），registry 独有的 7 个（radar / clients / talent / talentSupply / openmai / query_sql / load_skill）**在 MCP server 里根本不存在**，写进 Skill 会调用失败。
2. **§5.2 白名单只审了 registry 那套，MCP 独有的 7 个从未审查** —— 而这 7 个**全是写操作**。下面是补审结果。

## 3. MCP server 独有写操作补审（9/2 晚实测）

逐个读 `mcp/server.mjs` 的 `run` 实现，看有没有 `jobVisibleTo(db, cid, pid)` 守门：

| 工具 | 守门 | 判定 | 理由 |
|---|---|---|---|
| **`brainx_sync_now`** | **无** | **❌ 禁止外露（最危险）** | 默认 `source='fixture'` 且 `dry_run=false`——**群里一句话就能把决策库刷成 fixture 测试数据，直接落库** |
| `brainx_record_outcome` | **无** | ❌ 补守门前禁止 | `src/replay.js:35` 只校验 `job_facts` 里职位**全局存在**，不校验归属，**可给任意职位录结果** |
| `brainx_recommend_run` | 无（限自己 cid） | ⚠️ 限流后外露 | 可被反复调用重置推荐轮次；虽只作用于本人，但会打乱推荐快照 |
| `brainx_feedback` | 无 `jobVisibleTo`（限自己 cid） | ⚠️ 待核 | 需确认 `recommendationFeedback` 内部是否校验职位归属 |
| `brainx_engage` | ✅ `jobVisibleTo` | ✅ 可外露 | **接单（ACCEPT）核心动作，守门正确** |
| `brainx_record_progress` | ✅ `jobVisibleTo` | ✅ 可外露 | 进展记录 |
| `brainx_terminal_result` | ✅ `jobVisibleTo` | ✅ 可外露 | 入职/关闭终局 |

**`brainx_sync_now` 比 `brainx_talent` 更危险，性质不同：**

- `brainx_talent` 是**泄漏**——候选人隐私进了群。
- `brainx_sync_now` 是**破坏**——`source='fixture'` 默认参数会把真实决策库覆盖成测试数据，且默认 `dry_run=false` 直接落库，没有二次确认。**隐私泄漏能补救，数据被刷没得救。**

**必须做的三件事（P0，在 MCP server 挂进 OpenClaw 之前）—— ✅ 9/2 晚已完成第 1、2 件：**

1. ✅ `brainx_sync_now` 加入启动黑名单（`mcp/server.mjs` `BLOCKED_TOOLS` 集合，`tools/list` 过滤 + `tools/call` 显式报错；`brainx_talent` 一并列入）。默认参数仍是 `source='fixture'`+`dry_run=false`，但已不可触达；未来解封前须先把默认值改为 `dry_run=true` 且禁止 `source='fixture'` 走非 dry_run。
2. ✅ `brainx_record_outcome` 补 `jobVisibleTo` 守门（与 `engage` / `record_progress` 对齐——run 块接线，`src/visibility.js` fail-closed 实现本就共用）。守门测试 `tests/mcp-write-guard.test.mjs` B3/B4/B5 用例覆盖。
3. ⬜ `brainx_recommend_run` 加调用频率限制（未做）。

> **守门策略不一致是根因。** `engage` / `record_progress` / `terminal_result` 三个都规规矩矩调了 `jobVisibleTo`，`record_outcome` 却漏了。这不是设计取舍，是遗漏。

## 4. 合并后的最终白名单（照这一栏执行）

把 §1（registry 那套）与 §3（MCP server 那套）合并去重，按"当前在哪 + 能不能露 + 露之前要做什么"排。**只有 ✅ 行可以直接写进 Skill。**

| 工具 | 当前在哪 | 读写 | 判定 | 外露前必须做的事 |
|---|---|---|---|---|
| `brainx_consultants` | 两套都有 | 读 | ✅ | — |
| `brainx_workbench` | 两套都有 | 读 | ✅ | — |
| `brainx_recommendations` | 两套都有 | 读 | ✅ | — |
| `brainx_profile` | 两套都有 | 读/写 | ✅ | 仅本人，OK |
| `brainx_progress_suggestion` | 两套都有 | 读 | ✅ | — |
| `brainx_replay` | 两套都有 | 读 | ✅ | — |
| `brainx_push_preview` | 两套都有 | 读 | ✅ | — |
| `brainx_engage` | **仅 MCP** | 写 | ✅ | 接单核心动作，`jobVisibleTo` 守门正确 |
| `brainx_record_progress` | **仅 MCP** | 写 | ✅ | 守门正确 |
| `brainx_terminal_result` | **仅 MCP** | 写 | ✅ | 守门正确 |
| `brainx_opportunity` | 两套都有 | 读 | ⚠️ | 先查 `job_facts` migrations 有无客户 BD 联系人字段 |
| `brainx_recommend_run` | **仅 MCP** | 写 | ⚠️ | 加调用频率限制 |
| `brainx_feedback` | **仅 MCP** | 写 | ⚠️ | 核 `recommendationFeedback` 是否校验职位归属 |
| `brainx_talent_supply` | 仅 registry | 读 | ⚠️ | 脱敏脚本 + 决定是否加进 MCP server |
| `brainx_openmai_result` | 仅 registry | 读 | ⚠️ | 脱敏脚本 + 加进 MCP server（架构 P0-1） |
| `brainx_radar` | 仅 registry | 读 | ⚠️ | 决定是否加进 MCP server |
| `brainx_clients` | 仅 registry | 读 | ⚠️ | 同上 |
| **`brainx_sync_now`** | **仅 MCP** | 写 | **❌ 禁止** | **改默认值为 `dry_run=true` 且禁 `fixture` 落库，或直接进黑名单** |
| **`brainx_talent`** | 仅 registry | 读 | **❌ 禁止** | 无 cid 隔离；改造为 `brainx_talent_mine` 后重评 |
| **`brainx_record_outcome`** | **仅 MCP** | 写 | **❌ 禁止** | 补 `jobVisibleTo` 守门后重评 |
| `query_sql` | 仅 registry | 读 | ❌ 禁止 | SQL 注入面扩到群里 |
| `brainx_load_skill` | 仅 registry | 读 | ❌ 禁止 | 元工具，对外无价值 |

**给 AI 生成 Skill 用**：只喂 ✅ 行的 schema 当素材。⚠️ 行等改造完成后再补，❌ 行永远不喂。

## 5. 防止再漏的机制

这次发现 `record_outcome` 漏守门、`sync_now` 默认参数危险，都是"新增工具时没有检查清单"导致的。建议加一条测试兜底：

```js
// tests/mcp-write-guard.test.mjs
// 遍历 mcp/server.mjs 的写工具，断言其 run 实现内含 jobVisibleTo 或等效守门
// 新增写工具时若漏守门，测试直接失败
```

**人工 checklist（新增任何 MCP 工具时必过）**：

1. 有没有 `jobVisibleTo`（或等效的归属校验）？
2. 默认参数是否安全（不允许 `dry_run=false` + 破坏性默认值组合）？
3. 输出里有没有候选人手机号 / 邮箱 / 简历原文？
4. 写操作有没有幂等键？
5. 加进本文 §4 表格了吗？

## 相关文档

- [OpenClaw 壳子架构](2026-09-02-openclaw-shell-architecture.md) — §5.1 Skill 生成流水线、§5.2 白名单摘要
- [下游交付文档](2026-09-02-brainx-mcp-deliverable.md) — MCP server 契约与工具清单
- [业务工作全景](2026-09-02-business-work-breakdown.md) — 每个业务动作走哪个工具
- `mcp/server.mjs` · `src/agent/registry.js` · `src/visibility.js`

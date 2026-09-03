# BrainX 后端架构核实与验收基线（2026-09-02）

> 上级入口：[BrainX 文档书](README.md) · [缺口与下一步总表](2026-09-02-gap-and-next-actions.md)
>
> 定位：**回答"后端现在是什么样、还缺什么、什么算做完"的代码核实文档。**
> 本文不是项目产品 PRD；产品目标与范围只以[唯一产品 PRD](prd-2026-09-02-brainx-workflow.md)为准。
> 本文所有"现状"结论均来自 2026-09-02 晚对仓库代码的逐项核实（非文档复述、非汇报转述），
> 并标注了核实方法与代码位置，便于复核。

## 1. 背景与范围

### 1.1 背景

BrainX 是猎头 AI 助手，Reloop 黑客松 2026-09-14 截止，2026-09-03 有 all-hands 演示。
后端在 2026-08 至 09-02 期间完成了 Step 0（事件账本）与 Step 1（飞书网关）两大块建设，
并在 09-02 完成了 MCP 安全加固与群消息提炼层（E1 规则层 + E3 确认闭环）。

截至本轮复核，这批成果由 PR #45 的
`docs/backend-architecture-prd-20260902` 分支承载，尚未合入 `main`。其中 `src/hub/`（事件账本）、
`src/gateway/`（飞书网关）、`src/job-extract/`（提炼层）均应以该 PR 的代码和 CI 结果复核，
不得继续引用早期分支名或旧 diff 数量作为当前状态。

### 1.2 职责边界（用户 9/2 明确裁定）

> "openclaw 的接口这一块我不负责，我就负责后端的其他点"

| 段 | 内容 | 归属 |
|---|---|---|
| 飞书后台配置（建应用、勾 scope、发布版本） | 手动，谁都替不了 | 用户手动 |
| 通道层（WS 长连接、解密、归一） | `src/gateway/` | **后端（本 PR 范围）** |
| OpenClaw 飞书插件（前台 @机器人 对话） | 另一条独立 WS | OpenClaw 侧 |
| Skill 素材编写与托管 | `skills/*.md` | OpenClaw 侧（后端只供素材） |

**红线**：后端不实现任何飞书 `open_id` 相关业务逻辑，身份映射归 OpenClaw 侧，后端只见 `consultant_id`。

## 2. 架构总览（六层）

```text
┌─ L0 飞书网关 · src/gateway/ ────────────────────────────────┐
│  WS 长连接收消息 · 信封映射 · chat_id 登记 · 正文落库        │
└────────────────────────┬─────────────────────────────────────┘
                         ▼
┌─ L1 事件账本 · src/hub/ ────────────────────────────────────┐
│  event-log · consumeOnce(幂等) · upcaster · entity-links     │
│  case-machine · event_dlq                                   │
└────────────────────────┬─────────────────────────────────────┘
                         ▼
┌─ L2 领域数据 · src/db.js + migrations/(33) ─────────────────┐
│  job_facts · commitments · job_outcomes · lark_messages      │
│  job_facts_drafts · processed_events · entity_links          │
└────────────────────────┬─────────────────────────────────────┘
                         ▼
┌─ L3 业务领域 · src/*.js(28 个根模块) ───────────────────────┐
│  commitment · engagement · replay · recommend · radar        │
│  openmai-task · talent-supply · scorer · sync · guard        │
└────────────────────────┬─────────────────────────────────────┘
                         ▼
┌─ L4 调度推送 · scheduler / push / autopush ─────────────────┐
│  早 7 晚 7 定时推卡 · 只推私聊，绝不推群                     │
└────────────────────────┬─────────────────────────────────────┘
                         ▼
┌─ L5 MCP 交付 · mcp/server.mjs ──────────────────────────────┐
│  16 个定义 / 14 个可见工具 · JSON-RPC 2.0 · stdio            │
└──────────────────────────────────────────────────────────────┘
```

| 层 | 位置 | 状态 | 说明 |
|---|---|---|---|
| L0 飞书网关 | `src/gateway/`（5 文件） | ✅ 建成，**等凭证** | `ws-client.js` 是完整实现，非骨架；不依赖 OpenClaw |
| L1 事件账本 | `src/hub/`（6 文件） | ⚠️ **只写不读** | 幂等、升档、实体对齐、Case 状态机齐备；**但无消费者调度器（见 §4.1 N1）** |
| L2 领域数据 | `src/db.js` + 33 个迁移文件 | ✅ 建成 | 决策库 SQLite，业务真值唯一权威 |
| L3 业务领域 | `src/*.js`（28 个根模块） | ✅ 建成 | 接单/承诺/进展/回放/推荐/找人/人才供给/雷达/评分 |
| L4 调度推送 | `scheduler.js` 等 | ⚠️ 建成，粒度粗 | 只有 `SLOTS=[7,19]`，无到期/逾期触发（见 §4.2 C3） |
| L5 MCP 交付 | `mcp/server.mjs` | ⚠️ 建成，缺读工具 | 安全守门已补齐；**无 pending drafts 读工具（见 §4.1 N2）** |

## 3. 本 PR 已交付的成果

| 成果 | 位置 | 核实方式 |
|---|---|---|
| Step 0 事件账本 | `src/hub/` | 6 文件 + 5 个测试文件全绿 |
| Step 1 飞书网关 | `src/gateway/` | 4 文件 + 消息正文落库（`0030_lark_messages.sql`） |
| E1 群消息提炼规则层 | `src/job-extract/` | 保守正则 + 原文锚定 evidence，26 测试全绿 |
| E3 确认闭环（confirm 侧） | `src/job-extract/confirm.js` | 7 测试全绿；含 `sync_runs` 血缘 + membership 即时可见 |
| MCP 安全硬前置三件 | `mcp/server.mjs` | `BLOCKED_TOOLS` 黑名单 + `jobVisibleTo` 守门 + 静态扫描测试 |
| `brainx_recommend_run` 限流 | `mcp/server.mjs` | 60s 进程内限流，B6 测试覆盖 |
| 后端文档体系 | `docs/2026-09-02-*` | 模块结构 / 缺口总表 / 提炼层路径 / 接口包 / 白名单 |

**提炼层的关键架构裁决：job-extract 不是新服务，而是 L1 事件账本的一个消费者。**
复用 `consumeOnce(db, eventId, 'job-extract', fn)` 幂等模板——同事件重放不重复抽取（LLM 调用也是钱），
失败走既有 `event_dlq`，实体对齐复用 `entity_links`。这是"零新增运行时依赖"的实现路径：
依赖仍只有 mysql2 / zod / @larksuiteoapi/node-sdk 三个。

## 4. 差距盘点

### 4.1 清单外新发现（本轮核实新增，原待补清单未覆盖）

| # | 缺口 | 代码证据 | 后果 | 工期 |
|---|---|---|---|---|
| **N1** | **L1 事件账本没有消费者调度器** | `src/hub/consumer.js` 仅导出 `consumeOnce` 幂等原语，无注册表、无调度；`src/worker.js:25` `startWorkerTasks` 只跑 bridge + scheduler；`src/gateway/lark-gateway.js` grep 消费/派发关键词零命中 | **账本进去的事件没有任何消费者被驱动**。`consumeJobExtract` 全仓库只有测试在调用——**即使配好凭证，群消息进来也不会自动提炼，E1 在生产上不会触发** | 1 天 |
| **N2** | **E3 缺「草稿送达顾问」这一环** | `mcp/server.mjs` grep `drafts` 零命中：只有 `brainx_confirm_facts` **写**工具，无 pending drafts **读**工具 | 顾问看不到有哪些草稿、拿不到 `draft_id`，confirm 无处下手。**E3 目前是半成品**：确认动作有了，草稿的读取与投递没有 | 0.3 天 |
| **N3** | **event_dlq 无运维闭环** | 全仓库仅 `src/hub/upcaster.js:20` 写入，**无消费 / 告警 / 重放入口** | 失败事件进去即黑洞；E2 上 LLM 后失败率上升，届时无观测手段 | 0.5 天 |

### 4.2 清单内剩余（逐项代码核实）

| # | 缺口 | 核实结论（代码位置） | 工期 |
|---|---|---|---|
| **A1** | 飞书 4 个凭证 | `.env` 存在但 `LARK_APP_ID`/`APP_SECRET`/`ENCRYPT_KEY`/`VERIFICATION_TOKEN` 零命中。**卡住全局** | 0 天（手动） |
| **C1** | 待办提醒卡 | `src/push.js:33` 仍推「今天建议先看 3 个职位」——推新不催旧，方向反了 | 1 天 |
| **C2** | `next_action` 改 `suggestedAction` | `src/engagement.js:120` 仍硬编码 `'推进交付或记录结果'` | 0.5 天 |
| **C3** | 到期弹窗 + 逾期加急 | `src/scheduler.js:17` 仍只有 `SLOTS = [7, 19]` | 0.5 天 |
| **D1** | E2 LLM 层 | `AI_JOB_EXTRACT_ENABLED` 开关位已留，实现未做；等 gold set（依赖 A1） | 1 天 |
| **E1** | OpenMai 工具暴露到 MCP | `mcp/server.mjs` grep `openmai` 零命中 | 0.5 天 |
| **E2** | `brainx_talent` cid 隔离改造 | 目前靠 `BLOCKED_TOOLS` 拦着，未改造 | 1.5 天 |
| **E3** | 演示机 IP 加 RDS 白名单 | 运维动作，`npm run talent:health` 留证 | 0.5 天 |
| **E4** | 人才供给 / 找人结果脱敏 | 外露前必做 | 1 天 |
| **E5** | 约面 / 一面建模 | **待拍板是否进范围** | 1.5 天 |

### 4.3 门禁状态

`.quality-gate/reports/latest.md` 当前**红灯 2 项**：

| 检查项 | 失败内容 | 归因 |
|---|---|---|
| 超长行与压缩规避 | `docs/design/week-plan-brainx-reloop.html` 最长 529 字符 | 他人未跟踪文件 |
| 换行与行尾空白 | `docs/health-brief-2026-09-01.md` 第 3/4/98/99 行行尾空格 | 他人未跟踪文件 |

**两者均非本 PR 引入**，但会持续卡住 `verify:quick`，需由对应文件作者处理。

## 5. 工期与关键路径

### 5.1 总账

| 项 | 工期 |
|---|---|
| A1 配 4 个凭证 | 0 天（手动） |
| N1 消费者调度器 | 1 天 |
| N2 drafts 读工具 | 0.3 天 |
| N3 DLQ 运维闭环 | 0.5 天 |
| C 档日历助手三件套 | 2 天 |
| D1 E2 LLM 层 | 1 天 |
| E 档收尾（E1+E2+E3+E4） | 3.5 天 |
| **合计** | **≈ 8.3 天**（不含待拍板的 E5 约面建模 1.5 天） |

今天 9/2，距 9/14 有 12 天——**时间够，但全部卡在 A1 凭证**。

### 5.2 关键路径

```text
① A1 配 4 个凭证                  ← 0 天，今晚就能做，不解锁则后面全空转
   ↓
② N1 消费者调度器                  ← 1 天。不修它，配了凭证消息进来也不会提炼
   ↓
③ N2 drafts 读工具                ← 0.3 天，让 E3 闭环真正可用
   ↓
④ C 档日历助手三件套               ← 2 天，唯一不依赖外部条件、能立刻见效的
   ↓
⑤ N3 DLQ 运维闭环                 ← 0.5 天
   ↓
⑥ D1 E2 LLM 层                    ← 1 天，等 9/3 demo 攒到 gold set
   ↓
⑦ E 档收尾                        ← 3.5 天
```

> **② 的优先级高于所有"提精度"的工作**：现在账本事件无人消费，E1 提炼层等于一段
> "写得对但跑不起来"的代码。先让它能被驱动，谈 LLM 提精度才有意义。

## 6. 验收标准（什么算"后端全部完成"）

| # | 验收项 | 判定方式 |
|---|---|---|
| 1 | 群消息端到端跑通 | 机器人入群 → 收到消息 → 落 `lark_messages` + `workflow_event_log` → 消费者自动提炼出草稿 |
| 2 | 提炼结果可转正 | 草稿经 `brainx_confirm_facts` 确认后写入 `job_facts`，带 `sync_runs` 血缘 |
| 3 | 顾问能看到草稿 | MCP 提供 pending drafts 读工具，或经推送卡片触达 |
| 4 | 失败可观测可重放 | `event_dlq` 有告警/重放入口，失败事件不静默丢失 |
| 5 | 写工具守门无遗漏 | 静态扫描断言所有跨职位写工具 run 块含 `jobVisibleTo`（已有测试） |
| 6 | 日历助手见效 | 顾问早上能收到「你有 N 项待办逾期」，而非「建议看 3 个职位」 |
| 7 | 门禁全绿 | `npm run verify:quick` 通过 |

## 7. 红线（不可违反）

1. **`brainx_sync_now` 补完守门前必须留在黑名单**——默认参数会把决策库刷成 fixture 测试数据，数据破坏比隐私泄漏更致命。
2. **推送只走私聊，绝不推群**——群推送需显式确认，永不进自动化路径。
3. **新增写工具必须带 `jobVisibleTo` 或等效守门**。
4. **后端不碰飞书 `open_id`**——身份映射归 OpenClaw 侧。
5. **敏感字段不进卡片**——候选人只显示占位标识，不显示姓名/联系方式。

## 8. 相关文档

| 文档 | 用途 |
|---|---|
| [缺口与下一步总表](2026-09-02-gap-and-next-actions.md) | 优先级与卡点，回答"现在该做什么" |
| [后端模块结构](2026-09-02-backend-module-structure.md) | 六层职责边界与待补 10 项 |
| [job_facts 提炼层研发路径](2026-09-02-job-facts-extraction-roadmap.md) | 开源调研综合 + E0-E4 排期 |
| [OpenClaw 接口包](2026-09-02-openclaw-interface-pack.md) | 三接缝与接口接入说明；工具清单须以 `tools/list` 实测为准 |
| [工具外露白名单](2026-09-02-tool-exposure-whitelist.md) | 哪些工具能外露、补守门的判定依据 |
| [飞书权限清单](2026-09-02-feishu-permission-scopes.md) | A1 配凭证时勾哪些 scope |
| `specs/002-step1-lark-gateway/quickstart.md` | 飞书后台 8 步配置清单 |

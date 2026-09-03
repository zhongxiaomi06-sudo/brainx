# 复用与自建边界及权限需求 PRD

> 上级入口：[文档书总目录](README.md) · [多 Agent 协作准则](../AGENTS.md)

本文回答四个问题：每一步哪些开源代码**直接可用**、哪些只**借鉴设计**、哪些**必须自建**、每步**需要什么权限**以及**哪些权限可以避开**。结论基于 2026-09-01 全网搜索 + 30 个仓库 GitHub API 逐仓核实（存在性/star/最后推送/归档/许可证），核实过程与勘误记录在[全景蓝图 §9.2](architecture-2026-09-01-full-blueprint.md)。施工顺序与代码逻辑以[全景蓝图](architecture-2026-09-01-full-blueprint.md)为准；交互与安全以[群聊工作流 PRD](prd-2026-09-01-braintex-group-workflow.md)为准。

## 1. 三色总判断

| 等级 | 含义 | 清单 |
|---|---|---|
| 🟢 直接可用 | npm 装/内建模块，直接进运行时代码 | `@larksuiteoapi/node-sdk`（Step 1/2 的事件订阅、卡片回调、验签解密、长连接）、`zod`（信封与工具 schema）、`pino`（审计日志）、`mysql2`（既有）、node 内建（`node:sqlite`/`node:crypto`/`node:test`/`node:http`） |
| 🟡 借鉴设计 | 读源码抄设计，不抄依赖 | sledge（账本幂等/DLQ/lease）、Cedar（deny-by-default 权限模型）、open_recruiter（审批 checkpoint、简历去重、IM 集成形态）、TalentWizard（sourcing→outreach 链路）、durabletasks（at-least-once 工程说明）、Codex 职责规范（工具注册 JSON 契约） |
| 🔴 必须自建 | 无人可抄、是裁决权威或核心竞争力 | 七件，见 §3 |

**条件直装**（仅当触发条件成立）：`reflow-ts`——唯一零原生依赖的 TS 持久执行引擎；若 9/8 前 Saga 补偿自建吃力再评估。**平台兜底**（仅当 9/3 前自建网关赶不上）：`LangBot`（17,628 星，Apache-2.0）——接受它意味着让渡权限边界，需 York 拍板。

## 2. 每一步架构安排：可用代码 + 借鉴 + 自建 + 权限

### Step 0 不可逆边界（账本/状态机/幂等）

- 🟢 直接可用：`node:sqlite`（WAL 多进程安全）、`node:test`（fixtures 回放门禁）、`zod`（信封 schema）。
- 🟡 借鉴：sledge 的 dedupeKey 生产者幂等与 DLQ 形态；reflow-ts 的 stale-run 回收思路。
- 🔴 自建：`workflow_event_log`、`entity_links`、`consumeOnce()` 幂等事务、`advanceCase()` 乐观锁、upcaster。
- 权限：无外部权限（本地 SQLite）。**可避开**：无需任何消息队列/中间件账号。

### Step 1 事件网关（lark-gateway + chat_contexts）

- 🟢 直接可用：`@larksuiteoapi/node-sdk` 的 `EventDispatcher` + `WSClient`（长连接免公网回调，自带 challenge/验签/解密）；`larksuite/lark-samples` 最小样例；`lark-cli`（本机 v1.0.92，仅开发/运营调试）。
- 🟡 借鉴：open_recruiter 的 Slack 收简历入口形态（登记→解析→去重）。
- 🔴 自建：网关薄层（路由→标准信封→inbox）、`chat_contexts` 注册表、未登记群默认 DENY。
- 权限（BrainTex 机器人，最小集）：`im.message.receive_v1`（收群消息）、`im:message:send_as_bot`（发消息）、`im:chat:readonly`（读群信息登记 chat_contexts）。
- **可避开**：云文档/日历/多维表格/审批/考勤全部 scope；通讯录全量读取；MCP 通道（`lark-openapi-mcp` 停更一年、`cso1z/Feishu-MCP` 仅运营期手动用，均不进运行时）。

### Step 2 能力令牌（卡片回调）

- 🟢 直接可用：`node:crypto`（HMAC-SHA256 + `timingSafeEqual`）；SDK `CardActionHandler`。
- 🟡 借鉴：无（这是本仓库安全差异化）。
- 🔴 自建：token seal/verify、单次 nonce 表、卡片→动作→令牌绑定。
- 权限：开发者后台开启 `card.action.trigger` 回调 + encrypt key（无需新增 scope）。
- **可避开**：JWT/OAuth 库；不需要让卡片回调直连任何业务写接口。

### Step 3 权限引擎（decide()）

- 🟢 直接可用：`zod`。
- 🟡 借鉴：Cedar 的 principal/action/resource 三元组与 deny-by-default、序列级约束思想（Dogwood）；casbin/casl 的决策表组织方式。
- 🔴 自建：`decide()` 决策表（P0-P3 ∩ 五态输出）、Policy & Approval Service、审批流转。
- 权限：只读内部 DB（identity、chat_contexts、engagement 状态）。
- **可避开**：管理员级飞书 scope；LLM 侧不做任何权限判断（引擎输出五态，LLM 只消费）。

### Step 4 外部投影（disclosure_bundles）

- 🟢 直接可用：`zod`（投影 schema 白名单）。
- 🔴 自建：`disclosure_bundles`、`case_context_external`、`projectExternal()` 白名单投影。
- 权限：内部 DB 读（候选人同意状态 × 顾问审批状态）。
- **可避开**：外部群/客户直连 BrainX 数据库的任何路径——外部只见投影，不见表。

### Step 5 Agent 写工具注册

- 🟢 直接可用：`zod`（input/output 严格 schema）、`pino`（run_id/trace_id 审计）。
- 🟡 借鉴：Codex 规范 §12 工具注册 JSON 契约；open_recruiter 审批 checkpoint。
- 🔴 自建：工具注册表、写前审批→执行→写后复读（reread）闭环、幂等键。
- 权限：每个工具按 P0-P3 单独申请；写操作一律卡片确认后执行。
- **可避开**：`execute_shell`、任意 http 出口等通用接口（Codex 规范禁止项）；框架级工具生态（LangChain/LangBot 工具市场）。

### Step 6 桥 1 推人（BrainX→reloop）

- 🟢 直接可用：`mysql2`（裸查询）。
- 🟡 借鉴：TalentWizard 的"找人→排序→outreach"三段式。
- 🔴 自建：`entity_links` 跨库 ID 映射（SQLite↔MySQL）、sourcing_run 结构化落库。
- 权限：MySQL 人才库**只读账号**（新建最小权限账号，禁止写人才库）；reloop 侧 API token（窄 scope、短 TTL）。
- **可避开**：人才库写权限；直连 reloop 数据库。

### Step 7 结果回流（Saga）

- 🟢 直接可用：`node:sqlite` + 事件账本。
- 🔴 自建：Saga 三态（succeeded/failed/timed_out）、补偿逻辑、`job_outcomes` 回写链。
- 权限：`im:message:send_as_bot`（结果通知卡片，Step 1 已覆盖）。
- **可避开**：无新增。

## 3. 必须自建的七件事（一定需要自己完成）

以下每件都是裁决权威、数据边界或核心竞争力，**不允许外包给通用库或框架**：

1. **`workflow_event_log` 持久账本 + `processed_events` 消费者幂等**——信任的最底层，出错即审计失真。
2. **Case 双轴状态机**（milestone × outreach，乐观锁推进）——业务事实的唯一权威。
3. **五信任域 + `chat_contexts` 裁决**——未登记群默认 DENY，口子一开全盘失效。
4. **capability_token seal/verify + 单次 nonce**——外部卡片动作的唯一凭证。
5. **`decide()` 权限引擎**——P0-P3 ∩ 五态输出，LLM 永不参与判断。
6. **`disclosure_bundles`/`case_context_external` 白名单投影**——候选人隐私的最后闸门。
7. **Saga 三态与补偿**——推人失败的回滚权威，写对了就是演示日前的护城河。

这七件的分步代码逻辑已在[全景蓝图 §5](architecture-2026-09-01-full-blueprint.md)给出，验收以 fixtures 回放全绿为门禁。

## 4. 权限最小集汇总

**运行时（BrainTex 机器人）只申请 4 项**：

| Scope/能力 | 用途 | 步 |
|---|---|---|
| `im.message.receive_v1` | 群消息进入事件网关 | 1 |
| `im:message:send_as_bot` | 回复、卡片、结果通知 | 1/7 |
| `im:chat:readonly` | 群信息登记 chat_contexts | 1 |
| `card.action.trigger` 回调 + encrypt key | 卡片动作 + 能力令牌校验 | 2 |

**数据侧 2 项**：MySQL 人才库只读账号（桥 1）；reloop API token（窄 scope 短 TTL）。

**明确不申请**：通讯录全量、云文档读写、日历、多维表格、审批/考勤、管理员级任何 scope、公网 webhook（用 WS 长连接替代）。

## 5. 明确不采用清单（含理由）

| 项目 | 理由 |
|---|---|
| LangBot / koishi | 主链路不采用——框架接管事件流模糊权限边界、需更宽 scope；仅 9/3 兜底备选 |
| lark-openapi-mcp（官方） | 2025-08-14 后停更一年；运行时不需要 MCP |
| cso1z/Feishu-MCP | 活跃但定位运营期手动操作；运行时不需要 |
| feishu2md / feishu-pages / larksnap / wandao | 文档导出/Wiki 场景，本工作流不需要；wandao 另有 AGPL-3.0 商用传染风险 |
| BlueSkyXN/Feishu-Bitable-Python-API | 停维护 + GPL-3.0 |
| fastwego/feishu / go-lafi / feishu-dark-mode / lark-api-extensions / channel-sdk-go | 停更/无许可证/0 star，死链级别 |
| dbos-transact-ts / hatchet / pg-boss | 绑定 Postgres，与 SQLite/MySQL 分库冲突 |
| Kafka/Express/Prisma/LangChain/BullMQ | 维持[蓝图 §6.3](architecture-2026-09-01-full-blueprint.md) 拒绝结论 |

## 6. 研发流程规范（spec-kit）

已安装 [github/spec-kit](https://github.com/github/spec-kit)（`specify` CLI v1.0.4，经 `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git`），仓库内已初始化 `.specify/`。日常用法与既有协作准则的关系见[规范驱动研发流程](standards/SPEC_DRIVEN_WORKFLOW.md)。要点：

1. 新功能先 `specify` 建规格 → `/plan` 出技术方案 → `/tasks` 拆任务，规格先行于代码；
2. spec-kit 的 constitution 与本仓库 `AGENTS.md` 并行生效：AGENTS.md 管协作边界（锁、commit、push 门禁），constitution 管工程原则（零依赖、安全边界、验收标准）；
3. 本 PRD 的 §3 七件自建项应逐项转为 spec-kit 规格，作为 Codex 施工的输入。

## 7. 验收标准

1. 运行时依赖不超过 4 个 npm 包（现有 mysql2 + 新增三件套；reflow-ts 仅条件触发）；
2. 飞书机器人 scope 恰好为 §4 的 3+1 项，超出即退回重审；
3. §3 七件自建项在代码中可 grep 到实现与对应 node:test 回放用例；
4. §5 不采用清单中的项目不出现在 package.json 与任何运行时 import。

## 相关文档

- [全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md)（§5 代码逻辑 / §6 组件选型 / §9.2 核实修订）
- [BrainTex 群聊工作流技术 PRD](prd-2026-09-01-braintex-group-workflow.md) · [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md)
- [规范驱动研发流程](standards/SPEC_DRIVEN_WORKFLOW.md) · [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)

# BrainX 全景架构与技术施工蓝图（v1.0）

> 上级入口：[BrainX 文档书](README.md)
>
> 文档性质：**收拢层**——把本仓库全部规范收拢为一张完整架构图、一份技术施工安排、每一步的代码逻辑和开源组件选型。不取代任何权威规范；冲突时以各权威文档为准（关系见 §8）。
>
> 审计基线：2026-09-01 代码审计（零依赖后端：node:sqlite + node:http + mysql2）

## 1. 本机规范总览（本文的输入）

| 规范 | 权威范围 | 关键结论 |
|---|---|---|
| [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) | 身份、Case 状态机、事件账本、Saga | 双轴 Case；`case_id` 唯一连接单位；持久账本 vs 瞬态 relay；三座桥都是 Saga |
| [群聊工作流技术 PRD](prd-2026-09-01-braintex-group-workflow.md) | 群聊交互层 | 五信任域；事件入口/卡片回调；外部安全视图；P0-P3；未登记群默认 DENY |
| Codex Agent 职责与权限规范（微信稿，待入库） | Agent 工具与审批层 | P0-P5；工具注册契约；39 个窄工具；审批对象；Phase A-E |
| [最终交付蓝图](brainx-final-delivery-blueprint.md) | 产品形态与施工顺序 | 四入口导航；四个业务概念不可互冒；后端裁决 |
| [PRD v2.0](prd-2026-08-24-brainx-v2.md) | 产品边界 | 职位决策系统；评分确定性；TTC 是职位权威源 |
| [推荐队列产品架构](recommendation-queue-product-architecture.md) | 推荐闭环 | 冻结推荐、20 条分页、决策分层 |
| [安全操作手册](SECURITY.md) / [部署编排](DEPLOYMENT.md) | 密钥与运维 | 生产 systemd；数据隔离 |
| [14 天作战计划](design/week-plan-brainx-reloop.html) | 排期 | 9/14 决赛；9/3 全员使用；不做清单 |

## 2. 开发目标（从全部规范收拢）

**总目标：9/14 决赛前，把"AI Native 猎头工作流"核心循环在真实用户面前完整转一圈。**

```text
接单(BrainX) → 获取简历(OpenMai/reloop) → 对话推人(reloop TopN + 飞书)
→ 不成功 → 继续找人再推（结果回流）
```

分解为四个可验收的工程目标：

1. **职位主轴已上线**（完成度约 90%）：验真、接单、跟进、结果回写黄金路径可走。
2. **第 0 步不可逆边界**（当前 0%）：事件信封 + 持久账本 + entity_links + 消费者幂等 + fixtures 回放——这是桥 1 的硬门禁。
3. **群聊工作面**：一个 BrainTex 飞书机器人，五信任域，外部只看白名单投影。
4. **Agent 工具层**：P0-P5 分级 + 工具注册契约 + 审批对象，Persona 从"严格只读"演进到"受控写"。

**明确不做**：Kafka/RabbitMQ、候选人侧 ATS、LLM 自由生成推荐理由、R7 PDF 简历、R10/R13 撞库、批量自动外联、为赶时间绕过安全门禁。

## 3. 完整业务架构（一张图）

```text
┌────────────────────── 交互层（群是工作台，不是数据库）──────────────────────┐
│ 职位市场群 · 内部项目群 · 客户项目群 · 候选人私聊 · 管理群 · B-tex Web(后台) │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   ▼
┌────────────────── 渠道安全层（只做渠道，不做业务）─────────────────────────┐
│ POST /api/v1/lark/events        POST /api/v1/lark/card-actions            │
│ 验签·解密·challenge·去重·身份解析·chat_contexts·3s ACK·能力令牌校验      │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   ▼
┌────────────────── 权限与编排层 ────────────────────────────────────────────┐
│ Policy & Approval Service          BrainTex Agent Orchestrator            │
│ 权限=P0-P5 ∩ 资源关系 ∩ 信任域      意图识别·上下文组装·草稿·编排          │
│ ∩ Case守卫 ∩ 披露策略 ∩ 候选人同意   （无裁决权，LLM 不参与权限判断）      │
│ 输出:ALLOW/DENY/REDACT/REQUIRE_CONFIRM/REQUIRE_APPROVAL                   │
└───────────────┬──────────────────────────────────┬───────────────────────┘
                ▼                                  ▼
┌────────── Workflow Hub（契约与账本）──┐  ┌──── 受限执行器 ────┐
│ Identity Resolver(entity_links)       │  │ OpenMai / LLM      │
│ Case State Machine(双轴+守卫)         │  │ Codex 受限任务信封  │
│ Durable Ledger(workflow_event_log)    │  │ 工具注册表 39 窄工具│
│ Saga/幂等/DLQ/upcasting               │  └─────────┬──────────┘
│ 外部安全视图(disclosure_bundles 投影) │            │
└───────────────┬───────────────────────┘            │
                ▼                                    ▼
┌────────── 领域层（一个事实一个 owner）─────────────────────────────────────┐
│ BrainX 职位域(SQLite)      reloop 候选人域(MySQL)   TTC 职位权威(API)     │
│ engagement/commitment/     candidate/resume/        飞书群与消息(证据)    │
│ decision/job_outcomes      position/match/submission  OpenMai 找人        │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   ▼
┌────────── Evidence Store（消息/简历/附件只存 evidence_ref）────────────────┘
```

**一条主循环**：群里出现职位/反馈 → 识别 Case → 判断合法动作 → 生成草稿 → 卡片确认 → 领域执行写事件 → 复读权威状态 → 结果回到原群原卡片。

## 4. 技术架构安排（进程、模块、数据）

### 4.1 进程拓扑（沿用现有拆分，新增 1 个）

| 进程 | 入口 | 职责 | 状态 |
|---|---|---|---|
| API 进程 | `src/server.js`（node:http） | HTTP/SSE、领域路由、卡片回调 | 已有 |
| Worker 进程 | `src/worker.js` | bridge 同步、推荐批处理、定时推卡 | 已有 |
| **Lark Gateway** | `src/gateway/lark-gateway.js`（新） | 飞书事件/卡片回调接收、验签去重、写事件信封 | 新建；可先寄生 API 进程同端口路由，量起来再拆 |
| Codex Runtime | Codex App Server（受控子进程/内部服务） | 只在 Agent Gateway 内以受限任务信封调用 | Phase C+ |

### 4.2 模块映射（新代码放哪）

| 新能力 | 新模块 | 复用的现有模块 |
|---|---|---|
| 事件信封+账本 | `src/hub/event-log.js` + `migrations/0023+` | `db.js`（node:sqlite 迁移记账已就绪） |
| entity_links | `src/hub/identity.js` | `relations.js`（匹配启发式可参考） |
| Case 状态机 | `src/hub/case-machine.js` | `engagement.js`（守卫+409 模式照抄） |
| 消费者幂等 | `src/hub/inbox.js` | `worker-relay.js`（泵+GC 模式参考） |
| 飞书网关 | `src/gateway/lark-gateway.js`、`src/gateway/card-actions.js` | `feishu.js`（令牌管理）、`oauth.js`（最小权限） |
| 群上下文 | `src/hub/chat-contexts.js` | `job_message_visibility.js`（个人边界沿用） |
| 权限引擎 | `src/hub/policy.js` | `data-isolation.js`、`membership.js` |
| 外部投影 | `src/hub/external-view.js` | `snapshot.js`（快照模式） |
| Agent 写工具 | `src/agent/tools/*.js` + `registry.js` 扩展 | 现有 15 只读工具 + `loop.js`（function-calling 已跑通） |
| Persona 受控写 | `persona.js` 改造 | 领域守卫全部走 `engagement.js`/`commitment.js` 原函数，不另开直写通道 |

### 4.3 数据表规划

**复用（种子）**：`decision_runs`、`decision_events`、`sync_runs`、`bridge_cursor`、`commitment_actions`、`job_outcomes`、`worker_events`（仅瞬态）。
**新增（9 张）**：`workflow_event_log`、`entity_links`、`workflow_cases`（双轴投影）、`processed_events`、`chat_contexts`、`actor_links`、`action_policies`、`approval_requests`、`disclosure_bundles`。Evidence Store 首版用 `evidence_objects` 表 + 磁盘目录 + envelope 加密（node:crypto AES-256-GCM）。

## 5. 分步施工与每步代码逻辑

> 每步给：目标 → 核心代码逻辑（函数签名/SQL/伪代码）→ 验收。步骤顺序即依赖顺序；第 0 步未过回放门禁，不得开工桥 1。

### 第 0 步：不可逆边界（对应 Workflow Hub §12）

**0.1 事件信封与持久账本**（`src/hub/event-log.js`）

```js
// migrations/0023_workflow_event_log.sql
CREATE TABLE IF NOT EXISTS workflow_event_log (
  event_id TEXT PRIMARY KEY,          -- UUID
  event_type TEXT NOT NULL,           -- 'job.accepted' 等
  schema_version INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT, received_at TEXT NOT NULL,
  time_quality TEXT NOT NULL DEFAULT 'RECEIVED_FALLBACK',
  tenant_id TEXT NOT NULL, consultant_id TEXT,
  project_id TEXT, position_id TEXT, candidate_ref TEXT,
  case_id TEXT, correlation_id TEXT, causation_id TEXT,
  idempotency_key TEXT, source TEXT NOT NULL,
  payload_json TEXT NOT NULL,         -- 脱敏 payload；正文进 evidence_objects
  evidence_refs TEXT                  -- JSON array
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wel_idem
  ON workflow_event_log(source, idempotency_key) WHERE idempotency_key IS NOT NULL;

// appendEvent(db, envelope) —— 唯一写入口；旧事件永不 UPDATE（upcast 只在读取时）
export function appendEvent(db, env) {
  // 1) INSERT OR IGNORE(靠 idx_wel_idem 幂等)  2) 返回 {inserted, event_id}
}
export function loadEvents(db, { caseId, afterId, limit }) { /* 归约/回放读取 */ }
```

**0.2 entity_links 可拆分身份**（`src/hub/identity.js`）

```sql
CREATE TABLE IF NOT EXISTS entity_links (
  link_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,          -- 'position'|'candidate'
  canonical_id TEXT NOT NULL,
  source_system TEXT NOT NULL, external_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|VERIFIED|SPLIT|INVALID
  confidence REAL, match_method TEXT, evidence_ref TEXT,
  created_by TEXT, verified_by TEXT, verified_at TEXT,
  split_from TEXT, superseded_by TEXT, invalidated_at TEXT,
  invalidation_reason TEXT, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_system, external_id, entity_type)
);
```

逻辑：显式外部 ID → 直接 `VERIFIED`；模糊匹配（公司名+职位名相似度）→ 只产 `PENDING` 进人工队列；错合并走 `splitLink()` 生成新 canonical + `link.split_completed` 事件，不 UPDATE 历史。

**0.3 Case 双轴状态机**（`src/hub/case-machine.js`）

```js
const MILESTONE_RANK = { DISCOVERED:1, QUALIFIED:2, CONSENTED:3, SUBMITTED:4,
  INTERVIEW:5, OFFER:6, PLACED:7 };
export function advanceCase(db, { caseId, axis, to, actorId, evidence }) {
  // axis='milestone'|'outreach'
  // 1) 读当前投影(version 乐观锁)
  // 2) milestone: to.rank > cur.rank 才前进；迟到低 rank → 只补证据不后退
  // 3) SUBMITTED 前置校验: 存在 candidate.consent_confirmed 事件，否则 409
  // 4) 回退只允许 emit('case.stage_corrected', {from,to,reason,actor})
  // 5) CASE UPDATE ... WHERE version=? —— 影响 0 行则重读事件归约后重试
}
```

**0.4 消费者幂等 + outbox**（`src/hub/inbox.js`）

```sql
CREATE TABLE IF NOT EXISTS processed_events (
  consumer_name TEXT, event_id TEXT, processed_at TEXT,
  result_hash TEXT, status TEXT, PRIMARY KEY(consumer_name, event_id)
);
```

```js
// 消费事务模板：投影与 processed_events 同一事务
export function consumeOnce(db, consumerName, eventId, fn) {
  const run = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM processed_events WHERE consumer_name=? AND event_id=?')
          .get(consumerName, eventId)) return { skipped: true };
    const result = fn(db);                       // 业务投影
    db.prepare('INSERT INTO processed_events VALUES (?,?,?,?,?)')
      .run(consumerName, eventId, now(), hash(result), 'OK');
    return result;
  });
  return run();                                  // at-least-once + 幂等
}
```

**0.5 fixtures 回放门禁**（`tests/hub-bridge1-replay.test.mjs`，node:test）
用 `fixtures/` 造 6 个场景：成功 / 失败 / 超时 / 重复投递 / 乱序到达 / 需补偿。断言：重复只写一次；乱序不让阶段后退；超时发 `position.create_timed_out` 且状态可恢复；补偿（`job.released→position.close_requested`）幂等。**全绿前不得声称桥 1 打通。**

### 第 1 步：飞书事件网关（`src/gateway/lark-gateway.js`）

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export async function handleLarkEvent(req, res, db) {
  // 1) 验签: X-Lark-Signature = sha256(timestamp + nonce + encrypt_key + body)
  //    timingSafeEqual 比较；失败 403
  // 2) body.type==='url_verification' → 回写 challenge
  // 3) 解密 AES-256-CBC(encrypt_key) 取 header.event_id
  // 4) dedupe: INSERT INTO lark_event_dedupe(event_id) —— 主键冲突直接 200
  // 5) 解析 open_id/chat_id/root_id/message_id
  // 6) chat = chat_contexts WHERE chat_id=? —— 无记录或 enabled=false → 只记 evidence, 不响应
  // 7) envelope = {event_id, event_type, chat_scope, actor_open_id, occurred_at,
  //                received_at, idempotency_key: message_id, evidence_ref}
  // 8) appendEvent(db, envelope); 9) 队列交给 BrainTex; 10) res.end('{"code":0}') // ≤3s
}
```

外部群只响应 @机器人 / 回复机器人 / 卡片操作（`bot_mode=MENTION_ONLY`）。

### 第 2 步：卡片回调与能力令牌（`src/gateway/card-actions.js`）

```js
// 签发（发卡片时）：seal = HMAC-SHA256(secret, base64(payload) + '.' + exp + '.' + nonce)
// payload = {subject_open_id, action, resource_type, resource_id, chat_id, context_version}
export function verifyCapability(token) {
  // 1) 验签  2) exp 未过期  3) nonce 未消费(lark_card_nonce 表, 主键单次消费)
  // 4) context_version 与当前投影一致(对象被他人改过 → 409 要求新预览)
}

export async function handleCardAction(req, res, db) {
  const decision = policy.decide(db, { actor, action, resource, chatScope });
  // ALLOW → create approval/command request → 领域守卫 → 写事件 → 更新卡片
  // DENY/REQUIRE_* → 外部卡片只回「已记录，等待项目顾问确认」+ 内部群审批卡
  // 3 秒内必须先 ACK，重活异步
}
```

**卡片 value 禁放**：联系方式、简历地址、角色结论、可执行字段；只放 `capability_token`。

### 第 3 步：权限引擎（`src/hub/policy.js`）

```js
export function decide(db, { actorId, action, resourceType, resourceId, chatScope }) {
  // 最终权限 = 角色权限 ∩ 资源关系 ∩ 群信任域 ∩ Case守卫 ∩ 披露策略 ∩ 候选人同意
  // 查 action_policies(role, trust_zone, action) → 无行 = DENY(默认拒绝)
  // EXTERNAL_CLIENT × 内部动作 → DENY
  // 内部顾问 × 外部群 × 写动作 → REQUIRE_INTERNAL_APPROVAL(转内部群)
  // 客户查询命中外部问题 → ALLOW_WITH_REDACTION(走 external-view.js 投影)
}
```

数据最小化：日志只存 `actor 哈希` 与决策码，不存正文。

### 第 4 步：外部安全视图（`src/hub/external-view.js`）

```js
export function projectExternal(db, caseId) {
  const bundle = latestDisclosureBundle(db, caseId);   // 未过期且未撤销
  if (!bundle) return null;                            // 无披露清单 = 不可答
  return pickFields(internalCaseProjection(db, caseId), bundle.allowed_fields);
  // 候选人撤回同意 → bundle.revoked_at 填时间 → 投影立即为空，历史事件不改写
}
```

### 第 5 步：Agent 工具层受控写（Persona 从只读到受控写）

```js
// src/agent/registry.js 新增写工具示例（对齐 Codex 规范 §12 契约）
{
  name: 'brainx_record_project_progress', risk_level: 'P3',
  approval_policy: 'explicit_preview',
  identity_binding: 'server_injected',            // persona.js 不传 cid，服务端注入
  input_schema: zodRecordProgress,                // 建议引入 zod；或沿用手工校验
  async run(ctx, args) {
    const approval = requireApproval(db, ctx, args);        // 生成 approval_request + 卡片
    if (!approval.confirmed) return { status: 'WAITING_APPROVAL', approval_id };
    const r = recordProgress(db, ctx.consultant_id, args); // 复用 commitment.js 原函数
    const verify = rereadState(db, ctx.consultant_id, args.project_id); // 执行后复读
    return { status: verify.ok ? 'COMPLETED' : 'NEEDS_RECONCILIATION', ... };
  }
}
```

persona.js 改造：系统提示词从"严格只读"改为"可建议写动作，执行一律经 approval"；**权限不在提示词里**——工具注册表 + 服务端守卫是唯一控制面。

### 第 6 步：桥 1（接单 → 建岗）

```text
engagement ACCEPT(已有) → appendEvent('job.accepted')
→ consumeOnce('bridge1','position.create_requested') → 调 reloop POST /positions
→ 三结局各 appendEvent: created(写 entity_links VERIFIED) / create_failed / create_timed_out(watchdog)
→ 释放: job.released → position.close_requested → closed/failed/timed_out
```

### 第 7 步：桥 2/3 与推人闭环

OpenMai 结果从 `openmai_results`(覆盖式 Markdown) 迁移为 `sourcing_run` + `candidate_ref` + `match` + `case`（保留每次运行）；推人链 = 草稿 → 同意检查 → 内部终审 → `disclosure_bundle` 生成 → 外部投影 → 顾问点发送 → `submission.sent`；客户反馈落 `client.feedback_received`，人工确认才 `case.stage_advanced`。

## 6. 开源组件选型（尊重零依赖哲学）

**原则**：核心链路继续用 Node 内置模块（已在用且稳定）；只有当自研成本 > 引入成本时才引入依赖，且每个新依赖必须过质量门禁。

### 6.1 继续用 Node 内置（零新增依赖）

| 能力 | 模块 | 说明 |
|---|---|---|
| 事件账本/幂等/状态机 | `node:sqlite` (DatabaseSync) | 已在用，WAL 多进程安全 |
| capability_token / 飞书验签 / envelope 加密 | `node:crypto` (HMAC/AES-GCM/timingSafeEqual) | 不引入 JWT 库——令牌生命周期短且服务端自持 |
| 事件去重/审计哈希 | 同上（sha256） | |
| 测试/回放门禁 | `node:test` | 已在用 |
| agent loop | 自研 `loop.js` | 已跑通，8 轮+总超时，不换 |
| 队列/延迟任务 | SQLite 队列表 + `worker.js` 定时泵 | worker-relay 模式已验证；不引 Redis |

### 6.2 推荐引入（每个都值得一个依赖）

| 组件 | 用途 | 替代方案（若坚持零依赖） |
|---|---|---|
| **zod** | 工具 input/output schema 校验（对齐 Codex 规范 §12）、事件信封校验 | 手写校验函数（现有惯例） |
| **@larksuiteoapi/node-sdk** | 飞书事件订阅、卡片回调、卡片 JSON 构建（官方 SDK 自带验签/解密/challenge） | 手写（约 150 行，第 1 步逻辑已给出） |
| **pino** | 结构化审计日志（run_id/trace_id、脱敏、轮转） | JSON.stringify 到文件 |
| **nanoid** | 短 ID（run_id/approval_id） | `crypto.randomUUID()` 够用 |
| **@opentelemetry/api**（Phase C+） | trace_id 贯穿 Gateway→Policy→工具→复读 | 自定义 header 透传 |

判断：第 0-2 步**全部可用零依赖实现**（上面代码逻辑已自包含）；`@larksuiteoapi/node-sdk` 与 `zod` 是唯二建议在 9/4 前引入的（省下的验签/解密/卡片调试时间 > 依赖成本）。BullMQ/Redis 明确**不引入**——文档已拍板不用 Kafka 级中间件，SQLite 队列在当前量级（日均千级事件）足够。

### 6.3 明确不引入（及理由）

| 组件 | 理由 |
|---|---|
| Kafka/RabbitMQ/NATS | 架构拍板：workflow_event_log 持久账本 + SQLite 队列即够；运维成本不值 |
| Express/Fastify | server.js 原生 node:http 已承载全部路由，迁移是纯风险 |
| Prisma/TypeORM | 迁移记账（schema_migrations 按文件名）已自研且更可控 |
| LangChain/LlamaIndex | 自研 agent loop 已跑通；引入框架只会模糊权限边界 |
| 任意 ORM 的 MySQL 侧 | reloop 域不在本仓库；保持 mysql2 裸查询 |

## 7. 施工顺序总表（结合 14 天作战计划）

| 步 | 交付 | 依赖 | 对应排期 |
|---|---|---|---|
| 0 | 信封+账本+identity+inbox+fixtures 回放全绿 | 无 | 9/2-9/3 |
| 1 | lark/events 网关 + chat_contexts | 0.1 | 9/3 |
| 2 | card-actions + capability_token | 1 | 9/3-9/4 |
| 3 | policy.js 权限引擎 + 8 表 | 2 | 9/4 |
| 4 | external-view 投影 | 3 | 9/5 |
| 5 | Agent 写工具(审批流) | 3 | 9/5-9/8 |
| 6 | 桥 1 全链(过 0.5 门禁) | 0 全部 | 9/4 联调 |
| 7 | sourcing run 结构化 + 推人闭环 | 4,6 | 9/8 |
| 8 | 联排/冻结 | 全部 | 9/11-9/13 |

## 8. 与权威规范的关系

本文是**导航层**：施工细节以 [Workflow Hub 架构](workflow-hub-architecture.md)为契约权威；交互与安全以[群聊工作流 PRD](prd-2026-09-01-braintex-group-workflow.md)为准；工具授权以 Codex Agent 职责规范（入库后）为准；产品验收以[最终交付蓝图](brainx-final-delivery-blueprint.md)为准。Codex 规范的 P0-P5 与群聊 PRD 的 P0-P3 映射：PRD-P0(查询)≈规范-P1、PRD-P1(内部写)≈P3、PRD-P2(对外)≈P4、PRD-P3(高风险)≈P4+审批/P5 禁区——**合并评审时统一编号**。

## 9. 每一步现状不足与云端可获组件映射（2026-09-01 代码审计）

依据：同日 Workflow Hub 完整度审计（grep migrations/src/tests/scripts/bin 证据）与 package.json 依赖确认。"云端可获"指 npm 公网可安装组件；结论遵循 §6 选型原则——账本/状态机/权限/投影无可靠现成库，必须自建；云端只取 3 件（zod、官方飞书 SDK、pino）。

| 步 | 当前不足（代码证据） | 云端可获组件 | 自建 / 引入判断 |
|---|---|---|---|
| 0 不可逆边界 | `workflow_event_log`/`entity_links`/`case_id`/`processed_events`/upcaster **全部零命中**；30 张表无 Case 相关表；`openmai_results` 覆盖式 Markdown（0015）正命中账本禁令 | `node:sqlite`（内建已用）、`node:test`（fixtures 回放）、**zod**（信封 schema 校验） | 账本/状态机/幂等**自建**（§5 Step 0 逻辑，约百行级）；zod 引入校验信封 |
| 1 事件网关 | lark-gateway **不存在**；无 `chat_contexts` 注册表；未登记群默认 DENY 未实现；无 HMAC 验签 | **@larksuiteoapi/node-sdk**（官方，WebSocket 长连接免公网回调，自带验签/解密/challenge）、zod | SDK **引入**；网关薄层（路由→信封→inbox）自建 |
| 2 能力令牌 | 卡片回调无 capability_token；无单次使用 nonce，防重放缺失 | `node:crypto`（内建 HMAC-SHA256 + `timingSafeEqual`） | **纯内建自建**，§5 Step 2 逻辑已自包含，不引 JWT 库 |
| 3 权限引擎 | Policy & Approval Service **不存在**；P0-P3 ∩ 五态输出未实现；persona.js 只有系统提示词级"严格只读"，无引擎级裁决 | 可选 `casl`（轻量 JS 授权库）；zod | `decide()` 决策表**自建**（LLM 不参与权限判断）；casl 仅当需要对象级能力组合时引入，**默认不引** |
| 4 外部投影 | 无 `disclosure_bundles`/`case_context_external`；bridge.js 仅"非成员不可见"一条隐私边界 | zod（投影 schema 白名单定义） | **自建**——投影是裁决权威所在，不可外包给通用库 |
| 5 写工具注册 | agent loop 无工具注册表/审批/复读闭环；写动作无幂等键与重读验证 | zod（工具 input/output 严格 schema，对齐 Codex 规范 §12）、**pino**（审计日志 run_id/trace_id/脱敏） | registry JSON 契约**自建**；zod + pino 引入 |
| 6 桥 1 推人 | `reloop`/`position_id` 在 src/scripts/bin/tests **零命中**；SQLite(BrainX) 与 MySQL(人才库) 物理分库无 ID 映射 | `mysql2`（仓库唯一既有依赖） | 映射即 Step 0 的 `entity_links`（自建）；跨库查询用 mysql2 裸查询 |
| 7 结果回流 | `job_outcomes` 全表仅 2 行；Saga 三态（succeeded/failed/timed_out）与补偿**零实现** | 无现成组件；`node:sqlite` + 事件账本 | **自建**——Saga 补偿逻辑是本仓库核心竞争力，不外购 |

横切补充：结构化日志 pino（第 1/5 步受益）；短 ID 用内建 `crypto.randomUUID()`（nanoid 仅在长度敏感时引入）；`@opentelemetry/api` 推迟到 Phase C+。

### 9.1 GitHub 同类开源项目映射（2026-09-01 全网搜索）

搜索范围：AI 招聘 Agent、SQLite 持久执行引擎、飞书机器人框架、Agent 权限治理。结论先行：**没有与"群聊驱动猎头工作流（五信任域 + capability_token + disclosure_bundles）"直接对等的仓库——这一层无人可抄，必须自建**；但每一步都有可"抄设计"或"直接 npm 装"的仓库。

**A. 同类产品（抄业务与交互设计，代码栈不同不直接用）**

| 仓库 | 定位 | 对我们的参考价值 |
|---|---|---|
| [miao4ai/open_recruiter](https://github.com/miao4ai/open_recruiter) | 本地优先 AI 招聘助手：SQLite + ChromaDB、LangGraph 多 Agent 评分、human-in-the-loop 审批、Pipeline 看板、Slack 收简历 | **最像 BrainX 的开源实现**——本地 SQLite、审批队列、IM 集成、自动化任务（APScheduler 无 Redis）与我们的零依赖哲学同源；看它的审批 checkpoint 与 duplicate detection 设计 |
| [srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher)（约 2.7 万星） | 简历-JD 匹配量化打分（Next.js+FastAPI，兼容 Ollama/DeepSeek） | 简历评分维度与可视化口径参考（TTC 打分侧） |
| [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search)（约 1.9 万星） | Claude Code 驱动的求职全链路流水线 | Agent 流水线编排与投递追踪参考（求职者视角反向） |
| [austenknu/TalentWizard](https://github.com/austenknu/TalentWizard) | 多平台 sourcing（GitHub/StackOverflow/Kaggle）+ 个性化 outreach | 桥 1 推人的"找人→排序→outreach"链路参考 |

**B. 工作流引擎（Step 0 的"抄设计"或"直接装"候选）**

| 仓库 | 定位 | 对我们的判断 |
|---|---|---|
| [torkbot/sledge](https://github.com/torkbot/sledge) | **SQLite 持久事件账本引擎**：dedupeKey 生产者幂等、事务化物化、队列 lease/重试/DLQ、重启恢复 | 与我们 Step 0（workflow_event_log + processed_events + DLQ）**设计几乎一一对应**；MIT 但体量小（约 58 星），抄设计不引依赖 |
| [danfry1/reflow-ts](https://github.com/danfry1/reflow-ts) | TypeScript 持久执行引擎，**官方 node:sqlite 适配器、零原生依赖**，自动重试 + 崩溃恢复 | 唯一与零依赖哲学兼容、可直接 `npm i` 的候选；若 Saga 补偿自建吃力，9/8 推人循环前可评估引入 |
| [recipediary/durabletasks](https://github.com/recipediary/durabletasks) | 单节点 BYO-storage 持久执行（SQLite provider），Tangia 生产使用 | at-least-once + 任务幂等的工程说明值得读；不引入 |
| dbos-transact-ts / hatchet / pg-boss | Postgres 系持久执行/队列 | 拒绝——绑定 Postgres，与 SQLite/MySQL 分库现状冲突 |

**C. 飞书侧（Step 1/2 直接用）**

| 仓库 | 判断 |
|---|---|
| [larksuite/node-sdk](https://github.com/larksuite/node-sdk)（官方） | 已在 §6.2 采购清单；`EventDispatcher`/`CardActionHandler`/WSClient 长连接直接覆盖事件订阅 + 卡片回调 + 验签解密 |
| [larksuite/lark-samples](https://github.com/larksuite/lark-samples)（官方示例） | 卡片 JSON 与回调处理的最小可跑样例，9/3 联调前照抄即可 |

**D. Agent 权限治理（Step 3 的"抄模型"）**

| 仓库 | 定位 | 对我们的判断 |
|---|---|---|
| [cedar-policy/cedar](https://github.com/cedar-policy/cedar)（AWS） | 形式化验证的细粒度授权引擎；2025 Dogwood 扩展支持**工具调用序列级**约束，已成 Agent 授权事实参考架构 | **抄模型不引引擎**——deny-by-default、principal/action/resource 三元组与"LLM 提议、引擎裁决"的分离原则直接写进 decide() 的决策表；Rust/WASM 集成成本不值 |
| [awesome-ai-agent-governance](https://github.com/smq9sn5jck-coder/awesome-ai-agent-governance) | Agent 治理工具总目录（OPA/Casbin/Presidio/Guardrails 等） | 作为 Codex 规范入库评审时的工具选型索引 |
| casl（npm） | JS 同构授权库 | 维持 §9 判断：默认不引 |

**总判断**：直接可装 = `@larksuiteoapi/node-sdk` + `zod` + `pino`（+ 可选 reflow-ts）；抄设计 = sledge（账本幂等/DLQ）、Cedar（权限模型）、open_recruiter（审批流/IM 集成形态）；无人可抄 = 五信任域投影、disclosure_bundles、Case 双轴状态机——这三件是本仓库的差异化，自建。

## 相关文档

- [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) · [群聊工作流技术 PRD](prd-2026-09-01-braintex-group-workflow.md) · [最终交付蓝图](brainx-final-delivery-blueprint.md)
- [BrainX v2.0 PRD](prd-2026-08-24-brainx-v2.md) · [安全操作手册](SECURITY.md) · [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)
- [双项目 14 天作战计划](design/week-plan-brainx-reloop.html)

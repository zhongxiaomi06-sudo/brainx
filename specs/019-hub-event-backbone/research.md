# Phase 0 Research: Hub 事件骨干重整

> 规格：[spec.md](spec.md) · 计划：[plan.md](plan.md)
>
> 本文件解决技术方案的所有待定项；每条决策给结论、理由、被否方案。

## 决策 1：dispatcher 自建，不引入任务框架

- **Decision**: 在 `src/hub/dispatcher.js` 自建约 100-150 行的调度循环；宿主为新进程 `bin/brainx-dispatcher.mjs`（参照 `bin/brainx-integration-worker.mjs` 21 行模式）。
- **Rationale**: 宪法 I（零依赖优先，运行时依赖上限 4）；目标规模 1.7 条/秒均值， SQLite WAL 已验证承载；真正缺的不是框架能力而是「按消费者游标扫描未消费事件」这一个查询 + 一个循环。框架（BullMQ 需 Redis、Temporal 需服务端）引入的基础设施成本远超收益。
- **Alternatives considered**: BullMQ（需 Redis，违反 deps 上限，否）；Temporal（需独立服务端与 SDK，否）；复用 integration-jobs 的 worker 表驱动（它是「任务队列」语义，不是「事件 × 消费者」语义——同一事件要被 N 个消费者各消费一次，任务队列的 claim-complete 模型不匹配，否）。

## 决策 2：异步 LLM 的形状错配以「prepare/apply 两段式」解决

- **Decision**: 消费者接口定义为 `{ prepare(event, deps) → 异步预取（LLM/HTTP）; apply(db, event, prepared) → 同步事务内落库 }`；dispatcher 先 `await prepare`，再把 apply 包进既有 `consumeOnce`（同步事务模板不动）。
- **Rationale**: `consumeOnce` 的「业务写入 + processed_events 标记同事务」是恰好一次语义的根基，不能为异步破坏；两段式把不可重入的 IO 移出事务、把可重入的写库留在事务内。这同时是删除 `bridge-producer.js` 里 `presetFields` 注入 + 双份 try/catch 补偿的正确形态——LLM 预抽取从生产者挪回消费者内部。
- **Alternatives considered**: 把 consumeOnce 改成整体 async（事务横跨 await，SQLite 写锁被 LLM 延迟持有，峰值放大锁竞争，否）；保持 presetFields（hack 正是本次要消灭的耦合，否）。

## 决策 3：业务事件类型清单与命名

沿用账本既有命名风格（`lark.message_received`、`sourcing.run_finished`），本期新增五类：

| 事件类型 | 触发点（改造点） | 幂等键 | payload 要点 |
|---|---|---|---|
| `job.accepted` | `tools-actions.js` acceptJob 成功后 | `job.accepted:{project_id}:{consultant_id}` | project_id、consultant 锚点、来源（卡片/私聊/群） |
| `sourcing.search_started` | 找人启动（worker 任务登记处） | `sourcing.started:{project_id}:{run_key}` | channel（openmai/supermai/reloop）、轮次 |
| `sourcing.search_finished` | `openmai-delivery.js` 投递结果时 | `sourcing.finished:{project_id}:{run_key}` | channel、status（success/error）、结果计数（不含名单正文） |
| `job_fact.reviewed` | `job-extract/confirm.js` + `judgment-extract/confirm.js` | 复用 draft 确认幂等（`{domain}:{draft_id}`） | domain（job/judgment）、action（confirm/reject）、draft 引用 |
| `job.terminal_recorded` | `replay.js` recordOutcome 成功路径 | 复用 outcomes 既有 idempotency_key | project_id、stage、kind |

- **Rationale**: 全部复用各写入点已存在的幂等键，不发明第二套防重；payload 只放锚点与计数，正文一律 evidence_refs。
- **Alternatives considered**: 统一一个 `business.action` 大类型用 payload 区分（查询与消费者路由都要二次解析，违背事件类型即路由的账本惯例，否）。

## 决策 4：反馈环形态——消费者 + 快照表，不做实时仪表盘

- **Decision**: `feedback/rollup.js` 注册为普通消费者（消费五类业务事件，维护增量计数），另加周期汇总（worker 定时触发）把窗口指标快照写入新表 `feedback_metrics`（migrations/0052）；报告由既有报告技能/CLI 读快照生成。
- **Rationale**: 反馈环的第一价值是「口径固定、可重算」的指标，不是实时性；快照表 append-only，与账本同纪律。首日指标对齐蓝图 §13：推荐采纳率、抽取字段级确认率、找人渠道转化、终局周期。
- **Alternatives considered**: 实时物化视图（SQLite 无物化视图，触发器增加写路径复杂度，否）；直接每次现算（口径漂移，无法回溯，否）。

## 决策 5：session 隔离下沉与接口面收敛本期只落地基

- **Decision**: 本期只做两件不可逆的地基：①gateway 鉴权以 principal 为唯一边界的原则写入契约并补测试（300 顾问的承载形态另行子规格，依赖 dispatcher 稳定）；②接口漂移检测进门禁——新增测试强制 `tool-registry.js` 与插件清单/契约 fixture 三方一致（此前漂移靠人工发现）。
- **Rationale**: 两项完整形态都是大工程，塞进本期会淹没 P1 主线；但「不再漂移」和「边界原则」是必须立刻止血的部分。
- **Alternatives considered**: 本期直接重做隔离形态（风险高、无度量依据，否）；接口面物理合并成一个进程（OpenClaw 插件协议限制，只能逻辑收敛，否）。

## 决策 6：LLM 降级可见性

- **Decision**: LLM 类消费者失败按统一语义重试→DLQ；kill-switch 关闭时消费者以 `layer='rules'` 标记降级，降级本身作为事件属性可被反馈环统计——消灭 `catch { return null }` 静默降级。
- **Rationale**: 规格 FR-011「降级状态可见」；生产教训（模型漏参数、误报）要求确定性兜底 + 可观测。
- **Alternatives considered**: 维持现状静默降级（正是被点名的缺陷，否）。

## 未解项

无。所有 NEEDS CLARIFICATION 已在规格阶段以 Assumptions 收敛。

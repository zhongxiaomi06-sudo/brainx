# specs/038 — 跨进程重复触发顶替在途任务（P0）

> 状态：建档待评审（2026-10-16，咪批准排入下一轮）
> 优先级：P0（防重复付费）

## 一、背景与问题证据

**10-15 僵尸双任务实证还原**（四源交叉：会话记录 + ECS 留存日志 + 事件 idem_key + git 提交时间，详见 outputs/2026-10-16-sourcing-failure-trace.md §2.6）：

- `sm_2236d36c`（JBGTFRT/felix）与 `sm_13d6887e`（JC6JZPU/felix）启动后，其 SSH 会话被工具 120s 超时 SIGHUP 顺杀，两行永久卡 `running`；1 小时后被 `failStaleOpenmaiTasks` 兜底置 failed。
- 重跑的 retrofill 对同键再次触发——**如果当时传了 `--project-id`（现行版本确实传），`ON CONFLICT DO UPDATE` 就会顶替在途 task_id，旧任务 settle 永久失效（settle 要求 task_id 匹配）**。
- 本案因工作区版本 regression 丢了 `--project-id`，重复触发落合成键（主键不同）而未顶替——**hazard 真实存在，只是这次没踩响**。

**代码层现状（2026-10-16 行号复核）**：

| 路径 | 防重检查 | INSERT 顶替能力 |
|---|---|---|
| `src/supermai-sourcing.js:27`（进程内存 `running` Set）+ 69-73 行（只查内存集合 + done + failed 60s 冷却） | ❌ 无 DB running 行检查 | ✅ 104-114 行 ON CONFLICT DO UPDATE |
| `src/openmai-task.js:45`（job 模式，同款内存 Set + 230-234 行） | ❌ 无 DB running 行检查 | ✅ 264-273 行 ON CONFLICT DO UPDATE |
| `bin/brainx-supermai-search.mjs:92-99`（CLI 绕过 start*Task，自行 INSERT） | ❌ 无任何 running 检查 | ✅ 95-98 行 ON CONFLICT DO UPDATE |
| `bin/brainx-auto-search-retrofill.mjs:172-176`（already_done 只查 `status='done'`） | ❌ running 行不跳过 | 经 spawn 传导到上面三条 |

**根因**：`running` 集合是**进程内存**——CLI/trigger/retrofill 每次新进程即失效；唯一可靠的运行态信号是 DB 行 `status='running'`，但四个入口没有一个查它。

**代价**：已付费的 TTC/OpenMai 调用白跑（ settle 失效）+ 重触发 = 二次付费 + 1 小时后才被兜底 + 顾问侧静默（无告警）。

## 二、设计（最小 diff）

### 2.1 核心：INSERT 前查 DB running 行新鲜度

```js
// 伪代码，三路径同款
const live = db.prepare(`SELECT started_at FROM openmai_results
  WHERE project_id=? AND consultant_id=? AND status='running'`).get(project_id, consultant_id);
if (live && !force && Date.parse(live.started_at) > Date.now() - STALE_SEARCH_MS) {
  return { status: 'running', started_at: live.started_at };  // 拒绝启动，不碰 DB
}
```

- 阈值复用 `STALE_SEARCH_MS`（`src/openmai-delivery.js:16`，60min，与 failStaleOpenmaiTasks / H-2 超龄判定同一常量，语义一致）。
- `force`（continue_search 续搜）**不绕过**该检查——上一轮仍在途时续搜同样会造成顶替与双付费；续搜的正当前提是上一轮已 done。
- 超过 1h 的 running 行视为僵尸残留（与 H-2 / failStale 同标准），允许新任务启动并由 worker 兜底置 failed。

### 2.2 三路径覆盖

1. `src/supermai-sourcing.js`：69-73 行现有检查块之后、INSERT（104 行）之前加 DB running 查询；`startSupermaiScoutTask` 返回语义 `{ status: 'running' }`。
2. `src/openmai-task.js`：230-234 行之后、264 行 INSERT 之前同款加查。
3. `bin/brainx-supermai-search.mjs`：92 行 INSERT 之前加查；命中则打印 `ALREADY_RUNNING task started_at=…` 并 `process.exit(0)`（不视为 error——retrofill 对该退出码的记录语义见 2.3）。

### 2.3 retrofill 侧联动

- `bin/brainx-auto-search-retrofill.mjs:172-176`：already_done 查询扩展为 `status IN ('done','running')` 两段判定——done → already_done 跳过；running 且新鲜 → 新结果 `skipped_running` 计数跳过（不 spawn、不计 error）；running 且超龄 → 放行（僵尸将被兜底）。
- spawn 子进程退出码约定：CLI 命中 running 时 exit 0 + stdout 带 `ALREADY_RUNNING` 标记，retrofill 据此记 `skipped_running`。

### 2.4 CLI/agent 入口的行为对齐

- `tools-sourcing.js` 项目模式已有 `activeProjectSearch` 的 RUNNING 拦截（246-256 行）——**本项目把该纪律扩展到自由找人（合成键不在 project_launches，无对应检查）与所有直接 INSERT 路径**。

## 三、深度审核记录（2026-10-16）

### 3.1 边界用例

| # | 场景 | 预期行为 |
|---|---|---|
| 1 | 同进程内连续两次调用（内存 Set 命中） | 现有 `running.has(key)` 先行拦截，不变 |
| 2 | CLI 新进程 + DB 有新鲜 running 行 | 新检查拒绝，返回/打印 ALREADY_RUNNING |
| 3 | CLI 新进程 + DB 有 61 分钟前的 running 行（僵尸） | 放行启动；worker failStale 下一跳（≤5s）兜底旧行 |
| 4 | force 续搜 + 上一轮 running | 同样拒绝（设计决定：续搜不得顶替在途） |
| 5 | force 续搜 + 上一轮 done | 放行（正常路径，不受影响） |
| 6 | 上一轮 failed < 60s | 现有 60s 冷却先行拦截，不变 |
| 7 | retrofill 遇到 running 行 | skipped_running，不 spawn、不计 error |
| 8 | retrofill 遇到僵尸 running 行（>1h） | 放行 spawn；新任务 INSERT 顶替僵尸行（正确：僵尸结果作废） |
| 9 | 并发两个不同 consultant 同 project | 主键含 consultant_id，互不拦截（正确：各顾问独立任务） |
| 10 | web 项目模式（activeProjectSearch RUNNING） | 已有拦截，本项目不改其行为 |

### 3.2 回归风险

- **startOpenmaiTask 的 `already_done`/60s 冷却语义**：新检查插在两者之后，不改变现有返回码集合，仅新增 `running` 拒绝态——tools-sourcing.js 的 `out.status` 分支需确认 `running` 落入既有处理（markProjectSearch 57-58 行：`running` → `RUNNING`，已有）。
- **CLI exit 0 约定**：retrofill 197-205 行现有逻辑「r.code===0 && row.status==='done'」记 triggered；CLI 提前 exit 0 时 row 查询命中旧 running 行（status≠done）→ 落 `error` 分支计数——**必须同步改 retrofill 识别 ALREADY_RUNNING 标记**，否则误报 error。
- **测试**：`tests/` 下 openmai/supermai 既有用例需补「DB running 新鲜行拒绝」「僵尸行放行」「force 不 bypass」三例；CLI 层用临时 DB 集成测。

### 3.3 验收标准

1. 单测：三路径 ×（新鲜 running 拒绝 / 僵尸放行 / force 不 bypass / done 正常 / 内存 Set 现有行为）全绿。
2. 集成：临时 DB 模拟「CLI 启动 A → CLI 启动 B（同键）」→ B 退出 ALREADY_RUNNING，A 的 task_id 未被顶替，A settle 后 B 可正常启动。
3. retrofill：候选群存在新鲜 running 行 → 汇总出现 `skipped_running: N`，无 error 计数。
4. `npm run verify` 全绿 + 生产部署后回归一轮真实触发。

## 四、不做的事

- 不做任务级租约/心跳（failStale 1h 兜底已够，最小 diff 优先）。
- 不改 failStaleOpenmaiTasks 阈值与文案。
- 不动 D1 hazard 的另一面（start*Task 的 IIFE 生命周期）——CLI await 直连已是既定纪律。

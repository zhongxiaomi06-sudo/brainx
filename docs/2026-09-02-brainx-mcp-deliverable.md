# BrainX 下游交付文档 · MCP Server 接口契约与推进计划（2026-09-02）

> 上级入口：[BrainX 文档书](README.md)
>
> 适用场景：把 BrainX 决策库/人才库/reloop/官方接口以 MCP server 形式交付给 OpenClaw 侧（或其他外部 agent）。
>
> 文档性质：**交付契约 + 推进计划**。不取代[全景架构](architecture-2026-09-01-full-blueprint.md)与[OpenClaw 壳子架构](2026-09-02-openclaw-shell-architecture.md)；本文只覆盖**用户职责边界内的下游接口**。

## 1. 责任边界（一句话）

**本文档管"OpenClaw 调度的下游"：MCP server 工具集、接口契约、数据源读写、打包部署、环境凭据。OpenClaw 侧的 Skill 编写、飞书渠道接入、open_id ↔ consultant_id 映射、Gateway 配置——都不是本文档职责，只列出对接要求让 OpenClaw 侧自取。**

| 项 | 边界内（我负责） | 边界外（OpenClaw 侧负责） |
|---|---|---|
| 工具清单与契约 | ✅ | |
| 决策库/人才库/reloop/官方接口读写 | ✅ | |
| MCP server 启动/打包/部署/日志 | ✅ | |
| 环境变量与凭据 | ✅ | |
| 错误码与幂等键语义 | ✅ | |
| JSON-RPC 2.0 协议实现 | ✅ | |
| Skill 怎么写（如何把"用户问 X"映射到"调 Y"） | | ✅ |
| 飞书官方插件配置（`openclaw channels add`） | | ✅ |
| Gateway 配置（`~/.openclaw/openclaw.json`） | | ✅ |
| 飞书 open_id ↔ BrainX consultant_id 映射 | | ✅ |
| 群策略/多群路由/会话记忆 | | ✅ |

## 2. 架构层次（我在哪一层）

```text
┌─ 上游：OpenClaw 壳子 + 自写 Skill（OpenClaw 侧）───────────────────┐
│   把用户问句翻译成 "调 MCP tool X，参数 consultant_id=Y"                │
└────────────────────────┬────────────────────────────────────────────┘
                         │ JSON-RPC 2.0 over stdio（NDJSON，每行一个 JSON）
                         ▼
┌─ 边界：本仓库交付的 MCP server（用户负责）───────────────────────────┐
│   mcp/server.mjs（272 行，零依赖手写）                                │
│   ┌─ 工具注册表 ─┐ ┌─ 协议层 ─┐ ┌─ 领域函数复用 ─┐                    │
│   │ 15 工具       │ │ JSON-RPC │ │ src/*.js 同一套 │                │
│   │ (含读写)      │ │ + NDJSON │ │ 领域逻辑        │                │
│   └───────────────┘ └─────────┘ └────────┬───────┘                │
└──────────────────────────────────────────┼─────────────────────────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              ▼                            ▼                            ▼
┌─ 决策库（本地 SQLite）──┐ ┌─ 人才库（阿里云 RDS MySQL）──┐ ┌─ reloop API ──┐
│ data/brainx.db        │ │ ttc-rds-public-0707        │ │ 只经 token     │
│ 自动建表              │ │ IP 白名单 + .env 凭据      │ │ 桥 1 待接入    │
│ 工作台/承接/事件/账本 │ │ 候选人+简历+标签+匹配      │ │                │
└──────────────────────┘ └────────────────────────────┘ └────────────────┘
                                           │
                                           ▼
                              ┌─ 官方数据接口（用户手上）─┐
                              │ 端点/鉴权/错误码待补      │
                              │ 9/14 前包 Skill + scripts │
                              │ 决赛后包 MCP server      │
                              └───────────────────────────┘
```

## 3. 已交付：MCP server 工具现状

**位置**：`mcp/server.mjs`（272 行，**零依赖**手写 NDJSON + JSON-RPC 2.0）。
**启动**：`node ./mcp/server.mjs`（stdio 模式，父进程管生命周期）。
**协议**：`PROTOCOL_VERSION = "2024-11-05"`，**NDJSON**（每行一个 JSON-RPC 2.0 消息）。
**共享可见性**：`src/visibility.js` 是单一权威（server.js 与 mcp 共用，fail-closed），防止两处过滤逻辑分叉。

### 3.1 工具清单（15 个，按读写分）

| # | 工具名 | 类型 | 入参 | 输出要点 | 守门 |
|---|---|---|---|---|---|
| 1 | `brainx_consultants` | 只读 | `{}` | 顾问花名册，仅 `consultant_id` + `display_name` | 全局无隔离（花名册本就该跨人） |
| 2 | `brainx_workbench` | 只读 | `{consultant_id}` | 同步状态 / 承接摘要 / 今日 Top3 | 恒为传入 cid |
| 3 | `brainx_recommendations` | 只读 | `{consultant_id, limit?}` | 最近一轮推荐（冻结行） | 同步不完整时返回 `blocked` |
| 4 | `brainx_opportunity` | 只读 | `{consultant_id, project_id}` | 单职位全量（事实/关系/承接/事件/结果/最近推荐） | `jobVisibleTo` 守门 |
| 5 | `brainx_progress_suggestion` | 只读 | `{consultant_id, project_id, kind?, stage?}` | 下一行动草案（PROGRESS/STAGE/BLOCKED） | `jobVisibleTo` 守门 |
| 6 | `brainx_replay` | 只读 | `{decision_id, consultant_id}` | 决策回放 | 跨人=`NOT_FOUND`，roster 校验 |
| 7 | `brainx_push_preview` | 只读 | `{consultant_id}` | 今日推送卡片预览（不发） | 仅本人 |
| 8 | `brainx_recommend_run` | **写** | `{consultant_id, top?}` | 生成一轮新推荐（写 `recommendations` + `RECOMMENDED` 事件） | 仅本人 |
| 9 | `brainx_feedback` | **写** | `{consultant_id, project_id, reason?, undo?, idempotency_key}` | F3 反馈（`NOT_INTERESTED`，可撤销） | 同工作台 ×按钮 |
| 10 | `brainx_engage` | **写** | `{consultant_id, project_id, action, confirm?, reason?, summary?, goal?, action_title?, due_at?, idempotency_key}` | 承接操作（`VIEW/WATCH/UNWATCH/ACCEPT/DISMISS/RELEASE`） | `jobVisibleTo`；ACCEPT 必带 goal/action_title/due_at |
| 11 | `brainx_record_progress` | **写** | `{consultant_id, project_id, action_id, summary, next_action, kind?, stage?, rating?, idempotency_key}` | 推进 + 下一行动（原子） | `jobVisibleTo` |
| 12 | `brainx_terminal_result` | **写** | `{consultant_id, project_id, stage, summary, close_reason?, idempotency_key}` | 入职或关闭 | `jobVisibleTo` |
| 13 | `brainx_record_outcome` | **写** | `{consultant_id, project_id, stage, value?, decision_id?, idempotency_key}` | 结果观察（幂等） | actor=cid |
| 14 | `brainx_sync_now` | **写** | `{consultant_id, source?, dry_run?}` | 触发一次同步（`source: fixture\|feishu`） | 仅本人 |
| 15 | `brainx_profile` | 读+写 | `{consultant_id, profile_keywords?, profile_note?}` | 空参数=读；传值=更新（仅本人） | roster 校验 |

**actor 守门**：所有工具的 `consultant_id` 都必须通过 roster 校验（`loadConsultants`）。缺失或未知 = `UNKNOWN_CONSULTANT`。**不放行"声明身份兜底"路径**（2026-08-20 信任对齐收紧）。

**幂等**：所有写工具必填 `idempotency_key`。重复键返回 `already`。MCP server 不做键持久化（在领域函数里），重启后失效属预期。

### 3.2 错误响应规范

工具调用错误统一返回：

```json
{
  "content": [{ "type": "text", "text": "ERROR: <message>" }],
  "isError": true
}
```

常见错误码：

| 错误 | 来源 | 含义 |
|---|---|---|
| `NOT_FOUND` | 跨人查询 / 不存在 project_id / 跨顾问回放 | 故意不区分（防探测） |
| `UNKNOWN_CONSULTANT` | `consultant_id` 不在 roster | 信任边界拒绝 |
| `SQL_GUARD` | 仅出现在产品内嵌 agent（不出现在 MCP server） | — |
| `SUPPLY_DISABLED` | `BRAINX_TALENT_SUPPLY` 未开 | 配置开关 |
| `SUPPLY_NOT_FOUND` | 职位尚无供给记录 | 数据空 |
| `TTC 凭证失效（401/403）` | OpenMai/TTC 侧 | 凭据过期，需重新扫码同步 |
| `TTC code != 0` | TTC API 业务错 | 透传 |
| 协议层 `-32601` | 未知 tool / 未知 method | MCP 协议错 |
| 协议层 `-32603` | 内部异常 | MCP 协议错 |

### 3.3 当前未暴露的工具（用户需补的，详见 §6）

- **OpenMai 找人**：`startOpenmaiTask` / `getOpenmaiResult` 已写好但未注册
- **人才库查询**：`talentHealth` / `listTalentsWithTags` / `getTalent` / `listResumes` 未注册
- **人才供给**：`readTalentSupply` / `talentSupplyForJob` 未注册
- **机会雷达 / 客户洞察**：`radarPayload` / `clientRows` 未注册（产品在 agent/registry 里有，MCP server 没）
- **reloop 桥 1/2 端到端**：无实现
- **官方数据接口**：完全未接入

## 4. 接口契约

### 4.1 协议

- **传输**：stdin/stdout NDJSON，每行一个 JSON-RPC 2.0 消息
- **初始化**：`initialize` 返回 `protocolVersion / capabilities.tools / serverInfo{name='brainx-mcp', version='1.0.0'}`
- **工具发现**：`tools/list` 返回 `{name, description, inputSchema}` 数组
- **工具调用**：`tools/call` 入参 `{name, arguments}`，返回 `{content: [{type:'text', text: <JSON>}]}`
- **心跳**：`ping` → `{}`

### 4.2 重要不变量

1. **actor 透传**：调用方必须传 `consultant_id`。**server 不做兜底**——缺=返回 `UNKNOWN_CONSULTANT`。
2. **可见性单一权威**：所有"是否可见"的判断走 `src/visibility.js`，禁止在工具内重写。
3. **写操作必带幂等键**：除 `brainx_consultants` / `brainx_workbench` / `brainx_push_preview` / `brainx_progress_suggestion` / `brainx_opportunity` / `brainx_replay` / `brainx_recommendations` 外，所有写工具必填 `idempotency_key`。
4. **错误即不写**：任何抛错都不进入事务提交层。
5. **返回 JSON 化**：所有返回值经 `JSON.stringify(value, null, 1)` 后塞入 `content[0].text`，超大值截断到 `RESULT_CAP = 30000`（与 `src/agent/registry.js` 一致）。

### 4.3 父进程通信

MCP server 是无状态进程，**生命周期由父进程管**。父进程：

- 启动后立即可用（不需等待 `initialize`）
- stderr 第一行是 `brainx-mcp ready (stdio)`，可用于探活
- 进程崩溃 = 子调用方重连即可（领域函数里已自包含持久化）

## 5. 数据源与依赖

| 数据源 | 位置 | 用途 | 状态 |
|---|---|---|---|
| **决策库** | 本地 SQLite `data/brainx.db` | 工作台/承接/事件/账本/推荐/回放/观察 | 已建，自动 init |
| **人才库** | 阿里云 RDS MySQL `ttc-rds-public-0707.mysql.rds.aliyuncs.com` | 候选人/供给/匹配/标签 | IP 白名单 + `.env` 凭据；连不通自动降级进程内内存库 |
| **reloop** | reloop 侧 API（token） | 候选人权威域、推人循环 | **未接入**，等联系人（Dykes/Frankie） |
| **TTC CRM** | `https://api.ttcadvisory.com`（JWT） | OpenMai 触发源、CRM 职位详情 | 已对接（`ttcsdk/auth.js` 管 JWT） |
| **OpenMai** | `https://gateway.ttcadvisory.com` | 自动找人 | 已对接（`openmai-task.js`），**但未暴露到 MCP** |
| **官方数据接口** | 端点/鉴权待补 | 用户手上的接口 | **完全未接入** |

### 5.1 人才库两个坑（演示日高发）

1. **契约与代码不一致**：[复用与自建边界 PRD §6](prd-2026-09-01-reuse-selfbuild-boundary.md) 定 MySQL 人才库**只读账号**，但 `src/talent.js` 当前是**可写层**（候选人 UPSERT、标签写入、匹配覆盖写）。**必须二选一**：要么改代码为只读，要么正式放宽契约。**未对齐前不接 MCP**。
2. **静默降级**：连不通 RDS 时 `src/talent.js` 自动退进程内内存库，页面照常显示假数据**且无报错**。**对策**——MCP 工具暴露 `talentHealth`（返回 `backend: 'mysql' | 'memory'` + 错误原因），演示前必须显式返回 `mysql`，健康简报留证。

### 5.2 环境变量

`.env` 通过 `src/env.js` 自动加载（必须作为每个入口的第一个 import，副作用先于读 env 的模块）。**.env 永不提交**。

| 键 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `BRAINX_MYSQL_USER` | 人才库启用时 | — | RDS 账号 |
| `BRAINX_MYSQL_PASSWORD` | 人才库启用时 | — | RDS 密码 |
| `BRAINX_MYSQL_DATABASE` | 人才库启用时 | — | RDS 库名 |
| `BRAINX_MYSQL_HOST` | 否 | `ttc-rds-public-0707.mysql.rds.aliyuncs.com` | RDS 主机 |
| `BRAINX_TALENT_SUPPLY` | 否 | `0` | `1` 启用人才供给工具 |
| `BRAINX_TTC_API_BASE` | 否 | `https://api.ttcadvisory.com` | TTC CRM |
| `BRAINX_OPENMAI_API_BASE` | 否 | `https://gateway.ttcadvisory.com` | OpenMai |
| `BRAINX_TTC_*` | OpenMai 触发时 | — | TTC JWT 持久化（`ttcsdk/auth.js` 维护） |
| `BRAINX_FEISHU_*` / `LARK_*` | 飞书相关 | — | 飞书 App 凭据（§4.4 OpenClaw 侧需要） |
| `BRAINX_LARK_PROFILE` | 否 | 空 | lark-cli profile 名（多应用并存时显式指定） |
| `BRAINX_ENV_FILE` | 否 | `<repo>/.env` | 覆盖默认 .env 路径 |
| `BRAINX_AGENT_SQL` | 否 | `1` | **只影响产品内嵌 agent 的 `query_sql` 工具**，**不影响 MCP server** |

> **workspace .env 隔离提醒**（OpenClaw 安全约束）：OpenClaw 的 workspace `.env` 被设计成 fail-closed——不能覆盖 `OPENCLAW_*` 与 provider 凭证键（GEMINI/DEEPSEEK/BRAVE 等）。BrainX MCP server 通过 `process.loadEnvFile()` 在自身进程内读取，不受 OpenClaw 的 fail-closed 规则约束，但**禁止在 Skill 内写死 token**——一律 `${ENV_VAR}` 由 OpenClaw 注入。

## 6. 打包与部署

### 6.1 本地启动（开发）

```bash
# 启动 MCP server（stdio 模式，需父进程管生命周期）
node ./mcp/server.mjs

# 配套 HTTP server（用于前端与 SSE）
npm start               # 等价于 node src/server.js

# 一次性命令入口
npm run sync            # bin/brainx-sync.mjs
npm run openmai         # bin/brainx-openmai.mjs
npm run recommend       # bin/brainx-recommend.mjs
npm run push            # bin/brainx-push.mjs --send
```

### 6.2 生产部署

- 服务地址：`47.110.93.137:3101` / `4322` / `3000`
- systemd 单元：`bin/brainx.service`（含 HOME 修复）
- macOS launchd：`bin/com.brainx.web.plist`
- Docker：`Dockerfile`（仓库根）
- 安装脚本：`bin/install-launchd.sh`

**部署清单**（演示日 9/11 前要绿）：

```bash
# 1. 同步代码与 .env
ssh root@47.110.93.137
cd /path/to/brainx
git pull --ff-only

# 2. 验证环境
npm run verify:quick    # 快速门禁
npm run talent:health   # 人才库连通（必须 mysql，不能 memory）

# 3. 启动 MCP server（演示机）
# 由 OpenClaw 父进程拉起（详见 §7.2 openclaw.json 配置）
node ./mcp/server.mjs &

# 4. 启动 HTTP server
systemctl restart brainx.service   # 或 npm start（开发）
```

### 6.3 OpenClaw 侧的对接配置（**用户不管写**，仅作下游要求参考）

OpenClaw 侧应在 `~/.openclaw/openclaw.json` 加：

```jsonc
{
  "mcp": {
    "servers": {
      "brainx-domain": {
        "command": "node",
        "args": ["/abs/path/to/brainx/mcp/server.mjs"],
        "transport": "stdio",
        "env": {
          "BRAINX_ENV_FILE": "/abs/path/to/brainx/.env"
        }
      }
    }
  }
}
```

> 注意：用户**不写**这份配置，也不写 Skill、不处理飞书 open_id 映射。这些是 OpenClaw 侧的职责。

## 7. 缺什么与推进计划

按"阻塞演示链路的程度"排序。

### 7.1 P0 · 必做（9/14 演示前，否则核心功能不可用）

| 缺什么 | 影响 | 工期估算 |
|---|---|---|
| **OpenMai 工具暴露**：`brainx_openmai_result` / `brainx_openmai_run` 注册到 MCP server | 飞书群不能触发自动找人 | 0.5 天 |
| **人才库工具暴露**：`brainx_talent_mine`（**先改造为"我的候选人"cid 隔离**，§5.1 坑 1 未解决前禁止挂）+ `brainx_talent_health` | 飞书群不能查候选人（白名单已划：禁止直接挂 `brainx_talent`） | 1.5 天（含 talent 改造） |
| **人才库契约对齐**：要么改代码为只读、要么放宽契约（与 reuse PRD §6 二选一） | 不对齐就接 MCP = 引入新隐私出口 | 0.5 天 |
| **环境/部署验证**：演示机 IP 加白名单 + `talent:health` 留证 | 不在白名单 = 静默降级到内存库（假数据） | 0.5 天 |

### 7.2 P1 · 应做（决赛质量提升）

| 缺什么 | 影响 | 工期估算 |
|---|---|---|
| **人才供给工具暴露**：`brainx_talent_supply`（需脱敏脚本，只回可匹配人数/难度/命中词，不回候选人 ID 以外字段） | 飞书群不能问"这职位有多少人可匹配" | 1 天 |
| **雷达 / 客户洞察**：`brainx_radar` / `brainx_clients` 注册到 MCP server | 飞书群不能查机会池与客户聚合 | 0.5 天 |
| **reloop 桥 1**：BrainX `ACCEPTED` → reloop 幂等建岗 → 回传 `position_id` | 演示日推人循环断在第一公里 | 2 天（依赖 reloop 联系人 Dykes/Frankie） |
| **OpenMai 结果脚本脱敏**：候选人池输出仅 `run_id` + `status` + 候选人 ID 列表 | 防候选人敏感进群 | 0.5 天 |

### 7.3 P2 · 可缓（决赛后规范）

| 缺什么 | 影响 | 工期估算 |
|---|---|---|
| **官方数据接口 MCP server**（用户手上的）：`vendor-official` server，端点契约 + 鉴权 + 错误码定义 | 飞书群不能调官方接口 | 1-2 天（含接口契约文档化） |
| **reloop 桥 2/3**：推人循环、提交简历回流 | 自动化推人跑不全 | 5+ 天 |
| **OpenClaw `query_sql` 等价物**：把决策库的能力通过 Skill `scripts/` 暴露，不暴露 query_sql（白名单决定） | 自定义统计还得手动跑 | 0.5 天 |
| **MCP server 协议升级**：跟踪上游 `protocol_version` 演进 | 长期维护 | 0.5 天/季度 |

## 8. 红线

1. **隐私**：候选人手机号/邮箱/简历原文不出 MCP 输出（含 `error` 文本）。如发现泄漏，立即改契约。
2. **演员守门**：调用方传 `consultant_id` ≠ roster → `UNKNOWN_CONSULTANT`，**不做兜底**。OpenClaw 侧必须自己处理 open_id 映射。
3. **静默降级**：人才库连不通时**工具必须显式返回 `backend: 'memory'`**，禁止假装是 MySQL。
4. **幂等键**：写操作不传幂等键 = 直接返回参数错误，禁止替调用方生成键（除非明确是默认派生键，如 `brainx_feedback` 用 `mcp-feedback:<cid>:<pid>:<snap>`）。
5. **凭据**：`.env` 不进仓库；Skill / 脚本内 token 走 `${ENV_VAR}`，禁止写死。
6. **写入边界**：MCP server 写的是决策库 SQLite + 人才库（如 §5.1 已对齐）。reloop 只读不写——所有 reloop 写操作走 API token 通道，由 MCP server 代理而非直连。

## 9. OpenClaw 侧需要什么（用户不写，只列需求让对方自取）

> 这一节是给 OpenClaw 侧看的契约要求，不是我的职责。

1. **配置** `mcp.servers.brainx-domain`（见 §6.3）
2. **Skill 编写**：
   - 7 个已有 SKILL.md 已 100% 通过 OpenClaw 合规校验（[架构文档 §5](2026-09-02-openclaw-shell-architecture.md) 实测），可直接 `cp` 到 `~/.openclaw/workspace/skills/`
   - 剩余工具按 §5.1 流水线 AI 生成 + 人工校口径
3. **身份透传**：飞书 open_id ↔ `consultant_id` 映射。映射表来源待定（要么 OpenClaw 侧自己维护，要么 BrainX 侧通过新工具暴露）
4. **会话上下文**：每个 MCP 调用传 `consultant_id`，**OpenClaw 侧必须持有当前会话所属顾问身份**
5. **错误处理**：`isError: true` 的响应不要直接抛回用户，按工具的"领域错误码"语义翻译（如 `NOT_FOUND` → "暂无该职位"）
6. **失败重试**：MCP server 写操作幂等键一致即可重试；只读操作可任意重试

## 10. 我现在要做的事（今晚 9/2 起的推进）

按 P0 → P1 顺序，今天晚上 + 明天白天能做的：

**今晚（9/2 21:00 前）**
1. 拍板人才库契约（只读 / 可写），与 reuse PRD §6 对齐
3. 跑一次端到端：用 `npx @modelcontextprotocol/inspector` 或 Claude Code 实调 5 个工具（consultants/workbench/opportunity/engage/feedback），确认契约无误

**明天（9/3）**
1. P0-1：把 OpenMai 两个工具加进 MCP server（直接 import + 注册，半小时）
2. P0-2：把人才库工具加进 MCP server（**先做 cid 隔离改造**，半天）
3. P0-4：演示机加白名单 + `talent:health` 留证
4. P1-1：人才供给工具脱敏脚本
5. P1-2：雷达/客户洞察工具补齐
6. 9/3 验证日同步：`pingMysql()` + `talentHealth()` 双确认，记录当前后端

**9/4 后**：推人循环优先级高于 MCP server 继续扩面。reloop 桥 1 与 P1-3 在 9/4-9/8 推进。

## 相关文档

- [OpenClaw 壳子 + 自写 Skill 架构](2026-09-02-openclaw-shell-architecture.md) — 上游架构与责任边界
- [全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md) — BrainX 整体
- [复用与自建边界及权限需求 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md) — 人才库"只读账号"原始定义
- [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) — TTC ↔ BrainX ↔ reloop 三方 ID 映射
- `mcp/server.mjs` — 本文档交付的 MCP server 源码
- `src/visibility.js` — 可见性单一权威（server.js 与 mcp 共用）
- `src/env.js` — 零依赖 .env 加载
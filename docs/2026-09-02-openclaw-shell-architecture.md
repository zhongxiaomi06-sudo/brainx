# OpenClaw 壳子 + 自写 Skill 架构（2026-09-02 重写版）

> 上级入口：[BrainX 文档书](README.md)
>
> 本文取代 [DataClaw 集成交流与架构重排简报](2026-09-02-dataclaw-integration-brief.md) 的架构结论。那份文档降级为交流会历史底稿，其 §6 人才库/reloop 事实已并入本文 §8。
>
> 文档性质：**架构决策**。不取代[全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md)的施工逻辑；本文只裁定"BrainX 与 OpenClaw 的分工"。

## 1. 一句话结论

**DataClaw 不是我们的上游，是同构参照物。壳子是开源的 OpenClaw，数据是官方接口，Skill 是 AI 生成 + 人工改——三样都不构成技术壁垒。**

**去掉技术变量后，差距只剩两处：谁的领域知识更准（决定 Skill 写得对不对、口径对不对），谁的效果数据更早（他们有 35%→80%）。前者我们占优——已建成的领域权威层、15 个只读工具、7 个已合规 Skill 都是现成弹药；后者我们追不上也不必追，那是"跑得早"的红利，不是能力差。**

## 2. 为什么翻转：五个新事实

| 新事实 | 推翻了什么 |
|---|---|
| DataClaw 也是拿 OpenClaw 当壳子 | 推翻"他们有自研 IM 内核"的假设。IM 层不是他们的壁垒，是开源件，我们同样零成本可得 |
| Skill 是他们自己写的——**而且是 AI 生成 + 自己改** | 推翻"Skill 有技术门槛"的假设。Skill 可工业化批量生成，人工只需改口径；同时推翻"要等他们开放插件协议"——Skill 是本地文件，不是平台能力 |
| 他们不让我们直接用他们的产品 | 推翻 A 方案（做它的插件）。这条路已被明确封死，不是谈不谈得下来的问题 |
| **你手上有官方数据接口（和他们一样是官方的）** | 推翻"数据是瓶颈"的判断。数据供给双方持平，缺的只是把接口挂进壳子 |

**合起来：三条技术路径全部同一水平线**——壳子同为开源 OpenClaw、数据同为官方接口、Skill 同为 AI 生成。原方案在为一个不存在的壁垒（自研 IM）让渡主权（群入口、留痕、身份），这个让渡不成立。

**因此真正的差异化只剩"领域知识"这一处**，而它恰好是花钱买不到、AI 也编不出来的部分：

| 差异点 | 谁占优 | 说明 |
|---|---|---|
| 领域口径（职位/候选人/Case 的业务真值） | **我们** | 领域权威层、15 个只读工具、7 个已合规 Skill 都是现成的 |
| 数据接口的丰富度与稳定性 | 持平或视接口而定 | 都是官方接口，看谁的覆盖更全 |
| 效果数据（35%→80%） | **他们** | 跑得早的红利，不是能力差；我们用 baseline-1.1 六维口径打另一侧 |
| IM / 多轮 / 意图识别 | 持平 | 同为 OpenClaw 壳子 |

## 3. 新架构

```text
┌─ 飞书群（顾问群 / 项目群 / 客户群）──────────────────────────┐
│   OpenClaw 飞书渠道（官方插件，WS 长连接，仅需 AppID+Secret）│
└────────────────────────┬─────────────────────────────────────┘
                         ▼
┌─ OpenClaw 壳子（Gateway 常驻，默认 ws://127.0.0.1:18789）─────┐
│   会话路由 · 意图识别 · 多轮对话 · 记忆三层 · 权限/审计       │
└──────┬──────────────────────────────────┬────────────────────┘
       ▼ Skill 层（WHAT：该怎么做）        ▼ MCP 层（HOW：真去调）
┌─ ~/.openclaw/workspace/skills/ ─┐   ┌─ openclaw.json: mcp.servers ──┐
│ brainx-workbench      已合规    │   │ brainx-domain  本地 stdio     │
│ brainx-talent         已合规    │   │  → 15 个只读工具              │
│ brainx-engagement     已合规    │   │ vendor-official 远程 http     │
│ brainx-report         已合规    │   │  → 你手上的官方数据接口       │
│ brainx-ops            已合规    │   │ reloop-api    远程 http       │
│ brainx-data-explorer  已合规    │   │  → 候选人域（只经 token）     │
│ brainx-hunter-playbook 已合规   │   └──────────────┬────────────────┘
└─────────────────────────────────┘                  │
                                                     ▼
                        ┌─ BrainX 领域权威层（不因换壳子而改变）──┐
                        │ workflow_event_log + idx_wel_idem 账本  │
                        │ entity_links（TTC↔BrainX↔reloop 映射）  │
                        │ 决策库 SQLite / 人才库 RDS / reloop 桥  │
                        └─────────────────────────────────────────┘
```

**分工铁律（换壳子后仍然成立）**

1. **OpenClaw 拥有"对话"，BrainX 拥有"事实"。** OpenClaw 负责听懂人话、决定调什么；BrainX 负责回答业务真值、裁决状态、守住隐私。
2. **写动作一律回 BrainX 领域函数。** Skill 只能调 BrainX 的只读工具或走 MCP 的窄接口，不得让 OpenClaw 直连任何一张表。
3. **留痕唯一权威仍是 `workflow_event_log`。** 换壳子不换账本——这条是审计底线，见 §7 双轨决策。

## 4. 开源工具清单：怎么用 OpenClaw 接进飞书

这部分是你要的"开源工具怎么用"。按必装 / 选装分。

### 4.1 必装

| 工具 | 作用 | 获取 |
|---|---|---|
| **OpenClaw** | 壳子本体，原 Clawdbot，本地优先的 Agent 运行时网关 | 开源仓库，Gateway 默认 `ws://127.0.0.1:18789` |
| **飞书渠道插件** | 让 OpenClaw 收发飞书消息 | 新版内置：`openclaw plugins enable feishu`；旧版装社区件：`openclaw plugins install @m1heng-clawd/feishu` |

### 4.2 选装（按需要）

| 工具 | 作用 | 备注 |
|---|---|---|
| **飞书官方 CLI** | `npx @larksuite/cli@latest`，MIT 协议，覆盖 IM/云文档/云盘/电子表格/多维表格/日历/邮件/通讯录/任务/事件/视频会议/画板 12 项能力 | **做 Skill 里确定性脚本的最佳选择**——发消息、建日程、读表格不用自己写 HTTP |
| **ClawHub** | Skill 市场：`clawhub install` / `list` / `update --all` | 装前审源码，第三方 Skill 当不可信代码 |
| **MCP 生态** | 标准协议接外部工具/库/API；写自己的用 `@modelcontextprotocol/sdk` | 生态已 32,600+ server |
| **`openclaw mcp serve`** | 把 Gateway 自己暴露成 MCP server | 反过来我们用：未来 BrainX 也能被别的 Agent 当工具调 |

### 4.3 接入步骤（OpenClaw 侧，命令行）

```bash
# 方式一：向导（首次安装推荐）
openclaw onboard            # 选 Feishu → 填 App ID / App Secret → 启网关

# 方式二：命令行（已装过用这个）
openclaw channels add
# 依次选：Feishu/Lark (needs app creds) → Enter App Secret
#        → 填 App ID / App Secret
#        → domain: feishu（国内）/ lark（国际版）
#        → 群聊策略：Open（响应所有群，需 @）/ Allowlist（只白名单群）
#        → Finished

# 或直接写配置 ~/.openclaw/openclaw.json
# { "channels": { "feishu": { "enabled": true, "appId": "cli_xxx",
#     "appSecret": "xxx", "domain": "feishu" } } }

openclaw gateway restart    # 改完配置重启生效
openclaw gateway status     # 查运行状态
openclaw logs --follow      # 实时日志排障
```

### 4.4 接入步骤（飞书后台，你自己操作，6 步）

1. 开放平台 → **创建企业自建应用**（国际版 Lark 用 `open.larksuite.com/app`）
2. 添加应用能力 → **机器人**
3. 权限管理 → **批量导入**权限 JSON（至少含消息收发、`im:resource`、通讯录基本信息）
4. 事件与回调 → 订阅方式 → **使用长连接接收事件**（WS 模式，**不需要公网 IP**）
5. 添加事件：**接收消息、消息已读、机器人进群、机器人被移出群**
6. **创建版本 → 确认发布** ← 漏了这步，前面权限全不生效

> **省事点**：OpenClaw 走 WS 长连接，**只要 App ID + App Secret 两个凭证**；BrainX Step 1 自建网关额外要 Encrypt Key + Verification Token。两套系统用的是同一对凭证——你配一次，两边都能用（见 §7 双轨）。

## 5. Skill 迁移：现有 7 个技能零改造可用

这是本次调研最有价值的发现。我对 `skills/brainx-*` 逐个实测了 OpenClaw 的 SKILL.md 合规要求：

| 技能 | description 字数 | 正文行数 | 目录名 == name | 判定 |
|---|---|---|---|---|
| brainx-data-explorer | 95 | 66 | 是 | 合规 |
| brainx-engagement | 79 | 34 | 是 | 合规 |
| brainx-hunter-playbook | 133 | 28 | 是 | 合规 |
| brainx-ops | 90 | 39 | 是 | 合规 |
| brainx-report | 101 | 45 | 是 | 合规 |
| brainx-talent | 84 | 30 | 是 | 合规 |
| brainx-workbench | 70 | 30 | 是 | 合规 |

OpenClaw 的三条硬门槛是：目录名与 `name` 一致、description < 160 字符、正文 < 500 行。**七个全部满足，最长 description 133 字符，最长正文 66 行。**

原因是我们当初按自己的 `skills/README.md` 契约写的——frontmatter 只保留 `name` / `description`，正文写"做什么 + 什么时候用"，恰好就是 OpenClaw 的规范子集。

迁移命令：

```bash
mkdir -p ~/.openclaw/workspace/skills/
cp -R skills/brainx-* ~/.openclaw/workspace/skills/
openclaw skills list        # 确认 7 个都被发现
openclaw gateway restart
```

**需要补的只有两处**（不是格式问题，是运行依赖）：

1. **Gating**：给依赖官方数据接口的技能补 `metadata.openclaw.requires`，缺凭证时不加载而不是带着空 token 跑。
   ```yaml
   metadata:
     openclaw:
       requires:
         bins: ["node"]
         env: ["BRAINX_API_TOKEN"]
       primaryEnv: "BRAINX_API_TOKEN"
       os: ["darwin"]
   ```
2. **工具名要落地**：正文里 `brainx_talent({health:true})` 这类记号现在是内部约定，挂进 OpenClaw 后必须变成真实可调用的工具——由 §6 的 MCP 层提供。

### 5.1 Skill 应当工业化生成，人工只改口径

（本节依据：DataClaw 的 Skill 也是 AI 生成 + 自己改。这印证了 Skill 层不该手工精雕。）

既然对方的做法是"AI 生成 + 人工改"，这就是这层的正确姿势。**批量生成 + 人工校准口径**，而不是逐个手写。

我们的生成素材比他们好——`src/agent/registry.js` 的 15 个只读工具**已带完整 schema**（`name` / `description` / `parameters`），其中 description 是中文且写清了口径（例如"同步不完整时返回 blocked""只能查本人"）。这些 description 就是 Skill 正文的最佳来源，比从零让 AI 猜强得多。

**但不是 15 个都能外露。** 生成前先划掉两个：`query_sql`（让 agent 直查 SQL，挂进 OpenClaw 等于把决策库开给群里的自然语言输入，SQL 注入面直接从 Web 扩到群里）与 `load_skill`（元工具，不该对外）。**先定白名单再生成**，别生成完再挑。

```text
工具 schema（15 个，已有）
   │  AI 批量生成：一个工具 → 一个 SKILL.md
   ▼
SKILL.md 草稿
   │  人工只改三处
   ├── ① 口径校正：blocked / empty / SUPPLY_DISABLED 等状态如何向用户表述
   ├── ② 脱敏规则：哪些字段绝不输出，只回 evidence_ref
   └── ③ 写意图指引：机器人不执行，明确指引去工作台
   ▼
合规校验（§5 那张表的三条硬门槛 + 下面 4 个坑）
```

**AI 生成 Skill 的四个典型坑**（也是对方"自己改"大概率在改的东西），生成后必须逐条查：

| 坑 | 表现 | 检查方式 |
|---|---|---|
| 触发词写错 | description 没写清"什么时候用"，问到也不加载 | 拿真实问法逐条试："有没有合适的候选人" |
| 工具名与真名不符 | 正文写 `brainx_talent`，实际工具叫别的 | 正文每个工具名 grep 一遍 registry.js |
| 敏感字段直出 | 让机器人把手机号念进群里 | 全文搜"手机号/邮箱/简历原文"，必须为零 |
| 幻觉参数 | 编出不存在的入参，调用必失败 | 每个参数与 `parameters` 逐字段比对 |

**核心判断：人工改的是口径，不是语法。** 语法错了肉眼可见、跑一下就崩；口径错了要等演示现场才暴露——所以上面三处人工校正不能省，其余交给生成。

### 5.2 工具外露白名单（实测）

（本节依据：逐个读 `src/agent/registry.js` 与 `src/agent/tools/*.js` 的 schema + 隔离实现。挂进 OpenClaw 之前必须先定白名单——`§5.1` 流水线只能遍历白名单内的工具。）

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

## 6. 官方数据接口怎么挂进来

你手上有官方数据接口，这是相对 DataClaw 的优势。挂进 OpenClaw 有两条路：

**路径 A：MCP server（规范，决赛后）**

```json
{ "mcp": { "servers": {
  "vendor-official": {
    "url": "https://你的接口域名/mcp",
    "transport": "streamable-http",
    "headers": { "Authorization": "Bearer ${VENDOR_API_KEY}" }
  },
  "brainx-domain": {
    "command": "node",
    "args": ["/abs/path/brainx/mcp/domain-server.mjs"],
    "env": { "BRAINX_DB": "${BRAINX_DB}" }
  }
} } }
```

收益：工具自动被 agent 发现、参数有 schema、权限可收敛到单个 server。代价：要写 server 代码 + 调 transport。

**路径 B：Skill + `scripts/`（快，9/14 前走这条）**

SKILL.md 正文里写清楚"要查 X 就跑 `node {baseDir}/scripts/query-official.mjs --type X`"，脚本里封装鉴权与字段投影。

**判断：9/14 前用 B，决赛后用 A 规范化。** B 只需要一个脚本，A 要写 server + 调试 transport + 处理重连。时间不够时先拿结果，接口形状稳定后再包 MCP。

三条硬约束（无论 A 还是 B）：

- **凭证只走 env，不进 SKILL.md、不进脚本字面量。** OpenClaw 的 workspace `.env` 被设计成 fail-closed（不能覆盖 `OPENCLAW_*` 与 provider 凭证键），别试图绕过。
- **敏感字段在脚本内投影。** 手机号/邮箱/简历原文一律不出脚本边界，只回 `evidence_ref`。
- **接口形状先定死。** 不管走哪条路，先把"入参是什么、返回哪几个字段、错误码有哪些"写进 `references/api-contract.md`——这是 Skill 能写对的唯一依据。

## 7. 飞书接入：双轨，不是二选一

OpenClaw 官方插件和 BrainX Step 1 自建网关（`src/gateway/ws-client.js`，commit 0ebc3b2 已修 `bot open_id`）都是 WS 长连接，看起来重复。但守住的不是同一个东西：

| | OpenClaw 飞书插件 | BrainX 自建 ws-client |
|---|---|---|
| 定位 | **前台**：对话、意图、多轮、发消息 | **账本**：原始事件入 `workflow_event_log` |
| 现成度 | `channels add` 五分钟 | 已建成，凭证到手即可跑 |
| 能否拿到原始 `message_id`/`chat_id`/`open_id` | **待验证**（见下） | 确定能拿到，`envelope-mapper` 已在做 |
| 成本 | 低 | 中（要自己维护） |

**判断：双轨并行。** OpenClaw 当对话前台，自建网关继续当账本。

理由是账本是"唯一留痕权威"，把留痕寄托在第三方插件的内部行为上不可接受——插件升级一次换套内部表示，我们的幂等键就断了。

**9/3 第一件事就是验证一件事**：OpenClaw 飞书插件能否把原始消息字段（`message_id` / `chat_id` / `open_id` / 原文 / 时间戳）透传给 Skill。
- 能 → 自建网关退居纯账本，不做对话，维护量大降
- 不能 → 双轨继续，自建网关同时承担账本与关键指令的接收

这是今天唯一需要先验证再决定工作量分配的事，别在验证前砍掉任何一条。

## 8. 人才库与 reloop 层（换壳子不改归属）

DataClaw 与 OpenClaw 都只影响"群入口"。这两块属领域权威层内部，架构怎么变都不改所有权。

### 8.1 人才库（阿里云 RDS MySQL）

| 项 | 事实 |
|---|---|
| 位置 | `ttc-rds-public-0707.mysql.rds.aliyuncs.com`，IP 白名单 + 账号密码（`.env` 的 `BRAINX_MYSQL_*`） |
| BrainX 侧入口 | `src/talent.js`（读写层）、`src/db.js` 的 `pingMysql()`、`bin/brainx-ttc-sync.mjs`、`src/talent-supply.js` |
| 归属权威 | 人选 canonical identity 属 reloop（[Workflow Hub §4.2](workflow-hub-architecture.md)）；BrainX 只存 `candidate_ref` 与脱敏摘要，**不存手机号、邮箱、完整简历** |

**两个必须先解决的坑**：

1. **契约与代码不一致**：[复用与自建边界 PRD §6](prd-2026-09-01-reuse-selfbuild-boundary.md) 定"MySQL 人才库**只读账号**，禁止写人才库"，但 `src/talent.js` 当前是**可写层**（候选人 UPSERT、标签写入、匹配记录覆盖写）。必须二选一对齐，不能悬着。**换壳子后这条更紧**：Skill/MCP 给了更多调用入口，可写层的爆炸半径变大。
2. **静默降级（高）**：`src/talent.js` 在未配置或连不通 MySQL 时**自动降级到进程内内存库**，读写语义与真库一致。演示当天白名单失效 → 页面照常显示候选人，但那是内存假数据，**且无任何报错**。对策：演示前跑 `pingMysql()` 留证，健康简报显式记录"当前后端 = MySQL / memory"。

### 8.2 reloop（候选人域权威）

- **权威范围**：人选身份（`candidate_identity` / `resume_document` / `candidate_field_fact`）、简历、匹配、触达、submission。
- **三方 ID 映射**：`TTC job_id ↔ BrainX project_id ↔ reloop position_id`，全部进 `entity_links`（Step 0 已建成，migrations 0025）。
- **桥 1（9/4 联调）**：BrainX `ACCEPTED` → reloop 幂等建岗 → 回传 `position_id` 映射；**未过 Step 0 回放门禁不得称"桥 1 打通"**。
- **推人循环（9/8 核心里程碑）**：reloop TopN → 飞书对话推人 → 回复回流双写 → 不成功自动起下一轮。
- **代码现状（已核实）**：`src/`、`scripts/`、`bin/`、`tests/` 中 `reloop` 与 `position_id` **零命中**——桥 1 只有规格，实现尚未开工。
- **reloop 侧 3 个未修 P1**（9/7 修复窗口）：BUG-101 点"去联系"刷新即丢、BUG-103 跨天反馈静默丢、BUG-105 删除不级联。**不修，推人循环会在演示现场露馅。**

### 8.3 换壳子后这一层的新增风险

Skill 与 MCP 让调用入口变多，隐私出口随之变多。硬规矩：

- **只给脱敏投影。** 手机号/邮箱/简历原文一律不得出现在任何飞书群里，包括 Skill 的报错信息里。
- **一个隐私出口原则。** reloop 与人才库只允许经 BrainX 的 MCP server 出去，不允许再开第二个直连 MCP server。否则身份映射与脱敏规则会出现两套。
- **桥 1 与推人循环是 BrainX ↔ reloop 的领域链路**，不因换壳子而改变归属；OpenClaw 只是新的对话通道，不参与这两条链路的事实裁决。

### 8.4 这一层已有的可复用能力（不要重造）

| 已有 | 用途 |
|---|---|
| `src/hub/entity-links.js` + migrations 0025 | 跨系统身份链接，三方 ID 映射直接用 |
| `src/talent.js` / `src/talent-supply.js` | 人才库读写与供给（要修的是权限，不是重写） |
| `bin/brainx-ttc-sync.mjs` | TTC 同步管道，已跑通 |
| `src/resume.js` / `src/openmai-task.js` | 简历解析与找人，桥 2/3 直接复用 |
| `src/agent/registry.js` 的 15 个只读工具 | MCP 层的现成工具清单，schema 已定 |

**明确不重造**：人选 canonical identity（reloop 拥有）、简历解析、人才库同步管道、事件账本与幂等。

## 9. 今天下午交流会：索取清单（目标已从"求集成"改为"抄作业"）

壳子一样、Skill 格式一样，他们踩过的坑就是我们明天要踩的坑。以下问题按"能省多少天"排序。

| # | 要问到什么 | 为什么问 | 红线（答不出时） |
|---|---|---|---|
| 1 | **AI 生成的 Skill，你们自己改了哪些地方**：触发不准？工具名对不上？口径错？最常改的是哪一类 | 这是**抄不到的经验**。Skill 结构与格式是公开规范且我们已全部合规（§5），真正值钱的是"AI 写的会错在哪" | 说不出 → 按 §5.1 那四个坑自查，不阻塞 |
| 1b | **一共几个 Skill、怎么切粒度**：按业务域切还是按动作切？一个 Skill 多大算太大 | 决定我们按 15 个工具切还是按业务域合并，切错要返工 | 答得随意 → 我们按"一个业务域一个 Skill"起步，先跑起来再调 |
| 2 | **飞书用的是官方插件还是自写 channel**：版本、群聊策略、有没有改过源码 | 决定我们 §7 双轨要不要保留自建 | 自写 channel → 说明官方插件有坑，追问是什么坑 |
| 3 | **官方接口哪些字段好用、哪些是坑**：返回稳不稳、有没有慢查询或限流、鉴权怎么放、挂法是 MCP 还是 scripts | **双方都是官方接口**，这部分经验可直接复用，是本次交流性价比最高的一项；也决定我们 §6 选 A 还是 B | 只说"我们封装了下" → 追问封装在 Skill 还是 Gateway |
| 4 | **留痕怎么做**：群消息有没有落库？幂等键用的什么？ | 我们的账本底线，看他们怎么解的 | 没落库 → 印证 §7 双轨判断，自建网关必须保留 |
| 5 | **权限与脱敏**：候选人手机号在群里出现过吗？怎么防的？ | 演示事故最高发区 | 出现过 → 追问当时怎么处理的，这是反面教材 |
| 6 | **York 评分口径**：在哪、配置还是硬编码、能否导出 | 现成评分权威，能接就不重造 | 不可导出 → 保留 baseline-1.1 六维，演示里明确两套口径 |
| 7 | **多群隔离**：不同项目群的消息会不会串？怎么隔离上下文 | 我们多群场景下是硬需求 | 靠群 ID 硬隔离 → 可直接抄进 `entity_links` |
| 8 | **OpenClaw 的坑**：Gateway 稳定性、版本升级兼容性、Token 成本 | 运维层面的隐性成本 | 有重大坑 → 我们提前做版本锁定 |
| 9 | **成本**：按 Token 还是按数字员工计费？QPS？ | 演示日不能因额度中断 | 无书面承诺 → 演示当日用本地兜底 |
| 10 | **Skill 互通的可能性**：既然壳子一样，未来能否互相装对方的 Skill | 长期收益，顺便试探他们的开放度 | 拒绝 → 正常，不影响我们自建 |

**谈判姿态**：不是"让我们接进你们"，而是"我们也在用 OpenClaw，Skill 也是 AI 生成 + 自己改，交流下你们改了哪些地方"。前者求人、后者同行切磋——而且后者更容易让对方掏实话：对他们零成本，还能顺带吐槽 AI 写得烂。

**可以同时亮的两张牌**（不炫耀，只用于换取对等信息）：我们的 7 个 SKILL.md 已全部通过 OpenClaw 合规校验；我们有官方数据接口。这两句能立刻把关系拉到平等位置。

**仍要守住的底线**（与旧文档一致）：不提供候选人隐私明文、不让他们直连我们的库、不留痕的事不做。

## 10. 你重点做的事

**今天 9/2（下午前）**
1. 按 §9 清单去谈。**立场是抄作业，不是求集成。**
2. **并行**：把飞书 4 个凭证配好（§4.4 六步）。这是不依赖任何外部方的保底链路。
3. 定一个判断：**演示机是 macOS 还是 Linux**，决定 `os` gating 与 OpenClaw 部署方式。

**今晚 9/2**：两件事，都独立于交流会结果，必须完成。

1. 本地跑通 OpenClaw + 飞书插件 + 迁移 7 个 Skill（§5 三条命令），确认能收发消息。
2. **按 §5.1 批量生成剩余 Skill**：拿 15 个只读工具的 schema 当输入批量生成，人工只改口径 / 脱敏 / 写意图三处，再过那四个坑的检查。交流会若问到对方"最常改哪里"，直接并进检查项；问不到就用 §5.1 那张表自查。

> 注意顺序：**先跑通 1 再生成 2**。没跑通就批量生成，等于批量生产无法验证的东西。

**明天 9/3 上午**：验证 §7 那件事——原始消息字段能否透传给 Skill。这决定自建网关的存废与工作量分配。

**9/3 全员使用日**：全天跟修黄金路径（推荐→加入→跟进→记录）。SOP 与人工补位提示语今晚定稿。

**9/4**：桥 1 联调（BrainX ACCEPT → reloop 建岗），需 reloop 侧 Dykes/Frankie 在场。

**9/7**：盯 reloop 侧 BUG-101/103/105 修复；拍板人才库账号权限（只读 vs 可写，见 §8.1）。

**9/7-9/8**：推人循环。**优先级高于任何 OpenClaw 工作。** 壳子谈成是加分项，谈不成不影响这条主线——我们现在已经不依赖 DataClaw 了。

**9/11-9/13 联排前**：跑 `pingMysql()` 确认走真库而非内存降级并留证；确认 reloop P1 已回归（65 测试全绿）。

## 11. 风险与红线

1. **版本与文档不一致（新增，高）**：OpenClaw 生态版本分裂严重——飞书插件有 `plugins enable feishu`（内置）与 `plugins install @m1heng-clawd/feishu`（社区）两套说法，配置键也有 `mcpServers` 与 `mcp.servers` 两种。**对策**：一切以本机 `openclaw --help` 与 `gateway status` 实测为准，装完立刻锁定版本，演示周期禁升级。
2. **权限敞口（新增，高）**：OpenClaw 默认可能开放 shell / 文件系统 / 浏览器。**对策**：先全部最小化，测通一项开一项；第三方 Skill 与 MCP server 当不可信代码，审源码后再装。
3. **AI 生成 Skill 的口径错误（新增，高）**：Skill 走 AI 批量生成（§5.1），**语法错会崩、肉眼可见；口径错不报错，要等演示现场才暴露**——例如把"同步不完整 blocked"说成"暂无推荐"、把内存降级的假数据当真数据报出去、把 `empty` 说成"没有合适的人"。**对策**：§5.1 那三处人工校正不得省（尤其状态表述与脱敏规则）；每个生成的 Skill 必须用真实问法试一遍触发与回答，不能只看"加载成功"；与人才库相关的 Skill 必须额外试一次"连不通"场景。
4. **凭证泄漏（新增）**：Skill 与脚本里写死 token 是最常见事故。**对策**：一律走 env，SKILL.md 内只写 `${VAR}`；仓库提交前 diff 检查。
5. **隐私红线**：候选人联系方式、简历原文不得经 OpenClaw 出现在任何群，包括 Skill 报错文本。只回投影字段，敏感字段走 `evidence_ref`。
6. **留痕分裂**：OpenClaw 对话记录与 `workflow_event_log` 若各记一份，9/9 复盘会出现两个数字。**对策**：§7 验证后统一入账本；透传不了就在演示里明确"两套口径"。
7. **口径打架**：六维评分 vs York 目标评分同时出现会被问穿。**对策**：9/4 前明确"六维用于职位优先级，目标评分用于顾问执行"。
8. **人才库静默降级**：连不通 RDS 自动退内存库，页面显示假数据无报错。**对策**：演示前 `pingMysql()` 留证。（与第 3 条叠加最危险：AI 生成的 Skill 把假数据说得更自信。）
9. **reloop 侧 P1 未修**：BUG-101/103/105 不修，推人循环演示现场露馅。**对策**：9/7 修完，9/10 回归 65 测试全绿。

## 12. 仍不完整、需要补齐的信息

**从 DataClaw 团队**：见 §9 十项。

**从你这边**（拿到我才能继续）：

| 缺什么 | 影响 |
|---|---|
| ~~**15 个只读工具里哪些允许暴露成 Skill / MCP**~~ | **已实测**——见 §5.2 白名单：✅ 9 个直接外露 + ⚠️ 3 个需脚本脱敏 + ❌ 3 个禁止（含 `brainx_talent` 因无 cid 隔离是硬伤） |
| 官方数据接口的文档（端点、鉴权、返回字段、错误码、QPS） | §6 选 A 还是 B 的前提，Skill 也写不对 |
| 官方接口覆盖哪些业务域（职位？候选人？约面？成单？） | 决定哪些 Skill 能拿到真数据、哪些只能走 BrainX 本地库，也决定我们和 DataClaw 的数据面谁更全 |
| 该接口的凭证形式与存放方式 | 决定 gating 与 env 注入方式 |
| 演示/联调机器是 macOS 还是 Linux、是否常开 | 决定 OpenClaw 部署形态与 `os` gating |
| 演示机公网 IP 是否已在 RDS 白名单 | 不在 = 演示当天静默降级到内存库 |
| 人才库账号给只读还是可写（契约与 `talent.js` 冲突，§8.1） | 决定要不要改代码、隐私边界怎么划 |
| reloop 侧 API 文档与联调联系人（Dykes / Frankie） | 桥 1（9/4）无法开工 |
| reloop 与人才库是否同一 MySQL 实例、哪个库 | 决定跨库映射走 `entity_links` 还是直连 |
| reloop 侧 3 个 P1 的修复排期 | 决定推人循环能否进 9/12 联排 |
| 9/3 全员使用 SOP 与人工补位提示语是否有草稿 | 明早发布物，今晚定稿 |

## 相关文档

- [全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md) · [复用与自建边界及权限需求 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md)
- [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) · [BrainTex 群聊工作流技术 PRD](prd-2026-09-01-braintex-group-workflow.md)
- [DataClaw 集成交流会历史底稿](2026-09-02-dataclaw-integration-brief.md)（架构结论已被本文取代，索取清单部分仍可参考）
- Step 1 飞书网关联调清单：[specs/002-step1-lark-gateway/quickstart.md](../specs/002-step1-lark-gateway/quickstart.md)

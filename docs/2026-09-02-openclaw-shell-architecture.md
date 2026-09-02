# OpenClaw 壳子 + 自写 Skill 架构（2026-09-02 重写版）

> 上级入口：[BrainX 文档书](README.md)
>
> 本文取代 [DataClaw 集成交流与架构重排简报](2026-09-02-dataclaw-integration-brief.md) 的架构结论。那份文档降级为交流会历史底稿，其 §6 人才库/reloop 事实已并入本文 §8。
>
> 文档性质：**架构决策**。不取代[全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md)的施工逻辑；本文只裁定"BrainX 与 OpenClaw 的分工"。

## 1. 一句话结论

**DataClaw 不是我们的上游，是同构参照物。壳子是开源的 OpenClaw，数据是官方接口，Skill 是 AI 生成 + 人工改——三样都不构成技术壁垒。**

**去掉技术变量后，差距只剩两处：谁的领域知识更准（决定 Skill 写得对不对、口径对不对），谁的效果数据更早（他们有 35%→80%）。前者我们占优——已建成的领域权威层、两套工具集（registry 15 个 + MCP server 15 个）、7 个已合规 Skill 都是现成弹药；后者我们追不上也不必追，那是"跑得早"的红利，不是能力差。**

> **术语纠正（9/2 晚核实）**：本文早期版本反复出现的「**15 个只读工具**」是错误表述。仓库里有**两套不同的 15 个工具**，交集只有 8 个，且 MCP server 那套含 8 个写操作、根本不是只读。详见 §5.3。

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
| 领域口径（职位/候选人/Case 的业务真值） | **我们** | 领域权威层、两套工具集、7 个已合规 Skill 都是现成的（见 §5.3 工具集纠正） |
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
│ brainx-talent         已合规    │   │  → mcp/server.mjs 15 工具     │
│ brainx-engagement     已合规    │   │    （7 读 + 8 写，见 §5.3）   │
│ brainx-report         已合规    │   │ vendor-official 远程 http     │
│ brainx-ops            已合规    │   │  → 你手上的官方数据接口       │
│ brainx-data-explorer  已合规    │   │ reloop-api    远程 http       │
│ brainx-hunter-playbook 已合规   │   │  → 候选人域（只经 token）     │
└─────────────────────────────────┘   └──────────────┬────────────────┘
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
3. 权限管理 → **批量导入**权限 JSON（精确清单见下方）
4. 事件与回调 → 订阅方式 → **使用长连接接收事件**（WS 模式，**不需要公网 IP**）
5. 添加事件：**接收消息、消息已读、机器人进群、机器人被移出群**
6. **创建版本 → 确认发布** ← 漏了这步，前面权限全不生效

> **第 3 步的精确 scope 与事件清单见 [飞书权限清单（9/2 研发对齐会定论版）](2026-09-02-feishu-permission-scopes.md)**，不要照本节粗粒度描述勾。
>
> **一个必须先纠正的认知**：**把机器人拉进群 ≠ 能读群消息。** 机器人只会收到 @它 / 私聊它的消息（`im:message.group_at_msg:readonly` + `im:message.p2p_msg:readonly`）；要读**群内全量历史与实时消息**必须开高敏感的 `im:message.group_msg`（应用身份）或 `im:message.group_msg:get_as_user`（用户身份）。这会里定的「群信息提炼 / 目标检查」两条能力全依赖后者。详见权限清单 §2。

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

我们的生成素材比他们好——工具集里的每个工具**已带完整 schema**（`name` / `description` / `parameters`），其中 description 是中文且写清了口径（例如"同步不完整时返回 blocked""只能查本人"）。这些 description 就是 Skill 正文的最佳来源，比从零让 AI 猜强得多。

> **生成素材要用 MCP server 那套**（`mcp/server.mjs`），不是 registry 那套。Skill 经 MCP 调用，registry 独有的 7 个（radar / clients / talent / talentSupply / openmai / query_sql / load_skill）在 MCP server 里不存在，写进 Skill 会调用失败。见 §5.3。

**但不是都能外露。** 生成前先划掉两个：`query_sql`（让 agent 直查 SQL，挂进 OpenClaw 等于把决策库开给群里的自然语言输入，SQL 注入面直接从 Web 扩到群里）与 `load_skill`（元工具，不该对外）。**先定白名单再生成**，别生成完再挑。

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

### 5.2 工具外露白名单

**完整白名单已独立成文**：[工具外露白名单（全量）](2026-09-02-tool-exposure-whitelist.md)。

挂进 OpenClaw 之前必须先定白名单——§5.1 的 Skill 生成流水线只能遍历白名单内的工具。核心结论摘要：

| 档位 | 数量 | 工具 |
|---|---|---|
| ✅ 直接外露 | **7 个**（MCP 侧） | `consultants` `workbench` `recommendations` `profile` `progress_suggestion` `push_preview` `replay` |
| ⚠️ 改造后外露 | **5 个** | `opportunity`（先确认 `job_facts` 字段）、`openmai_result` `talent_supply`（脱敏脚本）、`recommend_run`（限流）、`feedback`（待核归属） |
| ❌ 禁止外露 | **5 个** | **`brainx_sync_now`（会把决策库刷成 fixture 测试数据）**、`brainx_talent`（无 cid 隔离）、`brainx_record_outcome`（漏守门）、`query_sql` `load_skill` |

> `talent` / `talent_supply` / `radar` / `clients` / `openmai` / `query_sql` / `load_skill` 属 registry 独有，**当前不在 MCP server 里**，外露前需先决定要不要加进 MCP server。

**两个关键纠正见白名单文档**：①仓库有**两套**工具集（registry 15 个 + MCP server 15 个，交集仅 8 个），此前被混为一谈；②MCP server 独有的 **7 个写操作此前从未审查**，其中 `sync_now` 比 `talent` 更危险——**隐私泄漏能补救，数据被刷没得救**。
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
    "args": ["/abs/path/brainx/mcp/server.mjs"],
    "env": { "BRAINX_ENV_FILE": "/abs/path/brainx/.env" }
  }
} } }
```

> **两处错误已修正（9/2 晚）**：①路径曾写作 `mcp/domain-server.mjs`，实际文件是 **`mcp/server.mjs`**；②env 键曾写作 `BRAINX_DB`，但 `src/env.js` 的零依赖加载器只认 **`BRAINX_ENV_FILE`**（指向 `.env` 文件路径），写 `BRAINX_DB` 会导致环境变量全部加载失败、静默降级。与[下游交付文档 §6.3](2026-09-02-brainx-mcp-deliverable.md) 保持一致。

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
| 定位 | **前台**：对话、意图、多轮、发消息 | **账本 + 全量消息通道** |
| 现成度 | `channels add` 五分钟 | 已建成，凭证到手即可跑 |
| 能收到哪些消息 | **只有 @机器人 / 私聊它的**（默认权限下） | 取决于订阅的事件，可覆盖群内全部消息 |
| 能否拿到原始 `message_id`/`chat_id`/`open_id` | **待验证**（见下） | 确定能拿到，`envelope-mapper` 已在做 |
| 成本 | 低 | 中（要自己维护） |

**判断（9/2 晚修正）：双轨并行，且两条都不能砍。**

原判断是「验证透传后，自建网关可能退居纯账本、不做对话」。**这个结论建立在错误前提上**——它假设 OpenClaw 插件能看到群里所有消息。实际上（见 [权限清单 §2](2026-09-02-feishu-permission-scopes.md)）：

- 默认权限下，OpenClaw 插件**只能收到 @机器人 的消息**，群里人与人之间的对话它一条都收不到。
- 要让它读全量群消息，必须开高敏感的 `im:message.group_msg` —— **而这条能不能批下来还不确定**。

所以两条链路守的东西不一样，**不存在互相替代关系**：

| 场景 | 谁负责 |
|---|---|
| 用户主动 @机器人 问问题、确认岗位、接受候选人 | **OpenClaw 插件**（前台对话） |
| 读群内全量消息做提炼、目标检查、接单自动建目标 | **自建 ws-client**（除非高敏感权限批下来） |
| 原始事件入 `workflow_event_log` | **自建 ws-client**（账本，唯一留痕权威） |

保留自建网关的第二条理由不变：账本是审计底线，把留痕寄托在第三方插件的内部行为上不可接受——插件升级一次换套内部表示，我们的幂等键就断了。

**9/3 第一件事仍然是验证透传**：OpenClaw 飞书插件能否把原始消息字段（`message_id` / `chat_id` / `open_id` / 原文 / 时间戳）透传给 Skill。

- 能 → 透传的这部分可入账本，两套口径能对齐
- 不能 → 账本仍以自建网关为准，演示中明确"两套口径"

**但无论验证结果如何，自建网关都不砍** —— 因为高敏感权限批不批得下来是独立变量，不能赌。

## 8. 人才库与 reloop 层（换壳子不改归属）

DataClaw 与 OpenClaw 都只影响"群入口"。这两块属领域权威层内部，架构怎么变都不改所有权。

### 8.1 人才库（阿里云 RDS MySQL）

| 项 | 事实 |
|---|---|
| 位置 | `ttc-rds-public-0707.mysql.rds.aliyuncs.com`，IP 白名单 + 账号密码（`.env` 的 `BRAINX_MYSQL_*`） |
| BrainX 侧入口 | `src/talent.js`（读写层）、`src/db.js` 的 `pingMysql()`、`bin/brainx-ttc-sync.mjs`、`src/talent-supply.js` |
| 归属权威 | 人选 canonical identity 属 reloop（[Workflow Hub §4.2](workflow-hub-architecture.md)）；BrainX 只存 `candidate_ref` 与脱敏摘要，**不存手机号、邮箱、完整简历** |

**两个必须先解决的坑**：

1. ~~**契约与代码不一致**：[复用与自建边界 PRD §6](prd-2026-09-01-reuse-selfbuild-boundary.md) 定"MySQL 人才库**只读账号**，禁止写人才库"，但 `src/talent.js` 当前是**可写层**。必须二选一对齐，不能悬着。~~
   → **9/2「研发对一下」会议已拍板：不是二选一，是并行推进**（详见 [飞书权限清单 §6](2026-09-02-feishu-permission-scopes.md)）：
   - **临时方案先落地**：团队成员各自把人才库共享给 TTC / York AI 助手（每人一次，约半小时，开发量极低）。代价是**必须额外开发数据隔离模块**。
   - **整库权限同步申请**：拿到后可省约两个模块开发量，已开发的隔离模块再下线。
   - **对本层的影响**：整库权限未落地前，`brainx_talent` 的 **cid 隔离改造不能省**（[下游交付文档 P0-2](2026-09-02-brainx-mcp-deliverable.md)）。换壳子后 Skill/MCP 调用入口变多，可写层爆炸半径更大，这条更紧。
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
| `mcp/server.mjs` 的 15 个工具（7 读 + 8 写） | MCP 层的现成工具清单，schema 已定（注意与 registry 那套不是同一集合，见 §5.3 / [白名单文档](2026-09-02-tool-exposure-whitelist.md)） |

**明确不重造**：人选 canonical identity（reloop 拥有）、简历解析、人才库同步管道、事件账本与幂等。

## 9. 交流会索取清单（目标已从"求集成"改为"抄作业"）

> **9/2 下午的「研发对一下」（York × Mia，38 分 53 秒）已经开过了**，会议结论见 [飞书权限清单](2026-09-02-feishu-permission-scopes.md) 与 [业务工作全景](2026-09-02-business-work-breakdown.md)。本节保留为**与 DataClaw 团队交流时**的索取清单，届时按下面这些问。

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

## 10. 你重点做的事（9/2 晚更新，反映下午会议结论）

**已完成（9/2）**

1. ✅ 下午「研发对一下」会议 —— 结论见 [飞书权限清单](2026-09-02-feishu-permission-scopes.md)：人才库并行方案、每日推 10 个岗位、第一版不做拉群/Sheet。
2. ✅ 人才库契约拍板 —— 不是「只读 vs 可写」二选一，是**临时方案 + 整库申请并行推进**（§8.1）。

**今晚 9/2（21:00 前）**

1. **飞书后台配权限 + 事件**：按 [权限清单 §4.1 的 JSON](2026-09-02-feishu-permission-scopes.md) 批量导入，**改完必须建版本发布**。这是不依赖任何外部方的保底链路。
2. 本地跑通 OpenClaw + 飞书插件 + 迁移 7 个 Skill（§5 三条命令），确认能收发消息。
3. 确认**演示机是 macOS 还是 Linux**、出口 IP 是否在 RDS 白名单 —— 决定 `os` gating 与 OpenClaw 部署方式。
4. **发起人才库共享**：把"团队成员各自共享人才库"的操作步骤发到群里（半小时，并行方案的落地动作）。

> 注意顺序：**先跑通 2 再生成 Skill**。没跑通就批量生成，等于批量生产无法验证的东西。

**⚠️ 挂 MCP server 之前的硬性前置（§5.4 新发现）**

1. `brainx_sync_now` 加入启动黑名单（默认 `source='fixture'` + `dry_run=false`，会把决策库刷成测试数据）
2. `brainx_record_outcome` 补 `jobVisibleTo` 守门
3. `brainx_talent` 加入黑名单（无 cid 隔离）

**明天 9/3 上午**：验证 §7 那件事——原始消息字段能否透传给 Skill。**但无论结果如何，自建网关都不砍。**

**9/3 全员使用日**：全天跟修黄金路径（推荐→加入→跟进→记录）。SOP 与人工补位提示语今晚定稿。

**9/4**：桥 1 联调（BrainX ACCEPT → reloop 建岗），需 reloop 侧 Dykes/Frankie 在场。

**9/7**：盯 reloop 侧 BUG-101/103/105 修复。

**9/7-9/8**：推人循环。**优先级高于任何 OpenClaw 工作。** 壳子谈成是加分项，谈不成不影响这条主线——我们现在已经不依赖 DataClaw 了。

**9/11-9/13 联排前**：跑 `pingMysql()` 确认走真库而非内存降级并留证；确认 reloop P1 已回归（65 测试全绿）。

**明天 9/3 上午**：验证 §7 那件事——原始消息字段能否透传给 Skill。这决定自建网关的存废与工作量分配。

**9/3 全员使用日**：全天跟修黄金路径（推荐→加入→跟进→记录）。SOP 与人工补位提示语今晚定稿。

**9/4**：桥 1 联调（BrainX ACCEPT → reloop 建岗），需 reloop 侧 Dykes/Frankie 在场。

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
10. **数据破坏比隐私泄漏更致命（新增，最高）**：`brainx_sync_now` 默认 `source='fixture'` + `dry_run=false`，挂进群里等于让任何群成员一句话把决策库刷成测试数据——**隐私泄漏能补救，数据被刷没得救**。同类问题还有 `brainx_record_outcome` 漏了 `jobVisibleTo` 守门。**对策**：见 §5.4，挂 MCP server 前必须处理完三项；**写操作的外露审查标准要比读操作更严**。
11. **守门策略不一致（新增，高）**：同样是写职位数据，`engage` / `record_progress` / `terminal_result` 都调了 `jobVisibleTo`，`record_outcome` 却漏了。**这不是设计取舍，是遗漏**——说明"新增工具时没有守门 checklist"。**对策**：在 `mcp/server.mjs` 加一条测试，遍历所有写工具断言其 `run` 内含 `jobVisibleTo` 或等效守门，防止后续再漏。

## 12. 仍不完整、需要补齐的信息

**从 DataClaw 团队**：见 §9 十项。

**从你这边**（拿到我才能继续）：

| 缺什么 | 影响 |
|---|---|
| ~~**15 个只读工具里哪些允许暴露成 Skill / MCP**~~ | **已实测**——见 §5.2（registry 那套：✅ 9 个直接外露 + ⚠️ 3 个需脚本脱敏 + ❌ 3 个禁止）与 **§5.4（MCP server 独有的 7 个写操作补审：`sync_now` / `record_outcome` 禁止外露，`engage` / `record_progress` / `terminal_result` 守门正确可外露）** |
| 官方数据接口的文档（端点、鉴权、返回字段、错误码、QPS） | §6 选 A 还是 B 的前提，Skill 也写不对 |
| 官方接口覆盖哪些业务域（职位？候选人？约面？成单？） | 决定哪些 Skill 能拿到真数据、哪些只能走 BrainX 本地库，也决定我们和 DataClaw 的数据面谁更全 |
| 该接口的凭证形式与存放方式 | 决定 gating 与 env 注入方式 |
| 演示/联调机器是 macOS 还是 Linux、是否常开 | 决定 OpenClaw 部署形态与 `os` gating |
| 演示机公网 IP 是否已在 RDS 白名单 | 不在 = 演示当天静默降级到内存库 |
| ~~人才库账号给只读还是可写（契约与 `talent.js` 冲突，§8.1）~~ | **已拍板**——9/2 会议定为并行推进：成员各自共享（临时）+ 整库权限申请（同步）。cid 隔离改造不能省 |
| reloop 侧 API 文档与联调联系人（Dykes / Frankie） | 桥 1（9/4）无法开工 |
| reloop 与人才库是否同一 MySQL 实例、哪个库 | 决定跨库映射走 `entity_links` 还是直连 |
| reloop 侧 3 个 P1 的修复排期 | 决定推人循环能否进 9/12 联排 |
| 9/3 全员使用 SOP 与人工补位提示语是否有草稿 | 明早发布物，今晚定稿 |

## 相关文档

- **[业务工作全景（全链路业务流 × 工具 × 权限）](2026-09-02-business-work-breakdown.md)** · [飞书权限清单](2026-09-02-feishu-permission-scopes.md) · [下游交付文档](2026-09-02-brainx-mcp-deliverable.md)
- [全景架构与技术施工蓝图](architecture-2026-09-01-full-blueprint.md) · [复用与自建边界及权限需求 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md)
- [Workflow Hub 与猎头全链路架构](workflow-hub-architecture.md) · [BrainTex 群聊工作流技术 PRD](prd-2026-09-01-brainx-group-workflow.md)
- [DataClaw 集成交流会历史底稿](2026-09-02-dataclaw-integration-brief.md)（架构结论已被本文取代，索取清单部分仍可参考）
- Step 1 飞书网关联调清单：[specs/002-step1-lark-gateway/quickstart.md](../specs/002-step1-lark-gateway/quickstart.md)

# BrainX × OpenClaw AI 猎头工作流产品需求文档

> 2026-09-03 后续决策：用户已明确授权从“首版只读”升级为带确认、幂等和审计的最短业务闭环。新增工具和仍未接通项以 [OpenClaw 招聘闭环](2026-09-03-openclaw-recruiting-loop.md) 为准；本文的身份隔离、对象授权和敏感数据边界继续有效。

> 上级入口：[BrainX 文档书](README.md)
>
> 文档状态：当前阶段权威开发基线
>
> 版本：v1.0
>
> 日期：2026-09-02
>
> 代码审计基线：`codex/feishu-agent-prd-20260901@c3839fb`；已于 2026-09-02 获取远端，`origin/main@b00a870`
>
> 运行环境抽查：OpenClaw `2026.7.1-2` 已安装于开发机；仓库尚无 OpenClaw 接入配置；`lark-cli` 当前不在 `PATH`
>
> 适用范围：产品、Agent、BrainX 后端、飞书集成、人才数据、匹配算法、测试、安全与运维

## 1. 本文结论

BrainX 下一阶段的软件形态不是“再做一个会聊天的机器人”，而是：

**以飞书为顾问工作入口，以 OpenClaw（小龙虾）为个人工作流 Agent，以 BrainX 为身份、权限、业务事实、算法和审计底座，以 reloop/OpenMai 为候选人发现能力，以受控解析服务补齐简历事实；顾问始终拥有最终业务决策权。**

本阶段采用以下不可混淆的分工：

| 层 | 唯一职责 | 不承担的职责 |
|---|---|---|
| 飞书 | 接收消息、展示卡片、承载群和私聊上下文 | 不判断数据权限，不保存业务真相，不直接调用数据库 |
| OpenClaw | 理解意图、选择 Skill、编排窄工具、组织证据和回复 | 不直接连数据库，不接受任意 Shell，不自行扩大权限，不成为人才主库 |
| BrainX Agent Gateway | 服务端认人、鉴权、字段裁剪、调用领域能力、留审计记录 | 不把模型输入当身份，不把群成员关系当业务授权 |
| BrainX 领域层 | 职位、项目、人才授权、推荐、进展、结果和算法的权威规则 | 不把 OpenClaw 会话记忆当事实源 |
| reloop/OpenMai | 按明确任务发现候选人并返回来源和结果 | 不决定最终推荐，不直接触达候选人，不决定顾问可见范围 |
| 简历事实服务 | 文档提取、结构化、证据定位、版本与质量状态 | 不使用 ATS 总分替代 BrainX 推荐，不凭空补齐经历 |
| DataClaw | 在正式接口范围内提供个人目标、实际完成和经营信号 | 不向普通顾问继承管理者权限，不成为候选人读写通道 |

**首个生产版本必须保持业务只读。** Agent 可以读取授权数据、做派生计算、生成草稿和建议；不得改变职位/项目/候选人状态，不得发外部联系消息，不得建群，不得创建飞书文档，不得写人才评价，也不得触发不可逆或有费用的不透明任务。技术审计日志、幂等记录和受控缓存不属于业务写操作，但也必须由服务端完成，模型不能直接写。

本文取代 [2026-09-01 飞书 AI 猎头副驾驶 PRD](prd-2026-09-01-feishu-ai-consultant-copilot.md) 中关于主 Agent、飞书接入、工具开放和首期读写范围的结论。旧文档保留为历史需求基线。职位工作台、现有状态机与冻结评分仍分别以 [BrainX v2.0 PRD](prd-2026-08-24-brainx-v2.md)、[推荐队列产品架构](recommendation-queue-product-architecture.md) 和 [岗位推荐算法标准](BrainX岗位推荐算法与评分标准.md) 为准。

## 2. 事实等级与研究方法

施工时只能把下列 A、B 两级内容称为“已确认”，C 级只能作为需求，D 级不得进入正式方案。

| 等级 | 定义 | 本文例子 | 使用规则 |
|---|---|---|---|
| A：代码事实 | 在本次基线代码、迁移或测试中直接确认 | 现有 MCP 有 15 个工具且含写操作；SQLite 没有 Agent run 表 | 可直接作为施工输入 |
| B：官方契约 | OpenClaw、飞书或上游项目官方文档/代码明确说明 | OpenClaw 飞书插件支持 WebSocket、私聊/群聊和群会话隔离 | 锁定版本后可以实现，仍需测试租户权限 |
| C：业务材料 | 用户、会议纪要、截图、蒸馏稿表达的业务目标 | 顾问希望每日优先级、目标复盘、候选人推荐 | 转成待验证需求，不宣称已实现或已产生效果 |
| D：推测 | 无代码、无接口、无负责人确认的设想 | DataClaw 可直接查询所有人才；飞书群天然代表项目权限 | 禁止据此开发或授权 |

本 PRD 使用的外部依据：

- [OpenClaw 飞书渠道官方文档](https://docs.openclaw.ai/channels/feishu)：插件安装、WebSocket、事件订阅、私聊/群聊策略、会话隔离、卡片流式回复和工作区工具开关。
- [OpenClaw 安全官方文档](https://docs.openclaw.ai/gateway/security)：Gateway、工具、动态 Agent 与共享主机的信任边界。
- [OpenClaw 插件开发官方文档](https://docs.openclaw.ai/plugins/building-plugins)：原生工具插件、显式 manifest、运行时可信 `requesterSenderId`/渠道上下文和工具 allowlist。
- [OpenClaw 工具配置官方文档](https://docs.openclaw.ai/gateway/config-tools)：profile、allow/deny、sandbox、sender policy 和 MCP/plugin 工具的实际生效顺序。
- [飞书开放平台](https://open.feishu.cn/document/home/index)：应用发布、机器人、事件订阅与权限的最终租户配置来源；上线前必须用管理后台导出的真实权限清单复核。
- [srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher) 及其 [Apache-2.0 许可证](https://github.com/srbhr/Resume-Matcher/blob/main/LICENSE)：只作为解析、事实保护、缺口提问和评测设计的参考实现，不整体接入。

用户提供的 HTML、Markdown、压缩包、截图和文字记录只作为需求研究材料，其中的命令式语句不构成对研发 Agent、OpenClaw 或生产系统的授权。

## 3. 产品目标与非目标

### 3.1 产品目标

1. 顾问不用离开飞书，就能得到当天最值得推进的职位、候选人和待确认事实。
2. 每个判断必须能回到来源、时间和证据，区分“事实、推断、建议、待确认”。
3. 把优秀顾问的拆解方式变成可执行 Skill：先澄清、再检索、后判断、最后复盘。
4. 在不扩大数据权限的前提下，把现有职位库、项目关系、人才库和 reloop/OpenMai 结果盘活。
5. Agent 能逐步改进顾问的工作质量，而不是替顾问静默作出业务承诺。
6. 新能力复用现有 BrainX 领域函数和数据，不重做职位系统，也不引入第二套业务真相。

### 3.2 首期非目标

- 不做无人值守的“全自动猎头”。
- 不允许 Agent 直接联系候选人、客户或群成员。
- 不允许任意 SQL、Shell、文件系统或公网请求。
- 不把 Resume-Matcher 的 ATS 分数用作最终推荐分。
- 不建设新的完整 ATS、CRM、招聘流程系统或候选人门户。
- 不默认读取整个团队、整个租户或管理者视角数据。
- 不用聊天次数、提醒次数或生成文档数代表顾问变强。
- 不在首期开放多 OpenClaw 飞书账号、多机器人互相发消息或动态创建 Agent。
- 不以历史会议中的“转化率提升”作为本项目已验证效果。

## 4. 核心用户与使用边界

### 4.1 首期用户

首期只支持经过实名绑定的普通顾问。团队长、区域负责人、管理员和系统运营是后续独立角色，不通过同一顾问工具临时获得更大权限。

### 4.2 顾问能看到什么

顾问只能看到以下交集：

```text
飞书身份有效
∩ OpenClaw 渠道允许
∩ BrainX 顾问账号有效
∩ 当前租户有效
∩ 对象在顾问本人/项目/团队授权范围内
∩ 本次用途允许对应字段
```

任何一层不成立都应拒绝，而不是降级为“尽量回答”。群聊中能看到机器人，不等于能看到机器人掌握的数据；被拉进项目群，不等于自动获得人才联系方式或私人评价。

### 4.3 顾问最终保留的判断

- 是否接受或放弃一个职位；
- 是否把候选人加入正式 shortlist；
- 候选人是否值得联系以及使用哪段话；
- 是否向客户推荐候选人；
- 面试评价、薪资和 Offer 判断；
- 任何外发消息、建群、共享文档和业务状态变更。

首期 Agent 只能准备这些动作需要的事实和草稿，不能执行。

## 5. 当前仓库审计结论

### 5.1 基线和环境

| 检查项 | 本次确认 | 对 PRD 的影响 |
|---|---|---|
| 远端基线 | 获取远端后 `origin/main` 仍为 `b00a870` | 本文不是基于过期的本地远端引用 |
| 当前分支 | 在主线之上有两个既有文档提交，代码未变 | 审计针对当前真实代码和既有设计文档 |
| Node | 开发机为 `v24.19.0`，项目要求 Node 22.5+ | 现有运行基础满足项目要求 |
| OpenClaw | 开发机安装 `2026.7.1-2` | 可做本地/测试环境 PoC，但不能推出生产已接入 |
| Plugin Node 要求 | 官方当前要求 Node 22.22.3+、24.15+ 或 25.9+；开发机 `24.19.0` 满足 | OpenClaw 插件进程不能只沿用项目较低的 Node 22.5+ 下限，部署镜像要单独锁定 |
| 仓库接入 | 未发现 OpenClaw 配置、插件或适配代码 | OpenClaw 链路为全新施工项 |
| `lark-cli` | 当前不在 `PATH` | 旧推送代码的部署依赖必须另行核对；新链路不应继续依赖它作为主入口 |

### 5.2 已存在且应复用的能力

| 能力 | 代码事实 | 复用方式 |
|---|---|---|
| 顾问登录映射 | HMAC 会话、飞书 OAuth、顾问 roster | 作为身份绑定基础，不能直接相信模型传参 |
| 职位可见性 | `jobVisibleTo`、项目 membership 和顾问 `cid` | 统一封装进新网关的数据范围策略 |
| 推荐快照 | 不可变 recommendation run、分页和回放 | OpenClaw 只读现有冻结结果，不在对话中重算真相 |
| 同步完整门禁 | TTC 同步完成后才进入推荐 | 继续作为职位数据新鲜度依据 |
| 飞书用户 token | AES-256-GCM 存储和刷新 | 仅在明确需要用户身份 API 时复用，不和机器人凭证混用 |
| 飞书推送幂等 | `push_log` | 可借鉴幂等键，但不复用旧卡片动作作为 Agent 写入口 |
| OpenMai PoC | 异步请求、SSE/轮询和结果保存 | 只作为链路样板；需补任务历史、幂等和结构化结果 |
| 人才 RDS | 人才、简历、职位、匹配记录和连接测试 | 保留兼容，先补迁移和授权模型，再开放给 Agent |
| Web Agent | 6 个 Skills、工具循环、SSE 回复 | 可复用意图与回答经验，不直接复用其权限目录 |
| SQL 防护测试 | 只允许 SELECT/WITH/EXPLAIN、限制返回数 | 继续保留给内部诊断，但从 OpenClaw 工具目录永久移除 |

### 5.3 与旧文档不一致的关键事实

1. 现有 `mcp/server.mjs` 虽然共有 15 个工具，但不是“15 个只读工具”。它包含推荐运行、反馈、触达、进展、终局结果、业务结果、同步和资料更新等写能力。
2. 现有 MCP 以调用方传入的 `consultant_id` 作为多项操作上下文，不足以抵抗跨顾问越权，不能直接给共享 OpenClaw 使用。
3. Web Agent 的 15 个工具与 MCP 的 15 个工具不是同一权限集合。Web Agent 通过 `ctx.cid` 绑定顾问，但仍包含需要特别处理的全库人才查询和任意只读 SQL。
4. `brainx_talent` 当前可以列出候选人并读取单个候选人的简历信息，没有统一使用 `ctx.cid`、项目范围或人才授权检查。
5. `query_sql` 只验证语句类型和行数，没有自动注入租户/顾问条件；它不能成为生产 Agent 工具。
6. 当前飞书 OAuth scope 是既有用户授权的只读 scope，不是 OpenClaw 机器人事件接收与发消息权限已经获批的证明。
7. 架构图中的 `workflow_event_log`、`idx_wel_idem`、`entity_links`、Agent run、审批和 outbox 在当前迁移中并不存在。

### 5.4 数据与算法缺口

| 范围 | 当前实现 | 真实缺口 | 首期处理 |
|---|---|---|---|
| 简历解析 | `src/resume.js` 只对纯文本做姓名、电话、邮箱、技能、意向和摘要的正则抽取 | 无 PDF/DOCX、经历/教育、证据位置、置信度、版本和 OCR 状态 | 新增隔离解析作业；现有结果标记 `legacy-text-v0` |
| 人才授权 | RDS 人才表没有租户、所有者、项目或来源授权字段 | 服务账号有数据访问不代表顾问有业务查看权 | 先建授权账本；未授权人才不进入 OpenClaw |
| 人才存储 | RDS DDL 由代码 `CREATE IF NOT EXISTS` 管理 | 无可靠版本迁移、回滚和 schema history | 先引入 MySQL 迁移机制再加表 |
| 人才兜底 | RDS 未配置/失败时可静默落到内存 | 生产可能出现重启即丢失或假成功 | 生产 fail-closed；内存仅显式测试模式 |
| 匹配 | `supply-match-v1` 是技能 0.5、意向 0.3、文本 0.2 的词项重合 | 不足以处理硬条件、经历深度、稳定性、动机和结果学习 | 只作影子基线；新增可解释特征，不替换正式算法 |
| 匹配历史 | `match_record` 按人才/职位唯一并覆盖 | 无算法版本、输入快照、特征历史和回放 | 新增版本化 match run；旧表仅作最新兼容投影 |
| 候选检索 | 单次最多读取 200 人计算 | 不是可扩展召回，不能支撑大人才池 | 首期只读预计算 shortlist；向量召回另做基准验证 |
| OpenMai 结果 | 每顾问/项目只保留一份最新 Markdown 结果 | 重启恢复、任务历史、候选实体、来源证据不足 | 新增任务账本和结构化结果后才可由 Agent 查询 |

### 5.5 直接接入将导致的风险

如果把 OpenClaw 直接连到当前 `mcp/server.mjs`，至少会产生：

- 模型传入他人 `consultant_id` 的横向越权风险；
- 通过 `brainx_talent` 读取未授权人才及联系方式的风险；
- 通过写工具改变项目、触达或结果状态的风险；
- 通过 SQL 查询绕过领域层字段裁剪的风险；
- 无持久 Agent run、tool call 和关联事件，事后无法完整还原；
- 群消息、私聊、Web 登录和飞书 OAuth 多套身份无法可靠合并。

因此，“复用现有 MCP”在本 PRD 中指复用领域函数和响应结构，不是复用现有进程与完整工具目录。

## 6. 目标架构

```text
飞书私聊 / 白名单项目群
        │ 事件与回复
        ▼
OpenClaw 官方飞书插件
  - WebSocket 长连接
  - 渠道白名单与 @ 规则
  - 会话隔离与流式卡片
        │ 已验证的飞书 sender/chat/thread 上下文
        ▼
OpenClaw Gateway + BrainX Skills
  - 理解意图
  - 选择只读/计算工具
  - 组织事实、推断、建议、待确认
        │
        ▼
BrainX OpenClaw 原生工具插件
  - 从 tool runtime 读取可信 requester/channel context
  - 只注册 manifest 声明的 BrainX 窄工具
  - 签发短期主体声明；模型不能修改身份
        │
        ▼
BrainX Agent Gateway
  - app/open_id/union_id → consultant/tenant
  - 项目与人才授权
  - 字段级最小化
  - 速率、超时、幂等、审计
        │
        ├── BrainX SQLite：职位、项目、推荐、进展、结果
        ├── 人才 RDS：人才事实、简历版本、授权、匹配版本
        ├── 解析作业：PDF/DOCX → 结构化事实 + 证据
        ├── reloop/OpenMai：受控搜索任务和结构化结果
        └── DataClaw：经正式契约开放的个人经营信号
```

### 6.1 OpenClaw 的产品角色

OpenClaw 是“工作流大脑”，主要承担：

1. 判断用户在问职位、人才、项目、复盘还是方法；
2. 只调用完成问题所需的最少工具；
3. 在多来源之间建立本次回答的上下文，不建立新的业务主数据；
4. 将结构化结果组织成飞书可读的短消息和卡片；
5. 发现证据不足时，一次只问顾问一个最关键问题；
6. 对长任务先返回已接收和范围，再异步读取结果；
7. 把无法执行的动作明确标成“草稿/待确认/暂未开放”。

### 6.2 BrainX 的产品角色

BrainX 是“业务权威和安全执行层”，必须独立于模型保证：

- 谁在问；
- 能看哪个租户、项目、职位和人才；
- 哪些字段可以返回到私聊或群聊；
- 使用的是哪个数据版本、算法版本和证据；
- 每次工具调用是否成功、超时或被拒绝；
- 同一事件是否已经处理；
- 数据源不可用时是否诚实失败。

### 6.3 Skill 层与工具层

Skill 只描述“如何做好一类工作”，例如职位澄清或候选人证据核对；工具才拥有读取数据的能力。Skill 文本不得携带密钥、SQL、个人联系方式或绕过审批的说明。

生产飞书链路使用 BrainX 的 OpenClaw 原生工具插件，不让通用 MCP 进程承担用户身份传递。官方插件 SDK 的 tool factory 能读取运行时提供的 `requesterSenderId`、`nativeChannelId` 和当前 delivery context；这些值来自渠道适配器，而不是消息正文。BrainX 插件把它们转换成短期签名声明后调用 Agent Gateway。现有 `mcp/server.mjs` 继续服务受信本地开发场景，但不进入生产飞书工具目录。

首期 Skill 建议保留七个窄主题：

- `brainx-today`：今日优先级与未闭环事项；
- `brainx-job`：职位事实、投资判断和待确认缺口；
- `brainx-talent`：候选人事实、实力与风险；
- `brainx-match`：职位匹配、硬条件和证据解释；
- `brainx-engagement-draft`：只生成沟通草稿，不发送；
- `brainx-interview-prep`：面试准备和追问建议；
- `brainx-review`：个人目标与实际的事实复盘。

## 7. 飞书接入方案

### 7.1 官方可实现路径

根据 OpenClaw 官方飞书文档，首期使用官方 `@openclaw/feishu` 插件：

1. 安装与当前 OpenClaw 版本匹配的官方插件；
2. 在飞书开放平台创建企业自建应用，启用机器人；
3. 配置 App ID 与 App Secret；
4. 申请首期最小权限；
5. 订阅 `im.message.receive_v1`；
6. 使用 WebSocket 长连接接收事件，避免首期暴露公网 webhook；
7. 发布应用并由管理员审批；
8. 用测试租户完成私聊、群 @、重复事件和权限拒绝测试；
9. 通过后才加入生产白名单群。

WebSocket 只降低网络接入成本，不替代飞书应用审批，也不替代 BrainX 业务鉴权。

### 7.2 首期 OpenClaw 配置基线

以下是配置意图，不是可直接复制到生产的密钥文件。准确字段以锁定版本 `2026.7.1-2` 的官方 schema 和本地 `openclaw doctor` 结果为准。

| 配置 | 首期值 | 原因 |
|---|---|---|
| 连接模式 | WebSocket | 官方支持，首期不需要公网 webhook |
| 飞书账号数 | 1 | 避免多账号默认路由和身份映射复杂度 |
| 私聊策略 | allowlist；内测可先 pairing | 只允许已绑定顾问 |
| 私聊会话范围 | `session.dmScope=per-channel-peer` | OpenClaw 默认 `main` 会把多人的私聊放入同一主会话，不适合团队机器人 |
| 群策略 | allowlist | 只进入登记过的项目群/顾问群 |
| 群内发言人 | 每群 `allowFrom` 或统一 sender allowlist | 群被允许不代表群里每个人都能触发 Agent |
| 群触发 | 必须 @ 机器人 | 减少误触发与无关群消息进入模型 |
| 群会话范围 | `group_topic_sender` | 同一群按话题和发言人隔离，避免上下文串线 |
| 补充上下文 | `contextVisibility=allowlist` | 过滤不在 sender allowlist 中的引用、历史和转发上下文 |
| 机器人消息 | `allowBots=false` | 防止机器人互相触发和循环 |
| 动态创建 Agent | 关闭 | 动态工作区隔离不是多租户安全边界 |
| 配置写回 | `configWrites=false` | 禁止对话导致配置漂移 |
| 插件加载 | `plugins.allow` 只含官方 Feishu 和内部 BrainX 插件 | 防止已安装但未评审的插件获得运行时注册机会 |
| 全局工具 profile | `minimal` + `alsoAllow` 精确列出 BrainX 工具 | `messaging` profile 自带 session/send/spawn 等首期不需要的能力 |
| 运行时/文件/网络工具 | deny exec/process/read/write/edit/apply_patch/browser/web fetch/search/gateway/nodes/cron/session spawn/send | 不让飞书内容转化为主机、文件、网络或控制面权限 |
| 沙箱 | 全会话启用，workspace access 设为 `none` | 工具误配时仍缩小主机与工作区暴露面 |
| 沙箱内插件工具 | sandbox tool allowlist 只放 BrainX 插件 ID/精确工具名 | OpenClaw 对沙箱内 MCP/plugin 工具还有第二道工具门 |
| elevated | 关闭 | 禁止绕过沙箱在 Gateway 主机执行 |
| Code Mode | 关闭 | 不让模型通过代码目录间接发现或组合工具 |
| ACP/Codex 会话 | 不配置 runtime 或 binding | `/acp` 不得启动可执行代码或操作仓库的 Agent |
| reasoning/verbose/trace | 群聊关闭 | 避免工具参数、诊断和模型内部信息被公开 |
| 飞书 workspace tools | doc/wiki/drive/bitable/perm 全部关闭 | 官方插件这些工具部分默认开启，但首期不需要 |
| chat 管理工具 | 关闭 | 不让 Agent 建群、加人或改群 |
| scopes 查询 | 可供管理员诊断，不向普通对话开放 | 只用于部署验收 |
| 卡片流式回复 | 开启并做兼容测试 | 改善长回答等待体验 |

### 7.3 飞书权限三道门

| 权限层 | 判断内容 | 失败响应 |
|---|---|---|
| 飞书应用权限 | 应用是否能收该事件、发该消息、读取所需资源 | 不处理事件或提示应用权限未配置 |
| OpenClaw 渠道策略 | sender/chat 是否在允许列表、群里是否 @、是否为机器人消息 | 渠道层拒绝，不进入模型 |
| BrainX 业务授权 | sender 对应哪个顾问/租户，可见哪些对象和字段 | 工具返回稳定的 `FORBIDDEN_SCOPE`，不泄露对象是否存在 |

三道门是“并且”关系。飞书管理员把机器人拉进群，只完成了入口配置，不能授予人才数据权限。

### 7.4 首期飞书能力与权限

上线前必须从飞书开发者后台导出实际 scope 清单存档，不能凭本文猜测精确 scope 名称。按能力申请的最小集合为：

| 能力 | 首期 | 备注 |
|---|---|---|
| 接收机器人私聊 | 必需 | 仅白名单顾问 |
| 接收群内 @ 消息 | 必需 | 仅白名单群 |
| 机器人回复消息/卡片 | 必需 | 只回复发起会话，不主动群发 |
| 读取群历史消息 | 不申请 | 首期只处理收到的事件上下文 |
| 读取通讯录全量 | 不申请 | 身份映射使用事件标识和预绑定表 |
| 下载聊天附件 | 不申请 | 简历附件上传延后到数据保护评审后 |
| 云文档读写 | 不申请 | 报告直接在对话展示或打开 BrainX Web |
| 多维表格读写 | 不申请 | 业务数据通过 BrainX 领域接口读取 |
| 群管理/建群/加人 | 不申请 | 首期禁止执行 |
| 以用户身份发送消息 | 不申请 | 首期只用机器人身份回复 |

现有 `src/oauth.js` 的用户 OAuth read scope 可继续服务 Web 登录和已有桥接，但不能代替机器人应用的事件/发送权限验证。

### 7.5 飞书身份映射

飞书 `open_id` 与应用绑定，不能假设旧应用获得的 `open_id` 在新机器人应用中不变。现有 `consultants.open_id` 单字段不足以支持换 App 或双 App。

新增身份绑定记录至少包含：

```text
tenant_id
feishu_app_key（只存非敏感稳定标识或哈希）
open_id
union_id（飞书返回时保存）
consultant_id
employee_ref（可选的内部员工稳定 ID）
binding_status
verified_at / verified_by
revoked_at
```

绑定必须由管理员导入或一次性配对确认产生。OpenClaw 传来的 `consultant_id` 一律忽略；BrainX 根据签名过的渠道主体重新解析。

### 7.6 群聊数据最小化

- 群聊默认不显示候选人手机、邮箱、私人评价和完整简历原文。
- 候选人使用脱敏名称或内部短 ID；需要敏感信息时引导到个人私聊或 BrainX Web，并再次鉴权。
- 卡片只包含 3—5 个最相关对象；完整列表用受权限保护的 Web 深链。
- 不在群里引用其他群、私聊或管理者上下文。
- 群聊会话记忆只帮助理解对话，不成为项目成员或数据授权证据。

## 8. BrainX Agent Gateway 权限设计

### 8.1 为什么必须新增窄网关

当前 Web Agent、当前 MCP 和 OpenClaw 的信任边界不同。OpenClaw 接收来自飞书的非受信文本，且可能在群场景运行；因此它只能连接一个专为 Agent 设计的读/计算接口，不能连接应用数据库、内部 SQL 工具或现有完整 MCP。

生产接入由两个最小组件组成：

1. **BrainX OpenClaw 原生工具插件**：只负责读取 OpenClaw 运行时的可信请求者/渠道上下文、暴露白名单 schema、调用唯一 BrainX Gateway 域名；
2. **BrainX Agent Gateway**：验证插件服务凭证和主体声明，映射顾问/租户，执行对象与字段授权，再调用现有领域函数。

不选择“Skill 把 sender ID 填入 MCP 参数”的方案，因为 Skill 和模型输出都不是身份边界。即使以后使用 OpenClaw requester-scoped MCP，也必须证明请求者上下文来自渠道运行时并在服务端 fail-closed；在此之前，原生工具插件是首期确定方案。

### 8.2 服务端主体上下文

每次工具调用必须携带由 BrainX OpenClaw 插件基于可信 runtime context 生成、短时有效且不可由模型编辑的主体声明：

```json
{
  "channel": "feishu",
  "account_id": "openclaw-account-id",
  "requester_sender_id": "ou_xxx",
  "chat_type": "p2p|group",
  "chat_id": "opaque",
  "thread_id": "opaque|null",
  "purpose": "daily_brief|job_review|candidate_review|personal_review",
  "issued_at": "ISO-8601",
  "expires_at": "ISO-8601",
  "request_id": "uuid"
}
```

插件声明必须含 nonce/请求 ID，并由 Agent Gateway 校验签名、有效期、服务凭证和重放。插件若拿不到 `requesterSenderId`、channel 或 account context，工具必须拒绝调用，不能使用默认顾问。

模型只提交业务参数，例如 `job_id` 或 `candidate_ref`。`tenant_id`、`consultant_id`、飞书 sender、字段级权限和数据范围不能作为模型参数，也不由 OpenClaw 推断。Gateway 收到声明后使用 account → Feishu App 映射和 App 维度身份表解析顾问与租户。

### 8.3 首期允许的工具

| 工具 | 输入 | 返回 | 权限与限制 |
|---|---|---|---|
| `brainx_me_context` | 无 | 顾问本人、时区、可用能力、数据新鲜度 | 不返回他人 roster |
| `brainx_daily_brief` | 日期、最多条数 | 今日职位/项目优先级、原因、证据和缺口 | 只读本人授权对象，最多 10 条 |
| `brainx_job_assessment` | `job_id` | 职位事实、冻结评分、风险、待确认项 | 必须通过 `jobVisibleTo` |
| `brainx_candidate_shortlist` | `job_id`、分页 token | 预计算 shortlist、硬条件、证据覆盖 | 不直接返回联系方式；最多 20 条/页 |
| `brainx_candidate_facts` | `candidate_ref`、用途 | 脱敏事实、经历、证据、质量状态 | 必须通过人才授权与项目范围 |
| `brainx_candidate_fit` | `job_id`、`candidate_ref` | 候选人实力与职位匹配分开解释 | 只读版本化 match run |
| `brainx_gap_questions` | 对象类型和 ID | 最多 3 个按价值排序的待确认问题 | 只能基于已有缺口生成 |
| `brainx_interview_prep` | `job_id`、`candidate_ref` | 追问、风险验证点、证据引用 | 不生成虚构经历，不写评价 |
| `brainx_personal_review` | 日期范围 | 本人目标、实际、差异和建议 | DataClaw 未接通时明确缺源 |
| `brainx_run_status` | `run_id` | 受控计算任务状态和结果引用 | 只能读取本人发起/获授权任务 |

每个返回必须包含：

```json
{
  "data": {},
  "facts": [],
  "inferences": [],
  "recommendations": [],
  "unknowns": [],
  "evidence_refs": [],
  "data_scope": {},
  "source_versions": {},
  "generated_at": "ISO-8601",
  "next_allowed_actions": []
}
```

### 8.4 首期明确禁止的工具

- `query_sql` 或任何通用 SQL；
- 当前 `brainx_talent` 全库浏览接口；
- 任意 Shell、文件系统、包安装或代码执行；
- 任意 URL 抓取或无域名白名单 HTTP；
- 现有 MCP 的推荐运行、反馈、触达、进展、终局、同步和 profile 更新；
- 飞书文档、云盘、多维表格、权限和群管理工具；
- 模型自定义 cron、动态 Agent、动态工具安装和配置写回；
- 直接调用 reloop/OpenMai 创建收费或外部任务；
- 直接读取 DataClaw 管理视角接口。

### 8.5 返回字段最小化

字段裁剪在服务端完成，OpenClaw 提示词不能决定是否脱敏。

| 场景 | 默认可见 | 默认不可见 |
|---|---|---|
| 顾问私聊 | 授权对象事实、证据摘要、内部引用 | 无用途的完整原文、第三方私人评价、密钥和源系统 token |
| 项目群 | 职位事实、脱敏候选概况、匹配证据 | 手机、邮箱、完整简历、薪资隐私、其他项目反馈 |
| 个人复盘 | 本人目标与业务结果 | 团队其他成员明细、管理者私密评语 |
| 管理诊断 | 首期不开放 | 全部管理字段 |

### 8.6 插件与 Agent Gateway 接口

首期只提供一个内部入口：

```text
POST /internal/v1/agent/tools/{tool_name}
```

请求由 BrainX OpenClaw 插件创建：

```json
{
  "schema_version": "agent_tool_request.v1",
  "request_id": "uuid",
  "principal_assertion": "signed-opaque-value",
  "arguments": {"job_id": "job_xxx"}
}
```

约束：

- `tool_name` 同时通过路由白名单、插件 manifest 和 OpenClaw tool allowlist；三者必须一致；
- 请求 body 的 `arguments` schema 禁止出现 tenant、consultant、sender、scope 或 raw SQL；
- `principal_assertion` 覆盖 account/channel/sender/chat/thread、签发时间、过期时间、nonce、request ID 和 body hash；
- Gateway 使用当前/上一把轮换密钥验签并消费 nonce，拒绝超时和重放；
- 同机优先使用 Unix socket 或 loopback；跨主机时使用私网 TLS/mTLS，不开放公网；
- 插件只能访问配置中的单个 BrainX Gateway，不接受模型传 URL；
- 服务凭证和签名密钥只在 OpenClaw/BrainX 进程环境中，不能放入 Skill、仓库或模型上下文；
- 普通读工具可对明确的瞬时网络失败做有界重试；鉴权、授权、schema 和质量错误不得重试；
- 解析、搜索和大批量计算必须返回 `run_id`，不能占住同步工具调用。

统一错误 envelope：

```json
{
  "error": {
    "code": "NOT_FOUND_OR_FORBIDDEN",
    "message": "当前会话无法读取该对象",
    "retryable": false,
    "request_id": "uuid"
  }
}
```

首期稳定错误码：`UNAUTHENTICATED`、`UNBOUND_IDENTITY`、`NOT_FOUND_OR_FORBIDDEN`、`STALE_DATA`、`SOURCE_UNAVAILABLE`、`QUALITY_INSUFFICIENT`、`RATE_LIMITED`、`TOOL_DISABLED`、`INTERNAL`。用户回复使用可理解文案；内部堆栈、SQL、对象存在性和上游 token 不返回 OpenClaw。

## 9. 人才库权限落地

### 9.1 已知业务方案与技术解释

业务提出的低成本临时方案是：团队成员各自把人才库共享给 TTC AI 助手。该方案可以解决源系统服务账号“是否能读取”的问题，但不能自动解决：

- 哪位顾问可以看到哪位人才；
- 私人备注和联系方式能否跨顾问显示；
- 人才被哪个项目使用；
- 数据授权何时撤回；
- 共享动作来自谁、覆盖何种范围。

因此即使整库权限获批，也不能删除 BrainX 的租户、用途和字段隔离。最多可以减少对源系统多账号连接的开发，不应省去业务授权层。

### 9.2 授权账本

新增 `talent_access_grants`，至少记录：

```text
grant_id
tenant_id
source_system
source_account_ref
grantor_consultant_id
grantee_type: consultant|project|team_service
grantee_ref
scope: metadata|resume_facts|contact|private_notes
purpose
status
granted_at / expires_at / revoked_at
source_proof_ref
```

权限判断不得只看人才表存在。没有有效 grant 时统一返回无权限，不区分“人才不存在”和“存在但无权限”。

### 9.3 联系方式与敏感字段

- 手机、邮箱默认独立 scope；有简历事实权限不等于有联系方式权限。
- 私人备注不进入团队共享索引。
- 原始简历只供解析作业和授权详情页使用，不进入 OpenClaw 长期记忆。
- 日志和评测样本必须脱敏；生产原文不得复制到测试环境。
- 授权撤销后，搜索索引、缓存和会话引用都应在规定时限内失效；具体时限由安全负责人确认后配置，PRD 不虚构法务期限。

## 10. 简历解析与 Resume-Matcher 能力复用

### 10.1 接入决策

不把 Resume-Matcher 整套应用接入 BrainX，也不部署其无认证 API 作为公网服务。只借鉴或在许可证要求下复用以下能力：

1. PDF/DOCX 经文档提取后转结构化 JSON；
2. Pydantic/JSON Schema 式强校验和容错归一；
3. master resume 与派生版本分离；
4. 字段 allowlist、原值比对和禁止新增身份事实；
5. JD 缺口拆成“缺失、可补充、不可补充”；
6. 针对缺口的一次一个问题和 section-scoped merge；
7. 结构化面试准备与来源约束；
8. 确定性评分器、LLM judge 和已知错误负样本组成的评测框架。

不复用：其 ATS 总分、完整前后端、简历模板/PDF 生成、申请追踪器、API Key UI 和无认证部署方式。

### 10.2 真实可行的部署方式

现有 BrainX 是 Node 服务，而上游解析能力是 Python/FastAPI/MarkItDown/Pydantic。首期不把 Python 依赖塞进主服务，新增隔离的内部解析 worker：

```text
BrainX ingestion job
  → 一次性对象引用（不传本机任意路径）
  → parser worker（无公网入口，默认无外网）
  → MarkItDown 提取 Markdown
  → 受控模型或规则结构化
  → schema validator
  → evidence locator + content hash
  → BrainX 候选人事实版本
```

如果是扫描 PDF 或抽取文本不足，worker 返回 `OCR_REQUIRED`，首期不伪装解析成功。MarkItDown 本身不是完整 OCR 方案；OCR 是否引入及其数据合规另立任务。

### 10.3 候选人事实 schema

最低结构：

- 身份：姓名、脱敏联系方式引用；
- 工作经历：公司、职位、开始/结束、职责、成果、证据片段；
- 项目经历：名称、角色、行动、结果、证据片段；
- 教育：学校、学位、专业、时间、证据片段；
- 技能：标准词、原文、熟练度是否为明确事实；
- 求职约束：城市、薪资、到岗、行业偏好及来源；
- 质量：字段置信状态、解析器版本、原文件 hash、是否需要人工确认；
- 来源：文档版本、页码/段落或字符区间、抽取时间。

每个关键字段必须满足以下之一：

- 有可回溯证据，状态为 `SUPPORTED`；
- 是顾问/候选人明确补充，记录操作者和时间；
- 无证据，状态为 `UNKNOWN`，不能进入事实字段。

### 10.4 数据保留原则

- 原始文件和提取文本分开存储并使用不同访问权限；
- OpenClaw 只收到完成问题所需的结构化片段；
- 模型输入、模型输出和最终接受事实分开保存；
- 临时文件在作业结束后清除，失败作业也必须进入清理队列；
- 复制上游代码时保留 Apache-2.0 许可证和版权声明并标注修改；
- 固定上游 commit/版本，不跟随 `main` 自动升级。

## 11. 职位—人才匹配方案

### 11.1 评分原则

必须分别展示：

1. **候选人实力**：独立于当前职位的经历深度、成果证据和稳定性；
2. **本职位匹配**：对当前 JD 的硬条件、经验、行业、地点、薪资和动机匹配；
3. **证据覆盖**：判断中有多少来自可回溯事实；
4. **风险与待确认**：不能由模型当成事实的未知项。

不得把“简历栏目齐全”当候选人更强，也不得把关键词覆盖直接叫作“录用概率”。

### 11.2 分阶段实现

**MVP：**

- 从 JD 抽取必需、优先、职责和待确认条件；
- 先做可解释硬条件检查；
- 读取已有预计算 shortlist；
- 将当前 `supply-match-v1` 仅作为影子特征；
- 输出命中证据、缺失项和问题，不显示虚假的统一胜率。

**评测阶段：**

- 用脱敏的真实“职位—候选人—顾问判断—后续结果”建立固定集；
- 比较现有基线与新增结构化特征；
- 使用 Recall@20、NDCG@10、硬条件误放率和证据覆盖率；
- 没有达到经产品与算法负责人批准的基线，不切正式排序。

**可选召回阶段：**

- BGE-M3/向量索引只作为待验证技术选项；
- 当前 MySQL 人才库没有已确认的向量能力，不能在 PRD 中假定可直接使用；
- 若采用独立 FAISS/向量服务，必须先验证中文简历、增量更新、删除传播、租户隔离和恢复方案。

### 11.3 版本化匹配记录

新增 append-only 的 match run，至少记录：

```text
match_run_id
tenant_id
job_version_id
candidate_fact_version_id
algorithm_version
feature_schema_version
hard_filter_result
feature_values
strength_assessment
job_fit_assessment
evidence_refs
created_at
```

现有 `match_record` 暂时保留为“最新结果兼容投影”，不再作为唯一历史真相。

## 12. 首期黄金工作流

### 12.1 今日行动简报

顾问问：“我今天先做什么？”

1. OpenClaw 确认本人和会话范围；
2. 读取 `brainx_daily_brief`；
3. BrainX 按冻结职位结果、项目进展、承诺时间和数据新鲜度排序；
4. 回复最多 5 个优先动作；
5. 每项显示对象、为什么现在做、事实依据、缺口和建议下一步；
6. 不自动发提醒、不改项目状态；
7. 顾问可继续问其中一项。

输出示例：

```text
今天优先处理 3 件事

1. 物外智趣｜需要明确继续或放弃
事实：已超过约定反馈时间 1 天；最近一次进展来自 8-31。
判断：继续等待会扩大机会成本。
建议：今天联系客户确认；我可以先给你一版话术草稿。
待确认：客户是否已有口头延期。
```

### 12.2 职位判断

顾问问：“这个职位值得接吗？”

1. 如果上下文有多个职位，只问一个澄清问题；
2. 读取职位事实、冻结评分、项目关系和数据版本；
3. 分开输出客户/职位事实、投资判断、证据风险、待确认项；
4. 不自动加入项目；
5. 提供“查看评分证据”“问下一个关键问题”“打开 BrainX”三个安全动作。

### 12.3 候选人 shortlist

顾问问：“这个职位优先看谁？”

1. 验证职位可见性；
2. 验证人才授权账本和数据新鲜度；
3. 读取已完成的版本化 shortlist；
4. 群聊返回脱敏 Top 3，私聊最多 Top 5；
5. 每人显示候选人实力、本职位匹配、硬条件、证据和待确认项；
6. 没有合格的版本化结果时，明确说“尚无可用 shortlist”，不得临时扫描全库；
7. 顾问可查看下一页或某位候选人的证据。

### 12.4 候选人核对与补缺口

顾问问：“为什么推荐这个人？”

1. 读取候选人事实版本和 match run；
2. 对每个结论附证据引用；
3. 识别最影响判断的一个未知项；
4. 一次只向顾问问一个问题；
5. 首期回答只在会话中形成草稿，不写回人才事实；
6. 写回能力必须等候续确认式权限 PRD。

### 12.5 沟通草稿

顾问说：“帮我写一段联系话术。”

1. 只使用已授权的职位事实和候选人事实；
2. 不声称未确认的薪资、汇报线、公司阶段或候选人成果；
3. 输出“可直接复制的草稿”和“需要顾问补充的变量”；
4. 不调用飞书发送接口，不代替顾问联系外部人员。

### 12.6 面试准备

1. 从 JD 必需条件、候选人证据和未知项生成问题；
2. 每个问题说明要验证什么、哪项证据触发；
3. 区分事实核验、能力深挖、动机/约束三类；
4. 不生成歧视性、隐私侵入或与职位无关的问题；
5. 不写入面试评价。

### 12.7 个人目标复盘

1. DataClaw 接口未确认前，仅使用 BrainX 内能核对的本人数据和顾问在本次对话提供的目标；
2. 展示目标、实际、差异、额外产出、数据缺口和明日建议；
3. 评分口径必须展示，不能只给一个神秘分数；
4. 不读取团队其他成员明细；
5. 不将该结果自动发送给上级。

## 13. 飞书消息与卡片格式

### 13.1 内部数据格式

OpenClaw 与 BrainX 之间使用版本化 JSON，不使用 Markdown 作为唯一机器接口。Markdown 只用于最终展示。

每日简报建议 payload：

```json
{
  "schema_version": "daily_brief.v1",
  "subject": {"consultant_ref": "self", "date": "2026-09-02"},
  "summary": "今天优先处理 3 件事",
  "items": [
    {
      "entity_type": "job",
      "entity_ref": "job_xxx",
      "display_name": "物外智趣",
      "priority_reason": "承诺反馈已超时",
      "facts": [],
      "inference": "继续等待会扩大机会成本",
      "recommended_next_step": "确认继续或放弃",
      "unknowns": [],
      "evidence_refs": [],
      "web_url": "/jobs/job_xxx"
    }
  ],
  "generated_at": "ISO-8601",
  "source_versions": {}
}
```

候选人卡片建议字段：

- 脱敏姓名/候选人编号；
- 当前职位与公司；
- 候选人实力摘要；
- 本职位匹配摘要；
- 硬条件通过/不通过/待确认；
- 最强 2 条证据；
- 最大 1—2 条风险；
- 最关键的下一个问题；
- 数据更新时间与解析质量；
- “查看证据”“打开 BrainX”“下一位”安全按钮。

### 13.2 渲染责任

BrainX 返回结构化、已裁剪的数据；OpenClaw 组织语言；卡片模板由受版本控制的飞书适配层渲染。模型不得自由生成带敏感字段的任意卡片 JSON，也不得决定按钮对应哪个写接口。

### 13.3 超时与异步体验

- 普通只读查询目标是在 3 秒内开始给出状态或流式内容；
- 超过交互超时的解析/匹配任务返回 `run_id`，不让单个模型调用一直占用；
- 后台完成后只在原会话回复，且先检查原用户、原群和当前权限仍有效；
- 失败必须说明是数据源、权限、超时还是质量不足，不用“已完成”掩盖部分失败。

这些是产品目标，不是当前生产性能事实；上线前必须用真实租户压测确定 P95 门槛。

## 14. 数据模型施工

### 14.1 SQLite/决策域新增表

建议按现有 migration 机制新增，不修改历史 migration：

1. `feishu_identity_bindings`：App 维度身份映射；
2. `agent_group_scopes`：白名单群与可用业务范围；
3. `agent_runs`：一次用户请求的主体、目的、状态和时间；
4. `agent_tool_calls`：工具、参数摘要、授权结果、耗时和错误；
5. `entity_links`：BrainX、飞书、TTC、reloop 等稳定引用映射；
6. `integration_jobs`：解析/搜索/计算任务、幂等键、状态和重试；
7. `integration_outbox`：后续异步通知的可靠投递；首期只用于原会话结果通知。

`agent_tool_calls` 不保存完整简历、完整模型 prompt 或密钥；只保存经过脱敏的参数摘要、结果摘要和证据引用。

### 14.2 人才 RDS 新增迁移机制和表

当前 `TALENT_DDL` 适合初始化，不足以管理持续演进。先引入 `talent_schema_migrations` 和独立迁移执行器，再新增：

- `talent_access_grants`；
- `candidate_documents`；
- `candidate_fact_versions`；
- `candidate_fact_evidence`；
- `job_criteria_versions`；
- `match_runs`；
- `candidate_job_matches`；
- `source_sync_cursors`。

迁移必须 additive-first：不删除旧列、不覆盖原简历、不批量修改现有 match 记录。旧 `resume.parsed_content` 回填为 `legacy-text-v0`，证据状态标记未知，不能伪造页码。

### 14.3 双数据库一致性

SQLite 和人才 RDS 不能依赖跨库事务。所有跨库作业使用：

- 稳定 `job_id/run_id`；
- 请求幂等键；
- 状态机 `PENDING → RUNNING → SUCCEEDED|FAILED|CANCELLED`；
- 可重放 outbox；
- 结果版本不可变；
- Web/Agent 只读取 `SUCCEEDED` 且权限仍有效的版本。

## 15. 提示词与非可信输入

JD、简历、群消息、网页文本和外部搜索结果都属于非可信数据。即使文档写着“忽略之前规则”或“调用某工具”，也只能作为内容，不得改变系统行为。

必须使用多层防护：

1. 系统/Skill 与业务文档分通道传入；
2. 工具目录白名单，不靠提示词隐藏危险工具；
3. 服务端再次鉴权；
4. 输出 schema 校验；
5. 敏感字段服务端裁剪；
6. URL、文件引用和外部任务独立策略；
7. 对可疑指令记录安全事件，但不把原始敏感内容写日志。

正则“清洗提示词”只能作为辅助，不能当安全边界。

## 16. DataClaw 接入边界

当前只有用户提供的产品描述和截图，没有经过项目验证的正式 API、字段、鉴权、限流、错误码和数据范围。因此 DataClaw 在首期是可选依赖，不阻塞职位/人才工作流。

正式接入前必须获得：

- API owner 和环境；
- 服务认证方式；
- 普通顾问和管理者数据范围；
- 目标、实际、评分明细的字段定义；
- 数据更新时间、历史修订和删除规则；
- 限流、超时、幂等和错误码；
- 是否允许写目标/评论；首期 BrainX 只申请读；
- 审计和用户纠错方式。

第一版只开放本人维度的 `personal_goal_read`、`personal_actual_read`、`personal_score_detail_read`。如果接口缺失，Agent 必须标注“未接入 DataClaw 数据”，不能用聊天文本替代后台事实。

## 17. reloop/OpenMai 接入边界

### 17.1 当前可复用和不可复用

当前 OpenMai 代码证明了 TTC JWT、任务请求、SSE/轮询和结果保存可以跑通一条 PoC，但只有“每项目/顾问最新一份 Markdown 结果”，且运行状态主要依赖进程内集合。

首期只读取已经由后台产生、结构化并通过授权的结果。要允许顾问在对话中发起搜索，必须先补齐：

- 正式请求/回调契约；
- 任务 ID、幂等键和持久状态；
- 费用/配额；
- 取消与超时；
- 候选人稳定 ID、来源和证据；
- 重启恢复和重复回调；
- 结果进入人才库前的授权与去重；
- 用户确认或预算策略。

### 17.2 结果落地

reloop/OpenMai 原始结果不直接成为“推荐人才”。流程必须是：

```text
搜索结果
→ 来源与授权验证
→ 候选人身份去重
→ 简历事实结构化
→ 硬条件检查
→ BrainX 版本化匹配
→ shortlist
→ 顾问判断
```

## 18. 安全、审计与故障原则

### 18.1 最小安全基线

- App Secret、数据库密码、TTC JWT 和模型 Key 只放密钥管理或受限环境变量；
- OpenClaw 配置、Skill 和仓库不得写真实密钥；
- Gateway 只监听受控网络，不能把本地 MCP stdio 变成无认证公网接口；
- 一个生产飞书 App 对应一个明确租户环境；
- 正式、测试数据和凭证隔离；
- 数据源不可用时 fail-closed，不切内存假数据；
- 所有拒绝不暴露目标对象是否存在；
- Agent 回复和工具调用都带 request/run 关联；
- 敏感内容不进入通用日志、遥测和错误栈；
- 备份、删除、授权撤销和索引清理必须可验证。

### 18.2 必记审计项

- 飞书事件 ID、会话类型和脱敏主体；
- 绑定得到的顾问/租户；
- 使用的 Skill 版本和工具版本；
- 每次工具授权结果、字段策略版本、数据版本；
- 模型版本、回答状态和证据引用；
- 拒绝、超时、重复事件和数据源降级；
- 后续任何写操作的确认人、确认内容和执行结果。

### 18.3 不记内容

- App Secret、OAuth token、数据库凭证；
- 完整简历原文；
- 无必要的手机、邮箱和身份证明；
- 模型供应商返回的敏感调试载荷；
- 其他顾问/群的完整对话。

## 19. 非功能需求

| 类别 | MVP 要求 | 验证方式 |
|---|---|---|
| 隔离 | 跨租户、跨顾问、跨项目、群/私聊用例 0 条数据泄漏 | 自动化负向测试 + 人工红队 |
| 身份 | 模型修改 consultant/tenant 参数无效 | 契约测试 |
| 幂等 | 相同飞书事件/任务回调不产生重复结果通知 | 重放测试 |
| 可恢复 | OpenClaw/BrainX/worker 重启后任务可查、可继续或明确失败 | 故障注入 |
| 真实性 | 所有关键判断可解析到证据或标为未知 | 固定评测集 |
| 数据新鲜度 | 回复显示源数据时间和版本 | API/卡片测试 |
| 可观察 | 每次用户请求可关联 Agent run 和工具调用 | 审计查询 |
| 性能 | 普通查询快速开始响应；长任务异步化 | 测试租户 P50/P95 基线后确定发布门槛 |
| 成本 | 每类工具和长任务有 token、次数和外部费用上限 | 配额测试和日报 |
| 可降级 | DataClaw/reloop 不可用不影响基本职位读取 | 依赖故障测试 |

## 20. 研发施工计划

### 阶段 0：冻结事实与关掉危险捷径

目标：不接生产飞书，先形成可以安全开发的边界。

1. 锁定 OpenClaw 和官方飞书插件版本，保存校验信息；
2. 在测试环境安装插件，运行配置诊断；
3. 锁定满足官方插件要求的 Node 运行时；当前开发机 24.19.0 可用，生产镜像仍需固定；
4. 导出飞书应用真实权限、事件订阅和发布状态；
5. 明确一个 App、一个测试租户、三名以内测试顾问和两个测试群；
6. 新建 BrainX OpenClaw 原生工具插件和只读 Agent Gateway，不修改现有 MCP 对外含义；
7. OpenClaw 环境强制排除 SQL、全库人才、写工具、Shell、文件和公网工具；
8. 生产人才库关闭静默内存 fallback；
9. 给旧文档和运行手册增加新权限边界链接。

验收：安全负责人能列出 OpenClaw 实际拥有的全部工具；列表中不存在通用执行和业务写工具。

### 阶段 1：身份与飞书只读闭环

目标：白名单顾问能在私聊和白名单群安全读取本人职位信息。

建议施工范围：

- 新增独立 OpenClaw 原生工具插件、manifest、部署样例和打包验证，不提交密钥；
- 工具 factory 只从 runtime context 读取 sender/channel/account，缺失时 fail-closed；
- 新增飞书 App 维度身份绑定 migration；
- 新增 Agent run/tool call 审计 migration；
- 新增服务端 principal 签发和校验；
- 新增 `brainx_me_context`、`brainx_daily_brief`、`brainx_job_assessment`；
- 增加私聊/群字段裁剪；
- 增加重复事件、身份伪造、群串线和未授权职位测试。

验收：同一句问题由两个顾问发出只返回各自可见对象；群聊不显示候选人敏感字段；伪造 `consultant_id` 无效。

### 阶段 2：人才授权与只读 shortlist

目标：在明确人才授权后，安全展示候选人事实和已有匹配结果。

1. 引入人才 RDS migration runner；
2. 建 `talent_access_grants`、fact version、evidence 和 match run；
3. 从现有简历和匹配记录 additive 回填，保留 legacy 标记；
4. 新增候选人事实、shortlist、fit 和 gap 工具；
5. 群聊脱敏、私聊字段授权和 Web 深链；
6. 完成撤权、缓存失效和索引删除测试。

验收：没有有效授权的候选人无法通过 ID 枚举、搜索、shortlist 或缓存被读取。

### 阶段 3：结构化简历与事实保护

目标：支持数字 PDF/DOCX 的可追溯解析，不改变最终推荐算法。

1. 隔离 parser worker，无公网入口；
2. 固定 schema、上游版本和许可证；
3. 建文档 hash、事实版本、证据定位和质量状态；
4. 空文本/扫描件返回 `OCR_REQUIRED`；
5. 建至少覆盖中英文、双栏、表格、日期、空字段和恶意提示的脱敏评测集；
6. 将解析特征以影子方式进入 match detail；
7. 人工抽查后再允许 OpenClaw 引用。

验收：结构化输出 100% 通过 schema；关键事实无证据时不落为 `SUPPORTED`；恶意文档不能改变工具或权限。

### 阶段 4：匹配评测与搜索任务

目标：用真实标注证明新增特征有价值，再决定是否改变排序。

1. 建冻结离线评测集；
2. 对比 `supply-match-v1`、结构化特征和候选召回方案；
3. 记录 Recall@20、NDCG@10、硬条件误放和证据覆盖；
4. 重构 OpenMai 为持久任务与结构化结果；
5. 对费用、限流、重启、重复回调和取消做测试；
6. 只在影子结果通过产品/算法评审后切换 shortlist。

验收阈值不能在没有基线数据时凭空制定。工程先交付可复跑报告；产品、算法和业务负责人基于真实分布签署阈值，签署前保持影子模式。

### 阶段 5：受确认的写操作（不属于本 PRD 的上线范围）

后续若要加入项目、保存补充事实、发送消息、建群或写 DataClaw，必须另立“确认式执行 PRD”，逐个动作定义：预览、确认、幂等、撤销/补偿、审计、超时和失败后状态。不得仅通过修改 prompt 开放。

## 21. 建议的代码拆分

以下是基于当前结构的施工建议，实际文件名可在实现 PR 中微调，但职责不能混回一个大文件：

```text
src/agent-gateway/
  principal.js          # 验证服务端主体，不接受模型身份
  policy.js             # 对象/字段/用途授权
  audit.js              # run 与 tool call 审计
  response.js           # 统一事实/推断/建议/证据 envelope
  tools/
    me-context.js
    daily-brief.js
    job-assessment.js
    candidate-shortlist.js
    candidate-facts.js
    candidate-fit.js
    gap-questions.js
    interview-prep.js

integrations/openclaw-brainx/
  openclaw.plugin.json  # 声明固定工具归属与配置 schema
  package.json          # TypeScript ESM；typebox 为运行依赖；锁定 SDK 兼容范围
  dist/                 # 构建产物；正式安装不直接依赖 TypeScript 源文件
  src/index.ts          # 注册 optional 工具 factory
  src/principal.ts      # 读取可信 runtime context 并签短期声明
  src/brainx-client.ts  # 只访问配置的 BrainX Gateway
  tests/                # 打包、运行时注册、缺失 requester 和越权测试

src/integrations/
  feishu-identity.js
  integration-jobs.js
  entity-links.js

workers/resume-parser/  # 独立运行与依赖边界；不得公开监听公网
```

不要在 `mcp/server.mjs` 中用几个 if 试图兼容“内部完整权限”和“OpenClaw 只读权限”，也不要让 Skill/模型把飞书 sender 复制成 MCP 参数。生产飞书只加载 BrainX 原生插件的固定工具清单；现有 MCP 保持受信本地工具，不参与渠道身份链。

插件验收不是“源码能 import”。必须构建 package、检查 `openclaw.plugin.json`、打包 tarball、以正式包形态安装，并用 `openclaw plugins inspect <id> --runtime --json` 核对运行时实际注册工具；测试环境还要运行 `openclaw doctor` 与 `openclaw security audit`。这些检查用于验证安装形态和策略，不能代替 BrainX 越权测试。

## 22. 测试与验收矩阵

### 22.1 身份和权限

- 未绑定飞书用户无法查询任何业务对象；
- 已撤销绑定立即失效；
- App A 的 `open_id` 不能在 App B 直接复用；
- 普通顾问无法指定他人 `consultant_id`；
- 白名单群 A 的上下文不进入群 B；
- 同群不同话题/发言人不串上下文；
- 群管理员身份不自动获得人才权限；
- 猜测 job/candidate ID 不泄露存在性；
- 授权撤销后缓存和异步结果不再投递；
- 普通顾问不能调用管理者 DataClaw 数据。

### 22.2 工具安全

- OpenClaw 工具清单不含 SQL、Shell、文件、任意 HTTP 和业务写；
- OpenClaw 安全审计确认 `tools.profile`、per-agent override、插件工具和沙箱没有策略漂移；
- `/acp`、`/reasoning`、`/verbose`、`/trace` 不能在群聊暴露执行或内部诊断能力；
- JD/简历中的提示注入不能调用额外工具；
- 工具参数中的 tenant/consultant 字段被拒绝或忽略；
- 超范围字段在 Gateway 返回前被裁剪；
- 返回过大时按对象分页，不把整库截断后塞给模型；
- 数据库不可用时不回退到内存并声称成功。

### 22.3 飞书链路

- 私聊白名单、pairing、拒绝和解绑；
- 群 @ 触发、未 @ 不触发；
- bot 消息不触发循环；
- 相同 `im.message.receive_v1` 重放只处理一次；
- 卡片流式更新失败时降级为普通消息；
- OpenClaw/BrainX 重启后不重复回复；
- 应用失去 scope、被移出群或版本未发布时给出可诊断状态。

### 22.4 简历与匹配

- 数字 PDF、DOCX、双栏、中英文、无日期、多个项目；
- 扫描 PDF 正确标记 `OCR_REQUIRED`；
- 同一文件 hash 不重复产生事实版本；
- 文件变化产生新版本且旧版本可回放；
- 新模型不得添加原文不存在的公司、学历、证书和数字；
- JD 必需和优先条件分开；
- 候选人实力与职位匹配分开；
- match run 能精确还原输入与算法版本；
- 已知错误样本能稳定让评测失败。

### 22.5 产品真实性

- 没有冻结推荐时不生成伪 shortlist；
- 没有 DataClaw 接口时不生成后台完成数据；
- 没有候选人授权时不暗示“没有候选人”；
- 事实、推断、建议和未知项在消息中可区分；
- 所有关键建议至少有一条证据或明确说明是经验性建议；
- 首期任何按钮都不能改变业务状态或发送外部联系消息。

## 23. 发布门禁

以下条件全部满足才允许首期灰度：

1. OpenClaw/飞书插件版本锁定且 staging 验证通过；
2. 飞书真实 scope、事件和应用发布审批留档；
3. 生产工具枚举与白名单一致，不含禁止工具；
4. 服务端身份绑定和三道权限门全部通过；
5. 跨顾问、跨租户、跨群负向测试 0 泄漏；
6. 普通查询与异步任务均可审计和重放；
7. RDS 生产连接失败时 fail-closed；
8. 群聊字段脱敏通过安全审核；
9. 数据源缺失和部分失败能诚实展示；
10. 仓库快速质量门禁和本功能专项测试通过；
11. 仅对不超过三名真实顾问灰度，且只加入登记测试群；
12. 有一键停用飞书渠道和撤销 Gateway service credential 的操作手册。

## 24. 成功指标

### 24.1 工程和安全指标

- 未授权数据泄漏事件：0；
- 无证据却标为事实的关键字段：0；
- 重复事件造成的重复回复/任务：0；
- 回复中能显示数据时间与来源版本的比例：100%；
- Agent 工具调用可关联到 run 的比例：100%；
- 被禁止动作由模型直接执行的次数：0。

### 24.2 产品指标

以下先建立基线，不提前伪造目标值：

- 顾问从提出问题到获得可行动答案的时间；
- 每日简报中被顾问继续查看的事项比例；
- shortlist 被顾问判定“值得进一步核对”的比例；
- 建议后形成真实项目推进的比例；
- 待确认问题被补齐后改变判断的比例；
- 顾问对事实准确、建议有用和节省时间的分项评分；
- 推荐到沟通、面试和 Offer 的漏斗，但必须按同一数据口径和对照周期计算。

“辅助每一个顾问变强”的核心衡量不是消息量，而是：顾问能否更快发现关键事实、更少漏掉风险、形成更好的判断并完成复盘。

## 25. 依赖、风险与未决项

### 25.1 外部依赖

- 飞书管理员批准应用和真实最小权限；
- 人才源系统确认共享/整库权限的含义；
- DataClaw 负责人提供正式契约；
- reloop/OpenMai 提供稳定任务、配额和结果协议；
- 模型供应商确认简历数据区域、保留和训练策略；
- 安全/法务确认原始简历、聊天和评测样本的保留规则。

### 25.2 主要风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 把 OpenClaw 当多租户安全边界 | 横向数据泄漏 | BrainX 服务端主体与业务授权，OpenClaw 只做编排 |
| 官方插件默认 workspace tools 过宽 | 文档、云盘或群能力意外开放 | 显式关闭，不依赖默认值，发布前枚举工具 |
| `open_id` 跨 App 误用 | 身份串错 | App 维度绑定，优先稳定员工/union 映射 |
| 当前 MCP 直接暴露 | 业务写和全库读取 | OpenClaw 原生 BrainX 插件 + 服务端 Agent Gateway；现有 MCP 不进入飞书链路 |
| 人才 RDS 静默内存 fallback | 数据丢失、假成功 | 生产 fail-closed |
| Resume-Matcher 整套接入 | 新攻击面、重复产品、错误 ATS 权重 | 只拆解析/事实/评测能力，隔离 worker |
| 扫描件解析不出 | 错误事实 | 明确 `OCR_REQUIRED`，不伪装成功 |
| 搜索 Markdown 当结构化人才 | 无法去重、回放和解释 | 结构化结果进入事实/匹配管道 |
| 旧文档把目标能力写成当前事实 | 误开权限 | 本文标注事实等级，旧文档标历史状态 |
| 群卡片暴露 PII | 隐私事故 | 群聊强制字段模板和脱敏 |

### 25.3 开工前必须确认但不阻塞 PRD 的事项

1. 生产使用新飞书 App 还是复用现有 App；
2. 飞书管理员导出的实际 scope 与事件权限；
3. 人才共享是团队池授权还是个人源账号代理；
4. DataClaw 是否有普通顾问正式接口；
5. reloop/OpenMai 搜索是否计费以及谁能发起；
6. 原始简历是否允许进入云端模型；
7. 首批 1—3 名灰度顾问、测试群和真实验收用例。

这些问题会改变配置或开放范围，因此实现时不能替用户默认决定；但它们不影响先建设只读 Gateway、身份绑定和审计骨架。

## 26. 明确不接受的“捷径”

- 让 OpenClaw 直接运行现有 MCP，再靠 prompt 说“不要写”；
- 把飞书 sender 提供的 consultant ID 原样传给数据库；
- 看到服务账号能查人才，就认为所有顾问都能看；
- 用现有 OAuth scopes 推断机器人权限已齐；
- 把群聊历史全量喂给模型以获得“更懂上下文”；
- 把 PDF 提取成功当结构化事实正确；
- 把关键词/ATS 分数当猎头推荐结论；
- 依赖内存 Set 作为生产任务锁或审计记录；
- 在一个 `match_record` 上覆盖结果却声称可回放；
- 为赶进度把扫描件、权限不明或数据源失败伪装成空结果；
- 在没有确认、幂等和补偿设计时开放发送、建群或业务状态写入。

## 27. 首期 Definition of Done

首期完成不是“机器人能回复”，而是以下闭环成立：

1. 白名单顾问在飞书私聊或白名单群 @ OpenClaw；
2. 飞书事件经官方插件进入固定会话范围；
3. BrainX 根据 App 维度身份绑定认出顾问；
4. Gateway 根据租户、项目、人才授权和用途裁剪数据；
5. OpenClaw 只能选择本文列出的只读/计算工具；
6. 回复区分事实、推断、建议和待确认，并带数据时间/证据；
7. 群聊不出现候选人敏感字段；
8. 模型、文档或用户无法伪造身份、扩大权限或调用写工具；
9. 请求、工具、数据版本、拒绝和结果可审计；
10. 依赖失败时诚实失败，不用内存假数据或无依据回答；
11. 跨用户/群/项目负向测试、幂等重放和重启恢复通过；
12. 灰度顾问能完成“今日简报 → 职位判断 → shortlist → 候选人证据 → 沟通草稿”且全程无业务写入。

满足以上条件后，BrainX 才拥有一个可以继续扩展的 AI-native 工作流底座。任何写操作、外发、建群、文档生成或管理诊断都是下一阶段能力，不能借“Agent 更聪明”绕过新的产品和安全验收。

## 28. 相关文档

- [BrainX 文档书](README.md)
- [历史：飞书 AI 猎头副驾驶 PRD](prd-2026-09-01-feishu-ai-consultant-copilot.md)
- [历史：Codex Agent 职责与权限规范](codex-agent-responsibilities-and-permissions.md)
- [BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md)
- [推荐队列与职位决策产品架构](recommendation-queue-product-architecture.md)
- [BrainX 岗位推荐算法与评分标准](BrainX岗位推荐算法与评分标准.md)
- [安全操作手册](SECURITY.md)
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)

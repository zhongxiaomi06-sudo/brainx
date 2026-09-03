# Research: 顾问个人模型配置

## Decision 1：飞书私聊采用动态个人 Agent

**Decision**: 开启 Feishu `dynamicAgentCreation`，保留 `dmScope=per-account-channel-peer`，动态 Agent 数量先限制为 20。

**Rationale**: OpenClaw 2026.7.1-2 官方 Feishu 文档确认，每位 DM 用户可自动得到独立 workspace、`USER.md/SOUL.md/MEMORY.md`、会话和状态，并自动建立精确 peer binding。[Feishu per-user isolation](https://docs.openclaw.ai/channels/feishu#per-user-agent-isolation-dynamic-agent-creation)

本机锁定版本源码与临时 state 实验证明，命名账号 `mia` 的 Agent ID 由 `sha256(accountId + "\\0" + open_id)` 的前 32 位生成，未来应以 OpenClaw 配置中的 binding 为最终事实，不把该算法当长期公共契约。

**Alternatives considered**:

- 继续共享 `main`：会共享认证策略且会话工具可能读取同 Agent 其他会话，不满足隔离。
- 手工维护六个 Agent：能用但无法自然扩展，新增顾问仍需运维改服务器。
- 每人本机安装 OpenClaw：与任意设备只用飞书的产品目标冲突。

## Decision 2：凭据只通过 OpenClaw 官方认证命令写入个人 agentDir

**Decision**: 使用 `openclaw models auth --agent <id> paste-api-key`，密钥只通过 stdin 传入；不直接修改 OpenClaw SQLite，不将密钥存入 BrainX SQLite。

**Rationale**: 官方 CLI 明确支持按 Agent 写认证 profile，且自动化应从 stdin 传密钥，避免出现在 shell history 或进程列表。[Models CLI auth profiles](https://docs.openclaw.ai/cli/models#auth-profiles)

本机以假密钥实测：Mia profile 只出现在 `agents/mia/agent/openclaw-agent.sqlite`，`models auth list --agent mia --json` 只返回元数据。

**Alternatives considered**:

- 把 Key 加密存入 BrainX：重复实现密钥生命周期，且 OpenClaw 仍需二次注入。
- 每人一个环境变量：每次轮换需要管理员改 systemd 环境并重启，不是自助配置。
- 在飞书消息里粘 Key：消息会进入飞书和会话记录，泄密面不可接受。

## Decision 3：首版只开放批准供应商，不开放任意 Base URL

**Decision**: 支持 OpenAI、Anthropic、Google Gemini 和 StepFun。模型 ID 由用户填写但必须符合严格格式；StepFun 只保留无密钥的公共 endpoint/catalog 配置。

**Rationale**: OpenClaw 把 custom provider 的 Base URL 视为模型网络信任决定；任意地址会扩大 SSRF 与数据目的地风险。[Custom providers and base URLs](https://docs.openclaw.ai/gateway/config-tools#custom-providers-and-base-urls)

**Alternatives considered**:

- 完全任意 OpenAI-compatible URL：灵活但需要 DNS 重绑定、私网地址、证书、数据责任人审批等额外治理。
- 只开放 OpenAI：不能满足“兼容 Codex 之外的模型”。
- StepFun 全局默认：一人的选择会影响全部顾问，正是本轮要修复的根因。

## Decision 4：个人模型只作用于私聊

**Decision**: 每位 DM 用户使用个人 Agent/凭据；共享群需要独立公司 Agent 与公司凭据，未配置时群内模型问答失败关闭。

**Rationale**: Agent binding 按 channel/account/peer 选择 Agent；群 peer 并不天然等于发言人的个人 Agent。把成员私钥用于群内其他人请求会破坏凭据所有权。[Agent bindings](https://docs.openclaw.ai/concepts/agent-bindings)

**Alternatives considered**:

- 按群发言人动态借个人 Agent：锁定版官方路由没有该安全契约。
- 群固定使用 Mia：构成跨人凭据与数据处理授权混用。

## Decision 5：共享 Skills 安装到 state 级 managed root

**Decision**: 安装器把七个审核过的 BrainX Skills 写入 `<state-dir>/skills`，并以 `agents.defaults.skills` 明确限制个人 Agent 只能看到这七个 Skill。

**Rationale**: 官方加载顺序确认 state 级 managed skills 对同一 state 的所有 Agent 可见，动态 workspace 无需复制。[OpenClaw shared managed skills](https://docs.openclaw.ai/tools/skills#per-agent-vs-shared-skills)

**Alternatives considered**:

- 只写默认 workspace：动态 Agent 看不到 Skills。
- 每次建 Agent 复制一份：产生版本漂移和更新遗漏。

## Decision 6：收窄会话与跨 Agent 能力

**Decision**: `tools.agentToAgent.enabled=false`，`tools.sessions.visibility=self`，`agents.defaults.modelSelectionScope=session`。

**Rationale**: OpenClaw 官方说明，per-peer session key 本身不限制会话工具可见性；必须显式设置 `self`，并关闭跨 Agent 消息。[Session visibility](https://docs.openclaw.ai/gateway/config-tools#tools-sessions)

**Alternatives considered**:

- 使用默认 `agent/tree`：对当前 BrainX 工作流没有必要，扩大历史消息读取面。
- 允许 `/model -g`：普通顾问可能影响全员，违反个人配置目标。

## Decision 7：部署必须保留运行时生成的 Agent 与认证

**Decision**: 首次安装才创建 config；升级时使用 OpenClaw 的验证式 patch 更新受管静态字段，不覆盖 `agents.list`、`bindings` 和认证配置。个人认证数据库随 state 独立备份。

**Rationale**: 动态 Agent 会把 Agent 和 binding 写入 OpenClaw config。当前安装器整文件覆盖会在下一次发布删除这些路由，是上线后必现的数据丢失风险。

**Alternatives considered**:

- 每次覆盖后重建：会丢会话模型和可能的路由状态，恢复依赖手工清单。
- 把生产 config 完全交给人工：会让安全策略和工具白名单无法随版本复现。

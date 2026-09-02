# Research: OpenClaw 多顾问生产化

## R1：OpenClaw 插件契约

**Decision**: 固定 OpenClaw `2026.7.1-2`，外部插件用 `openclaw.plugin.json` 声明 `contracts.tools`，入口从 `openclaw/plugin-sdk/plugin-entry` 导入 `definePluginEntry`，schema 使用 `typebox@1.1.39`，打包后以 npm tarball 形态安装。

**Rationale**: 本机锁定安装包和官方文档都明确了这套 manifest、focused SDK import、package install 与 `plugins inspect --runtime --json` 验证方式。发布型外部插件应指向可执行 JavaScript，而不是依赖宿主临时编译 TypeScript。

**Alternatives considered**:

- 继续使用 MCP：无法可靠取得飞书 runtime requester，违反当前 PRD。
- Skill 传 consultant_id：消息和模型都能伪造，不能作为身份边界。
- 把业务逻辑写进插件：会复制 BrainX 授权与领域规则，形成双权威。

## R2：锁定版运行时身份字段

**Decision**: 插件只读取 `requesterSenderId`、`agentAccountId` 或 `deliveryContext.accountId`、`deliveryContext.channel/to/threadId`。`channel` 必须为 `feishu`；`to` 的 `user:` 前缀视为私聊，`chat:` 前缀视为群聊；缺失或未知形状拒绝。

**Rationale**: OpenClaw `2026.7.1-2` 本机 `OpenClawPluginToolContext` 类型实际包含上述字段，但没有新版网页文档提到的 `nativeChannelId`。已存在的真实 Feishu 私聊 session 显示 `deliveryContext={channel:'feishu',to:'user:…',accountId:…}`，可作为固定版本证据。

**Alternatives considered**:

- 读取 session key 文本：内部格式不是稳定安全契约。
- 使用 `senderIsOwner`：只表达 owner 位，不映射 BrainX 顾问和租户。
- 假定 `nativeChannelId` 存在：会在锁定版本得到 undefined，导致错误回退。

## R3：Gateway 网络边界

**Decision**: OpenClaw、原生插件和 Agent Gateway 同机部署，Gateway 仅监听 127.0.0.1:3102；公网只开放 nginx 下的 BrainX Web。

**Rationale**: Feishu 渠道使用出站 WebSocket，不需要把 OpenClaw Gateway 或 Agent Gateway 暴露公网。同机回环 HTTP 可被 systemd 健康检查和测试，且无需新建内部 PKI。

**Alternatives considered**:

- Agent Gateway 公网 HTTPS：扩大攻击面且需要额外认证、WAF 和证书运维。
- Unix socket：安全性更强，但 OpenClaw 插件 fetch 与跨平台安装复杂；回环 + 双认证足够满足本阶段。
- 把 Agent Gateway 合入现有 Web server：混合 Cookie 和服务身份边界，并继续增长超限文件。

## R4：主体声明与重放防护

**Decision**: 使用 Node 内置 crypto 生成 `base64url(canonical JSON).base64url(HMAC-SHA256)`；payload 覆盖 schema、request_id、nonce、channel、account、sender、chat_type、chat_id、thread_id、purpose、issued/expires、tool_name 和 arguments SHA-256。Gateway 还校验固定 bearer 服务 token，并在 SQLite 原子消费 nonce。

**Rationale**: 无新增 BrainX 依赖；签名覆盖身份和请求体；服务 token 与签名密钥分离，便于单独轮换和拒绝非插件调用。

**Alternatives considered**:

- JWT 库：当前只需对称短时声明，新增依赖没有价值。
- 单独 bearer token：不能证明 body 和渠道上下文未被中间层改变。
- 只用时间戳：无法阻止有效期内重放。

## R5：工具与数据投影

**Decision**: 生产只注册 PRD 的 10 个读/计算工具。模型参数 schema 显式 `additionalProperties:false`，不接受 tenant/consultant/sender/scope/url/sql。所有结果经过 Gateway 的统一 envelope 和会话投影。

**Rationale**: OpenClaw 工具策略是纵深防御，不替代 BrainX 授权。服务端固定工具注册表能测试“实际注册集合 = manifest = 配置 allowlist”。

**Alternatives considered**:

- 从 MCP 自动导入：会重新带入写工具和不安全身份参数。
- 由 Skill 决定脱敏：提示词不是安全边界。
- 动态 URL：形成 SSRF 和数据外送风险。

## R6：人才解析策略

**Decision**: reloop 已有结构化档案为第一数据源并使用增量游标；仅当来源只有数字 PDF/DOCX 时，隔离 worker 调固定版本 MarkItDown，输出文本后由 BrainX 结构化/校验。扫描件标为 `OCR_REQUIRED`，首期不自动 OCR。

**Rationale**: 已核实 Mia 账号有 383 份结构化档案，先复用能最快覆盖真实工作；MarkItDown 可处理 PDF/DOCX，但不能把其整套 Resume-Matcher ATS 分数当招聘排序。

**Alternatives considered**:

- 全部重新解析：浪费成本并可能降低已有结构化数据质量。
- 安装完整 Resume-Matcher：引入 UI、ATS 逻辑和无认证后端，边界过大。
- 自写 PDF/DOCX 解析：格式复杂度高，不符合最小实现。

## R7：生产部署与“任意电脑可用”

**Decision**: 继续使用 ECS + systemd + nginx；增加 Agent Gateway、worker、OpenClaw 三个服务单元。顾问端只有飞书与 HTTPS 浏览器，不分发本地代码或数据库凭据。

**Rationale**: 仓库现网权威部署已经是 `/opt/brainx`、`brainx.service`、127.0.0.1:3101 和 `https://base.yorkteam.cn`。复用现网入口比让每位顾问配置 OpenClaw 更安全、可升级、可审计。

**Alternatives considered**:

- 给每位顾问打包本地 OpenClaw：凭据、升级、权限和数据源无法集中控制。
- 生产 Docker Compose：与仓库现网“ECS systemd 唯一正式方案”冲突。
- 公开 OpenClaw Control UI：不属于顾问产品入口并扩大控制面。

## Sources

- OpenClaw 官方 Building plugins、Plugin SDK、Feishu channel、Tools configuration、Sandboxing 和 Security audit 文档（2026-09-03 核对）。
- 本机 OpenClaw `2026.7.1-2` package metadata、`OpenClawPluginToolContext` 类型和真实 Feishu 私聊 session 的脱敏字段形状。
- [当前权威 PRD](../../docs/prd-2026-09-02-openclaw-ai-recruiting-workflow.md)、[部署编排](../../docs/DEPLOYMENT.md)、[候选人数据契约](../../docs/2026-09-03-candidate-data-contracts.md)。

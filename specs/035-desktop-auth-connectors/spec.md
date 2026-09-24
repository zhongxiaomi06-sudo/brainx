# 035 — BrainX 桌面端统一登录与找人连接器

状态：Proposed（2026-09-24；已核实现有 BrainX、OpenMai、Reloop 与本机 Sourcing 0.3.6 边界，尚未实现）

上游：[BrainX × OpenClaw AI 猎头工作流产品需求文档](../../docs/prd-2026-09-02-openclaw-ai-recruiting-workflow.md)、
[Workflow Hub 与猎头全链路架构](../../docs/workflow-hub-architecture.md)、
[安全操作手册](../../docs/SECURITY.md)、
[Server 登录与人才路由边界拆分规格](../026-server-route-boundaries/spec.md)。

## 1. 结论

BrainX 对用户只提供一个产品身份；OpenMai、SuperMai、Reloop、飞书等均是这个身份下的“能力连接”，不得各自再造一套 BrainX 登录。

目标体验为：用户从门户下载已签名客户端，打开后通过系统浏览器进入飞书官方登录页；回到客户端后，在连接中心看到各找人来源的状态。需要个人授权的来源由客户端打开该来源的官方页面，用户亲自完成登录、验证码和授权；组织统一提供的来源直接显示“由组织连接”。机器人与 Web 只消费统一连接状态和任务接口，不接触第三方密码、浏览器 Cookie 或长期密钥。

Chrome 是承载官方页面的浏览器，不是身份提供方。飞书是当前企业主身份；只有出现跨组织用户的明确业务需求时，才增加 Google 等第二身份提供方，不因 Chrome 登录而默认引入 Google 登录。

## 2. 已验证现状与问题

### 2.1 BrainX 登录

- 当前只有飞书 OAuth authorization-code 流程，路由为 `/api/v1/oauth/status|authorize|callback`，登录页仍是服务端内联页面。
- OAuth 回调依赖单个 `BRAINX_BASE_URL`，登录成功后还要把 `open_id` 映射到静态顾问名册并写入 BrainX session。
- 飞书登录、Agent Gateway 身份绑定、TTC/OpenMai 授权和运行进程配置是多套独立操作；用户看见的是“一次登录”，运维实际要完成多次人工开通。
- 当前没有统一的 provider 注册表、连接状态、重新授权、撤销和设备管理接口。

### 2.2 三条找人链路

- **OpenMai**：`brainx_openmai_search` 使用当前顾问的 TTC JWT 调 OpenMai，再由 worker 把结果发回项目群；该链路是真实服务端连接。
- **SuperMai**：现有 `brainx_supermai_scout` 只是把同一 OpenMai 引擎切为 criteria 模式，并未调用已安装的 Sourcing/SuperMai 客户端。
- **Reloop**：`brainx_candidate_shortlist` 从 BrainX 授权下的 MySQL 人才与预计算匹配结果读取；它是组织级服务连接，不应要求每位用户在桌面端重复登录。

### 2.3 本机 Sourcing 0.3.6 的可复用模式

本机应用已经采用“客户端 + 官方网页”的合理交互：客户端账号经 TTC 官方授权页完成；BOSS、脉脉、猎聘由独立 Chrome 会话打开官方页面，用户亲自处理登录和验证码。本地 harness 只监听 loopback，提供健康、浏览器状态、启动/聚焦、任务运行、事件流、响应与停止接口。

当前可见任务契约含 `profile=search`、`mode=direct|agent`、批次、关键词、平台集合和 BrainX ingest 地址；结果按平台批量 ingest，结束时回传 finish，运行中以事件流报告登录、验证码、进度和错误。此模式可作为产品体验参考，但 BrainX 不复制其 renderer `localStorage` token 做法，也不读取其 Cookie 或私有存储。

## 3. 产品分层

### 3.1 下载门户

门户只承担产品说明、客户端下载、版本/签名、更新说明、服务状态和帮助文档。门户不得嵌入长期凭证，也不得要求用户手工复制 token。

最低要求：

- 根据 macOS/Windows 提供签名安装包和校验信息；
- 标明当前版本、最低系统版本和更新策略；
- 登录/连接故障给出可操作状态，不暴露内部密钥或服务地址；
- 下载域名、OAuth 回调域名、更新签名和发布流水线分别受控。

### 3.2 BrainX Desktop Connector

桌面端是设备上的安全代理，不是第二套业务后台。它负责：

- 用系统浏览器完成 BrainX 飞书登录；
- 在系统 Keychain/Credential Manager 保存设备私钥和可刷新会话；
- 注册、命名、撤销当前设备；
- 为需要网页会话的来源维护隔离浏览器 profile；
- 展示连接状态、所需用户动作、任务进度和重新授权；
- 通过出站长连接领取已授权任务并回传规范化结果；
- 仅在 loopback 暴露受安装密钥、Origin 与能力范围保护的本地接口。

### 3.3 BrainX Cloud/API

服务端持有唯一身份、租户、角色、设备、连接元数据、任务和审计事实。它可以保存第三方官方授权后颁发的服务端凭证，但不得保存用户密码或浏览器 Cookie。ECS 永远不得直接调用用户电脑的 `127.0.0.1`。

### 3.4 飞书与 OpenClaw

机器人只负责理解意图、展示确定性卡片并调用 BrainX 工具。工具根据当前身份和项目检查对应连接是否可用；缺连接时返回结构化 `USER_ACTION_REQUIRED` 和安全的打开客户端/连接入口，不让模型索要 token、密码或验证码。

## 4. 统一身份与授权流程

### 4.1 首次登录

1. 用户从门户下载并打开客户端。
2. 客户端生成设备密钥对，点击“用飞书登录”。
3. 系统默认浏览器打开 BrainX 服务端的飞书 OAuth + PKCE 页面；服务端校验 `state`、`nonce`、redirect allowlist 和一次性 challenge。
4. 飞书官方页面完成登录后，只把短时一次性 code 返回客户端的受控 deep link 或随机 loopback callback。
5. 客户端用 code + verifier 换取短时 access token 和可轮换 refresh token，后者存入系统安全存储。
6. 服务端把飞书主体映射为 BrainX identity；未获租户准入时明确显示“等待管理员批准”，不创建半绑定身份。
7. 客户端注册设备公钥，进入连接中心。

Web 登录复用同一个 provider facade，但继续使用安全 HttpOnly session cookie；不把桌面 refresh token 放入网页存储。

### 4.2 连接来源

连接中心每张卡片只显示 `connected`、`action_required`、`expired`、`unavailable`、`organization_managed` 五类用户语义：

- OpenMai：当前先显示组织是否为该顾问授予 TTC/OpenMai 权限；后续若官方支持标准 OAuth，再走服务端授权，不要求复制 JWT。
- SuperMai：检测桌面 harness 与平台浏览器会话；用户点击后打开官方页面完成登录，验证码只在官方页面输入。
- Reloop：显示组织连接、数据新鲜度和当前用户是否有项目/人才读取授权，不提供个人密码框。
- 飞书：作为主身份显示当前账号、租户和重新登录/退出。

退出 BrainX 与断开某个来源是两种动作。断开来源只撤销对应 grant/session；“退出并移除此设备”才撤销设备 refresh token、设备证书和全部本地会话。

## 5. Provider Adapter 契约

所有来源实现同一窄接口：

```text
capabilities(context) -> capability[]
status(identity, device?) -> connection_status
connect(identity, device, return_to) -> user_action
disconnect(connection_id) -> revoked
startSourcing(connection_id, job, criteria, project_context) -> task
events(task_id, cursor) -> event[]
cancel(task_id) -> task
reauth(connection_id, return_to) -> user_action
```

统一状态信封至少包含：

```json
{
  "provider": "supermai",
  "connection_id": "opaque-id",
  "user_ref": "opaque-provider-subject",
  "device_id": "opaque-device-id",
  "state": "action_required",
  "capabilities": ["candidate.search"],
  "needs_user_action": true,
  "action": { "kind": "open_desktop", "target": "brainx://connections/supermai" },
  "last_checked_at": "2026-09-24T00:00:00Z",
  "error_code": null
}
```

禁止把第三方 token、Cookie、密码、原始授权响应、内网地址或任意可访问 URL 放入状态信封。`action.target` 必须由服务端 allowlist 或客户端内建路由生成。

## 6. 任务与结果契约

### 6.1 任务

`sourcing_tasks` 是三条链路的共同事实。每次启动必须包含稳定 `task_id`、tenant、consultant、project/job、provider、criteria 快照、连接/设备引用、幂等键、状态和时间戳。客户端断线、服务重启或飞书重复点击不能创建重复任务。

状态统一为 `queued -> waiting_for_device|waiting_for_user|running -> completed|partial|failed|cancelled`。验证码、重新登录和官方页面确认必须进入 `waiting_for_user`，不能伪装成失败或无限重试。

### 6.2 结果

每条来源结果先保留来源事实，再投影为 BrainX 候选人信封。最低字段包括来源、外部稳定 ID、姓名、公开资料链接、当前公司/职位、城市、年限、学历、技能/标签、经历、采集时间、任务 ID 和原始证据引用。

- 同一 `task_id + provider + external_id` 幂等；
- 来源冲突并存，不用一个来源静默覆盖另一个来源；
- 联系方式继续走独立授权，不随找人结果默认外露；
- 原始 payload 有大小、保留期和访问权限限制；
- ingest、finish、trace 都要求任务级短时 token，finish 后不可继续写入。

## 7. 三条链路的目标实现

### 7.1 OpenMai

第一阶段保留现有服务端 OpenMai 调用，但把 TTC 授权查询封装为 `openmai` adapter，不再让工具直接理解 JWT。连接卡片能区分未获组织授权、凭证过期、配额不足和上游不可用。机器人仍走 `brainx_openmai_search`，内部改为创建统一 sourcing task 后执行。

### 7.2 SuperMai

SuperMai 改为真正的 desktop connector：

- 本地开发可由 BrainX 与 `127.0.0.1:8910` 直接对接；
- 生产由桌面端主动建立到 BrainX 的签名长连接，服务端下发已授权任务；
- BrainX 提供任务级 ingest/finish/trace 端点，桌面端不得携带全局后台密钥；
- 当前支持 BOSS、脉脉、猎聘，并如实报告每个平台浏览器与登录状态；
- `brainx_supermai_scout` 保留工具名作为兼容入口，但必须停止复用 OpenMai criteria 模式。

接入前需要与 SuperMai/Sourcing 明确可依赖的正式协议、版本兼容和更新方式；不得把逆向读取 renderer token、Cookie 或 bundle 私有实现当成生产集成。

### 7.3 Reloop

Reloop 保持服务端 MySQL/服务连接。adapter 校验 tenant、consultant、job/project 授权和数据新鲜度，创建或关联统一任务后读取预计算 shortlist。连接状态为 `organization_managed`，数据库不可用、schema 未就绪或无授权必须 fail closed。

## 8. 数据与 API 边界

### 8.1 最小数据模型

- `identity_accounts`：BrainX 主体与飞书/未来 Google subject 的受控映射；
- `devices`：设备公钥、平台、版本、最后在线、撤销状态；
- `source_connections`：来源、主体/设备引用、状态、能力、到期和最近检查；
- `source_connection_grants`：租户/顾问/项目/能力范围和授权来源；
- `sourcing_tasks`：统一任务、幂等、状态和连接引用；
- `sourcing_task_events`：追加式进度、用户动作和错误；
- `sourcing_results`：来源事实与规范化投影引用。

凭证材料必须进入专用加密 secret store，以 `secret_ref` 引用，不进入以上业务表或日志。

### 8.2 最小 API

```text
GET  /api/v1/auth/providers
POST /api/v1/auth/{provider}/start
GET  /api/v1/auth/{provider}/callback
POST /api/v1/devices/register
GET  /api/v1/connections
POST /api/v1/connections/{provider}/start
POST /api/v1/connections/{connection_id}/disconnect
POST /api/v1/sourcing/tasks
GET  /api/v1/sourcing/tasks/{task_id}
GET  /api/v1/sourcing/tasks/{task_id}/events
POST /api/v1/sourcing/tasks/{task_id}/cancel
POST /api/v1/sourcing/tasks/{task_id}/ingest
POST /api/v1/sourcing/tasks/{task_id}/finish
```

桌面 relay 使用独立设备认证和出站长连接；浏览器 session、机器人 session、设备 token 和 ingest token 不得互换。

## 9. 安全不可削减项

1. 不收集第三方密码，不复制 Cookie，不从其他应用 `localStorage` 抽取 token。
2. OAuth 使用 PKCE、state、nonce、精确 redirect allowlist、一次性 code 和短有效期；禁止开放跳转。
3. 长期秘密放系统安全存储或服务端 secret store；日志、任务、事件和前端状态一律脱敏。
4. 每台设备有独立密钥与撤销能力；服务端可立即吊销单设备或单 provider，不影响其他连接。
5. 本地端口仅绑定 loopback，使用随机安装密钥、Origin allowlist、CSRF 防护和最小能力 token。
6. 官方登录页面必须可见；用户亲自处理验证码、二次认证和服务条款，不做隐蔽绕过。
7. provider 页面、结果文本和候选人资料均为不可信输入，不得变成模型或工具指令。
8. 客户端升级需签名验证、版本下限和紧急停用；服务端有 provider 级 kill switch。
9. 租户、顾问、项目、职位和联系方式授权在每次任务启动与结果读取时重新校验。

## 10. 分阶段迁移

### 阶段 A｜登录 facade 与连接状态

在不改变现有飞书 Web 登录行为的前提下建立 provider registry、统一状态信封和 `/auth/providers`、`/connections` 只读接口；把静态名册、Agent 身份绑定和 OpenMai grant 的差异转成明确状态。此阶段不做桌面安装包。

### 阶段 B｜统一找人任务

建立 task/event/result 与任务级 ingest token。OpenMai 和 Reloop 先迁移到 adapter，但保留现有工具名与卡片行为；重复点击和重启可恢复。

### 阶段 C｜SuperMai 正式连接

先以本地开发模式验证 8910 健康、平台状态、run、SSE、ingest、finish 和取消，再接桌面出站 relay。验收前，旧 `brainx_supermai_scout` 必须清晰标记为 OpenMai fallback，不能宣称已调用 SuperMai。

### 阶段 D｜桌面客户端与门户

以最小原型比较 Tauri 与 Electron：签名/自动更新、系统浏览器回调、Keychain、Chrome profile、崩溃恢复和团队维护成本通过门槛后再选型。随后建设下载门户、版本发布和支持页面。

### 阶段 E｜清理人工开通

把 TTC/OpenMai grant、设备与来源状态移入管理员连接台；逐步停止手工 JWT、静态回调和多进程重启。旧接口在所有活跃用户迁移并可回滚前保持兼容。

## 11. 验收标准

1. 新用户从下载到 BrainX 登录成功不需要复制 token、配置回调地址或运行命令。
2. 飞书官方登录、SuperMai 平台官方页面和组织级 Reloop 状态在同一连接中心可辨认。
3. OpenMai、SuperMai、Reloop 三条工具都创建统一任务并返回真实 provider；SuperMai 不再冒充 OpenMai criteria 模式。
4. 客户端离线、会话过期、验证码、配额不足、上游不可用和无项目授权各有稳定错误码与下一动作。
5. 重复点击、重启、断线重连和 finish 重放不产生重复任务或候选人。
6. 服务端数据库、日志、浏览器存储和飞书消息中均找不到密码、Cookie 或明文长期 token。
7. 单设备、单来源和全账号撤销均可验证；撤销后旧 refresh、relay 和 ingest token 立即失效。
8. 本地与目标环境完成专项、快速、完整门禁；桌面安装、更新、登录、重连和三条真实链路各有可复核证据。

## 12. 非目标

- 不在当前阶段同时建设一个完整公开 SaaS 官网。
- 不为了“统一”把 Reloop 数据库移到用户电脑。
- 不把所有 provider 强行改成浏览器自动化；有标准服务端 OAuth/API 时优先官方协议。
- 不把 Google 登录作为 Chrome 会话的前置条件。
- 不通过读取 SuperMai 私有文件、Cookie 或 renderer token 快速上线。
- 不用聊天里的“已登录”替代设备、连接、授权与真实任务证据。

## 相关文档

- [文档书总目录](../../docs/README.md)
- [上传前完整验证](../../docs/standards/PRE_PUSH_VERIFICATION.md)
- [安全操作手册](../../docs/SECURITY.md)
- [Workflow Hub 与猎头全链路架构](../../docs/workflow-hub-architecture.md)

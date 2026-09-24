# SuperMai 桌面 Relay 运行手册

> 上级入口：[BrainX 文档书](README.md)
>
> 关联规格：[BrainX 桌面端统一登录与找人连接器](../specs/035-desktop-auth-connectors/spec.md) · [安全操作手册](SECURITY.md) · [部署编排](DEPLOYMENT.md)

## 1. 适用范围与当前结论

本文负责 SuperMai 内部灰度链路的安装、部署、验收、撤销和排障。当前实现已把 `brainx_supermai_scout` 从 OpenMai criteria 模式拆开：飞书只创建云端任务，顾问电脑主动领取任务，本机 SuperMai/Sourcing 通过官方 harness 执行 BOSS、脉脉、猎聘搜索，结果再回到 BrainX 和原项目群。

这不是最终签名原生客户端。当前 macOS 连接器是可下载 ZIP 内的常驻 sidecar，复用已安装 Sourcing 的 Bun。它满足内部同事快速配对和线上联调，但尚未完成 Apple 签名、公证、Keychain、自动更新和 Windows 发行；不得对外称为正式桌面发行版。

## 2. 真实拓扑

```text
飞书项目群 / BrainX 工具
  -> ECS Agent Gateway 创建 sourcing_tasks（provider=supermai）
  -> BrainX HTTPS relay 保存任务、租约、事件和脱敏结果
  <- 顾问电脑连接器以设备 token 主动轮询（ECS 不访问用户 localhost）
  -> 本机 127.0.0.1:8910 /api/v1/agent/run
  -> SuperMai/Sourcing 在用户已登录的 BOSS / 脉脉 / 猎聘官方页面执行
  -> 任务级 ingest token 回传候选批次并 finish
  -> openmai_results 兼容投影
  -> brainx-worker 幂等发送 SuperMai 候选卡到原飞书项目群
```

云端不保存招聘平台密码、Cookie、验证码或 Sourcing 私有 token。本机连接器只向生产 HTTPS 根地址出站，并只调用本机 loopback harness。

## 3. 同事首次开通

前置条件：同事已进入 BrainX 组织、飞书身份已映射到本人顾问账号，并已安装 SuperMai/Sourcing macOS 应用。

1. 用同事本人的飞书账号登录 BrainX，打开左侧“连接中心”。
2. 在 SuperMai 卡片点击“生成配对码”。配对码 10 分钟有效，只能使用一次。
3. 点击“下载连接器安装包”，解压 `BrainX-SuperMai-连接器.zip`。
4. 首次运行时右键 `BrainX-SuperMai-连接器.command` 并选择“打开”；输入连接中心显示的配对码。
5. 安装窗口显示连接成功后回到连接中心刷新。设备应显示在线；若 SuperMai 未打开，先打开应用。
6. 在连接中心点击 BOSS、脉脉或猎聘。连接器会让 SuperMai 打开对应官方页面；登录、验证码和二次认证只在官方页面完成。
7. 刷新连接中心。至少一个平台显示已登录后，才能领取该平台的找人任务。

每名同事必须用自己的 BrainX 会话生成配对码、用自己的官方招聘平台账号登录；不得共享配对码、设备 token 或浏览器 profile。

## 4. 找人链路与状态

项目群点击“SuperMai 找人”后，Agent Gateway 创建一个稳定 `sm_` 任务和兼容结果行：

| 状态 | 含义 | 用户动作 |
|---|---|---|
| `waiting_for_device` | 本人没有在线设备 | 打开连接中心并完成配对 |
| `queued` | 设备存在，等待可执行平台 | 打开 SuperMai 并登录至少一个指定平台 |
| `running` | 桌面已领取，30 分钟租约持续心跳 | 保持电脑和 SuperMai 在线 |
| `completed` / `partial` | 已定稿 | worker 自动把结果发回原群 |
| `failed` / `cancelled` | 桌面或上游失败 | 按错误修复后由顾问明确重试 |

同一任务只会下发给该 `consultant_id` 的设备；实际平台集合会收窄到该设备当前已登录的平台。候选人按 `task_id + platform + external_id` 幂等。连接器中断后，租约到期的任务会重新排队并签发新 ingest token，旧 token 失效。

## 5. 云端部署

本次新增 SQLite migration `0060_supermai_desktop_relay.sql`，由 BrainX 进程打开数据库时自动执行。发布前必须备份 `data/brainx.db` 和 `data/.secret`，只部署经过完整门禁的固定 commit。

```bash
cd /opt/brainx
git fetch origin
git checkout <RELEASE_COMMIT>
npm ci
npm --prefix frontend/btex-frontend ci
npm --prefix frontend/btex-frontend run build
systemctl restart brainx-agent-gateway brainx-worker brainx
```

主应用和 Agent Gateway 必须指向同一个 `BRAINX_DB`；主应用必须配置正式 `BRAINX_BASE_URL=https://base.yorkteam.cn`，否则 relay 不会下发 ingest 地址。nginx 需把下列路径原样代理给 BrainX，不能缓存下载或 relay 响应：

```text
POST /api/v1/supermai/pair/claim
POST /api/v1/supermai/relay/poll
POST /api/v1/supermai/relay/report
POST /api/v1/sourcing/tasks/:id/ingest
POST /api/v1/sourcing/tasks/:id/finish
GET  /api/v1/supermai/connector/source
GET  /api/v1/supermai/connector/install
```

## 6. 安全与撤销

- 配对码只存 SHA-256 摘要，64 位随机值，10 分钟一次性使用。
- 设备 token 只在首次认领时返回；服务端只存摘要。本轮 sidecar 以权限 `0600` 保存在 `~/Library/Application Support/BrainX/supermai-connector.json`，最终原生客户端必须迁移到 Keychain。
- ingest token 只绑定单任务和当前租约；定稿、租约过期或重新领取后不能继续 ingest。
- relay 状态只保留版本、忙闲和三平台登录布尔值，不接收 Cookie、密码或原始浏览器数据。
- 单设备撤销使用登录态接口 `DELETE /api/v1/connections/supermai/devices/:id`。当前连接中心尚未提供撤销按钮，内部灰度由管理员或受控 API 执行。
- 遇到身份串用、异常候选写入或设备遗失，先撤销设备，再停用 SuperMai provider；不要删除业务账本掩盖证据。

## 7. 验收清单

### 7.1 自动化

- 配对码未登录拒绝、一次性使用、过期拒绝；
- 设备 token 无效或撤销后 poll/report 拒绝；
- A 顾问设备不能领取 B 顾问任务；
- 只下发已登录平台，不把调用方 URL 传给本机；
- ingest 去重、原始 `raw`/Cookie 不落库；
- finish 重放幂等，定稿后拒绝继续写；
- 断线租约回收，新 token 替代旧 token；
- 桌面失败同步收敛任务和飞书兼容结果；
- 安装 ZIP 包含 UTF-8 文件名和 Unix 可执行位。

### 7.2 目标环境冒烟

1. `GET /api/v1/supermai/connector/install` 返回 `200`、`application/zip` 和 `no-store`。
2. 未携带设备 token 调用 poll 返回 `401 SUPERMAI_DEVICE_UNAUTHORIZED`。
3. 登录同事账号生成配对码并在另一台 Mac 安装；连接中心显示该设备在线。
4. 在官方页面只登录一个平台，确认连接中心只把该平台标为已登录。
5. 从真实项目群启动 SuperMai，确认任务从 `queued/running` 收敛到 `completed|partial`，候选卡标题为 SuperMai 并回到原群。
6. 重复 finish、重复候选批次不产生重复候选或重复卡片。
7. 关闭连接器，确认 90 秒后设备离线；重启后能恢复轮询。
8. 撤销设备后旧 token 返回 401，其他顾问设备不受影响。

没有第 3—8 项的跨设备与真实招聘平台证据时，只能报告“代码和服务器已就绪，等待顾问真机验收”，不能写“SuperMai 全链路已验证”。

## 8. 排障与回滚

| 现象 | 先查 | 处理 |
|---|---|---|
| 下载返回 503 | 主应用 `BRAINX_BASE_URL` | 配置正式 HTTPS 根地址并重启主应用 |
| 配对码无效 | 是否过期、已用、账号是否正确 | 在本人连接中心重新生成 |
| 设备离线 | LaunchAgent、网络、连接器日志 | 重新打开安装包或重启设备；不要复制他人配置 |
| 设备在线但桌面不可用 | Sourcing 是否运行、8910 health | 打开 Sourcing，确认版本与 harness |
| 无平台可领任务 | 官方页面登录状态 | 由本人完成验证码并刷新 |
| 任务长期 running | 心跳、租约、Sourcing state | 等租约回收；确认后再显式重试 |
| 有结果但群里没卡 | `brainx-worker`、项目群绑定、delivery 状态 | 修复投递，不重复启动收费搜索 |

回滚时先停止创建新的 SuperMai 任务，再回退应用 commit。`0060` 的表是 additive，不做破坏性 DROP；保留任务、事件和结果用于审计。已安装连接器应撤销设备授权，而不是只删除本地文件。

## 相关文档

- [BrainX 桌面端统一登录与找人连接器规格](../specs/035-desktop-auth-connectors/spec.md)
- [BrainTex 服务器部署与飞书接入 Agent 完整施工手册](2026-09-03-braintex-server-deployment-agent-manual.md)
- [前端审核台账](frontend-reviews/README.md)
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)

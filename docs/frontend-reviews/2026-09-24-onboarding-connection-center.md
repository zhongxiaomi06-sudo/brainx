# 首次入口与统一连接中心接入记录

> 上级入口：[前端审核台账](README.md)
>
> 关联规格：[BrainX 桌面端统一登录与找人连接器](../../specs/035-desktop-auth-connectors/spec.md)

## 审核身份

- 审核日期：2026-09-24
- Storybook 场景：`入口/首次进入`、`工作台/连接中心`
- 对应 commit：当前实现提交（提交后由 Git 历史固定）
- 审核范围：`/join` 首次入口、工作台常驻“连接中心”、飞书/OpenMai/SuperMai/Reloop 真实状态、SuperMai 设备配对与安装包下载

## 用户结论

- 已确认：用户要求先造出最小链路，并明确优先验证“邀请入口 → 飞书身份 → 工作台 → 来源授权”，暂不先包装完整 Electron 客户端。
- 未确认：用户尚未逐页审核本轮视觉、文案、窄屏表现和 SuperMai 三个平台按钮。
- 正式接入授权：用户已要求完成线上链路供同事自测；允许发布内部灰度的配对、下载、任务与回传链路，不等于批准 Electron/Tauri 终版选型。

## 数据与动作边界

- 真实字段：provider、连接状态、管理方、是否需要用户动作、设备名称/版本/在线时间、SuperMai 桌面可用性和 BOSS/脉脉/猎聘登录状态、Reloop 后端/schema 就绪状态。
- 缺失字段：来源账号名称、Reloop 数据新鲜度、给普通用户的设备撤销按钮和签名原生客户端更新状态。
- 后端依赖：`GET /api/v1/connections`、一次性配对码、设备 relay poll/report、任务 ingest/finish、飞书 OAuth、本机 SuperMai/Sourcing loopback harness。
- 允许动作：刷新状态、进入飞书官方 OAuth、生成一次性配对码、下载连接器 ZIP、打开 BOSS/脉脉/猎聘官方登录页；不收集密码、验证码或 Cookie。

## 状态证据

- 正式入口：`/join`；工作台左侧主导航“连接中心”；设置中心“数据连接”继续跳到同一页面。
- 发布环境与版本：发布待执行；连接中心已接入真实 ZIP 安装包、一次性配对码和云端设备状态，不把 sidecar 称为签名原生客户端。
- 自动验证：前端静态测试 56/56、ESLint、生产构建、Storybook 24 文件 104/104 通过；后端与共享逻辑测试 884/884 通过。
- 真实数据验证：历史本机 Mia 会话已验证四来源状态和 BOSS 已登录；新 relay 的租约、租户/顾问隔离、幂等 ingest/finish 已自动验证。真实项目群、异机安装和真实平台搜索留待用户发布后自测。

## 五状态结论

| Storybook | 用户审核 | 正式接入 | 目标环境发布 | 真实数据验证 |
|---|---|---|---|---|
| 已完成 | 未审核 | 已接入 | 未发布 | 部分验证（本地状态） |

## 未完成项

- [ ] 用户逐页复看桌面、窄屏、文案和三平台按钮。
- [x] 建立 SuperMai task/event/result、设备配对、租约重领、幂等回传和原项目群投递链路。
- [x] 提供内部灰度的 macOS ZIP 安装包与常驻 sidecar，配对时不要求复制长期 token。
- [ ] 建设签名/公证原生客户端、Keychain、自动更新、Windows 安装包和独立下载门户。
- [ ] 在目标环境完成异机安装、真实 BOSS/脉脉/猎聘搜索、断线重连和设备撤销。

## 相关文档

- [前端真实数据重构施工清单](../frontend-refactor-construction-checklist.md)
- [内部 Storybook 组件库](../storybook-component-library.md)
- [上传前完整验证](../standards/PRE_PUSH_VERIFICATION.md)
- [SuperMai 桌面 Relay 运行手册](../2026-09-24-supermai-desktop-relay-runbook.md)

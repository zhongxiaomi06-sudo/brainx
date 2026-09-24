# 首次入口与统一连接中心接入记录

> 上级入口：[前端审核台账](README.md)
>
> 关联规格：[BrainX 桌面端统一登录与找人连接器](../../specs/035-desktop-auth-connectors/spec.md)

## 审核身份

- 审核日期：2026-09-24
- Storybook 场景：`入口/首次进入`、`工作台/连接中心`
- 对应 commit：当前实现提交（提交后由 Git 历史固定）
- 审核范围：`/join` 首次入口、工作台常驻“连接中心”、飞书/OpenMai/SuperMai/Reloop 真实状态和 SuperMai 官方平台登录启动

## 用户结论

- 已确认：用户要求先造出最小链路，并明确优先验证“邀请入口 → 飞书身份 → 工作台 → 来源授权”，暂不先包装完整 Electron 客户端。
- 未确认：用户尚未逐页审核本轮视觉、文案、窄屏表现和 SuperMai 三个平台按钮。
- 正式接入授权：允许以最小链路进入当前本地正式工作台；不代表批准目标环境发布或 Electron/Tauri 选型。

## 数据与动作边界

- 真实字段：provider、连接状态、管理方、是否需要用户动作、最后检查时间、SuperMai 桌面可用性和 BOSS/脉脉/猎聘登录状态、Reloop 后端/schema 就绪状态。
- 缺失字段：设备身份、连接撤销、数据新鲜度、来源账号展示、正式 SuperMai 任务和统一 task/event/result。
- 后端依赖：`GET /api/v1/connections`、`POST /api/v1/connections/supermai/start`、飞书 `/api/v1/oauth/authorize`、本机 SuperMai/Sourcing loopback harness。
- 允许动作：刷新状态、进入飞书官方 OAuth、打开 BOSS/脉脉/猎聘官方登录页；不收集密码、验证码、Cookie 或 token。

## 状态证据

- 正式入口：`/join`；工作台左侧主导航“连接中心”；设置中心“数据连接”继续跳到同一页面。
- 发布环境与版本：仅本地，未发布；当前最小版本复用已安装 SuperMai，不提供虚假的客户端下载按钮。
- 自动验证：前端静态测试 56/56、ESLint、生产构建、Storybook 24 文件 103/103 通过。
- 真实数据验证：本机 Mia 会话显示飞书、OpenMai、SuperMai、Reloop 为 4/4 就绪；BOSS 已登录，脉脉和猎聘等待官方登录。未执行真实找人任务，未验证目标环境。

## 五状态结论

| Storybook | 用户审核 | 正式接入 | 目标环境发布 | 真实数据验证 |
|---|---|---|---|---|
| 已完成 | 未审核 | 已接入 | 未发布 | 部分验证（本地状态） |

## 未完成项

- [ ] 用户逐页复看桌面、窄屏、文案和三平台按钮。
- [ ] 建设签名桌面安装包、设备注册、安全存储、自动更新和下载门户。
- [ ] 建立统一找人 task/event/result，并把 SuperMai 从“登录可启动”推进到真实任务闭环。
- [ ] 在目标环境验证飞书 OAuth 回跳、连接状态、客户端离线和重新授权。

## 相关文档

- [前端真实数据重构施工清单](../frontend-refactor-construction-checklist.md)
- [内部 Storybook 组件库](../storybook-component-library.md)
- [上传前完整验证](../standards/PRE_PUSH_VERIFICATION.md)

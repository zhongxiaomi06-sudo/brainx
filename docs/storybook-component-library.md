# BrainX 内部 Storybook 组件库

> 上级目录：[BrainX 文档书](README.md)

本文是 BrainX 可复用前端组件的展示、交互验证和维护入口。组件库直接引用生产组件，不维护第二套演示实现，也不连接生产 API 或真实用户数据。

## 当前收录范围

| 分组 | 生产组件与状态 |
|---|---|
| 基础控件 | 标题、状态标签、抽屉区块、筛选下拉、分段切换 |
| 业务组件 | 机会列表、精选盘、推荐预览、文件夹、事实编辑、判断规则 |
| 承接流程 | 接单、进展、阻塞、终局、释放、已承接行动 |
| 辅助交互 | Dino 游戏 |

整页工作台、根布局、错误边界、真实鉴权、SSE、后端联动和路由不属于组件隔离环境，继续由前端静态测试与浏览器前后端链路覆盖。

## 使用命令

从仓库根目录执行：

    npm run storybook
    npm run storybook:test
    npm run storybook:build

开发服务默认使用 6006 端口。静态构建输出到前端目录下的 `storybook-static/`，该目录是本地产物，不得提交。

## 新增与维护规则

1. story 放在 `frontend/btex-frontend/app/stories/`，命名为 `*.stories.tsx`。
2. 必须导入真实生产组件；仅允许用轻量 harness 管理属性、回调和本地状态。
3. 不请求生产接口，不写入真实数据库，不放入账号、密钥或客户数据。
4. 新的业务组件至少提供默认状态和一个空、异常或边界状态；关键按钮使用 `play` 验证真实交互。
5. Storybook 使用独立 Vite 配置，不加载 Vinext、React Server Components 或 Cloudflare 部署插件。
6. 可访问性面板始终启用。现有浅色视觉体系的对比度问题暂记为警告；新增组件不得通过关闭 a11y 插件隐藏问题。

## 验证与边界

完整质量门禁会执行所有 story 的浏览器交互测试，并生成可部署的静态 Storybook。测试复用系统 Chrome；本地或 CI 缺少 Chrome、无法监听回环端口时应明确失败。

当前已确认的存量风险是浅绿色强调文字、浅灰辅助文字和部分浅色标签未达到自动化对比度阈值。这些结果会保留在 A11y 面板中，后续应以统一调色板迁移修复，不能逐个 story 静默豁免。

## 相关文档

- [质量门禁操作手册](standards/QUALITY_GATE_OPERATIONS.md)
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)
- [BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md)
- [Agent Commit 记录](AGENT_COMMIT_LOG.md)

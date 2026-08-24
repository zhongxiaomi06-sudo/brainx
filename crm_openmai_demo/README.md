# CRM → OpenMai Demo

这是一套只在当前浏览器页面内运行的集成 Demo：

1. 通过 TTC 统一授权页完成飞书扫码或已有账号登录。
2. 输入当前顾问有权限查看的 CRM `job_id`。
3. Demo 从 CRM 读取职位信息，调用 OpenMai 普通会话接口，并展示最终会话结果。

Demo 不修改 CRM 或 OpenMai，不调用 OpenMai 管理员接口，也不在关闭页面后继续后台执行。

## 启动

安装 Node.js 18 或更高版本。解压后进入 Demo 目录运行：

```bash
cd crm_openmai_demo
node demo_server.mjs
```

然后打开：

```text
http://127.0.0.1:3210
```

默认连接生产环境。连接集成环境：

```bash
DEMO_ENV=integration node demo_server.mjs
```

如需修改端口：

```bash
DEMO_PORT=3211 node demo_server.mjs
```

本 Demo 不依赖 `consultant_agent` 仓库，也不需要安装 npm/yarn 依赖。

## 调用链

```text
浏览器飞书登录
  → TTC WEB JWT
  → POST /api/crm/v1/openmai/jobs/detail
  → POST /api/openmai/v1/completions
  → SSE 会话结果
  → 如转为异步任务，则在页面内查询 async-status 直到结束
```

## 安全边界

- Token 仅保存在浏览器 `sessionStorage`，关闭该浏览器标签页后失效。
- 本地 Node 服务只负责同一次请求的上游转发，不保存、不打印 Token。
- 本地服务只监听 `127.0.0.1`，并校验浏览器请求来源。
- 关闭页面会中断当前请求，不继续后台执行。
- CRM 职位可见性和 OpenMai 能力完全沿用当前登录顾问已有权限。

## 可配置上游

通常不需要修改。若用于本地联调，可通过以下环境变量覆盖固定上游：

- `DEMO_AUTH_URL`
- `DEMO_CRM_API_BASE_URL`
- `DEMO_OPENMAI_API_BASE_URL`

# BrainX 部署编排

> 上级：[文档书总目录](README.md) · 生产恢复：[云端恢复清单](cloud-recovery-checklist.md) · 安全配置：[安全操作手册](SECURITY.md)

## 应用拓扑

BrainX 是后端统一代理前端的一体化应用：

```text
浏览器 ──▶ src/server.js (node:http)
            ├─ /api/v1/*：SQLite / 可选 MySQL / 飞书 / TTC / 服务端 LLM
            └─ 其它路径：反向代理到 vinext 前端子进程（默认 4321）
```

后端会启动前端子进程，因此生产不需要 docker-compose。前端构建生成的 `wrangler.json` 由 vinext 管理；不要手写 `wrangler.toml`。若未来部署 Cloudflare Workers，应修改 `vite.config.ts` 的绑定源头。

## 生产：ECS + systemd（唯一正式方案）

现网固定口径：

- `/opt/brainx`
- `brainx.service`
- 应用监听 `127.0.0.1:3101`
- nginx 对外提供 `https://base.yorkteam.cn`

```bash
cd /opt/brainx
git fetch origin
git pull --ff-only
npm ci
npm --prefix frontend/btex-frontend ci
npm --prefix frontend/btex-frontend run build
systemctl restart brainx
systemctl status brainx --no-pager
curl -fsS https://base.yorkteam.cn/api/v1/meta/guard
```

禁止在这台生产机启动 BrainX Docker 容器或执行 `scripts/deploy-ecs-docker.sh`。详细排障、端口确认和历史事件见[云端恢复清单](cloud-recovery-checklist.md)。

## 本地开发

```bash
npm ci
npm --prefix frontend/btex-frontend ci
npm run dev
```

默认后端为 3000、前端子进程为 4321；本地端口不代表生产端口。

## Docker：只用于隔离测试

Docker 镜像继续由 CI 构建，用于验证镜像可运行。若开发者需要本机测试，必须使用独立端口和数据卷：

```bash
docker build -t brainx:test .
docker run --rm -p 3300:3000 --env-file .env -v brainx-test-data:/app/data brainx:test
```

不要把生产 `/opt/brainx/data`、`/root/.lark-cli` 或宿主机 CLI 挂入测试容器，也不要让测试容器监听生产 3101。

## CI

`.github/workflows/ci.yml` 对 push 和 PR 执行后端测试、前端构建与 Docker 镜像构建；镜像构建只做验证，不等于生产发布。

## 环境变量

运行前准备 `.env`（已被 `.gitignore` 排除，永不提交）：

| 变量 | 用途 |
|---|---|
| `BRAINX_PORT` / `BRAINX_HOST` | 后端监听地址；生产由 systemd 设置为 3101 / 127.0.0.1 |
| `BRAINX_FRONTEND_PORT` | 前端子进程端口，默认 4321 |
| `BRAINX_MYSQL_*` | 阿里云 RDS 人才库连接 |
| `BRAINX_FEISHU_*` | 飞书应用与授权配置 |
| `BRAINX_LLM_*` | 服务端统一模型配置；密钥不得下发浏览器 |

## 上线安全清单

- [ ] `npm run verify` 通过，质量报告结论为“通过”
- [ ] `.env` 权限为 600，未进入 Git、镜像或日志
- [ ] RDS 使用专库最小权限账号，白名单只允许 ECS，外网连接启用 SSL
- [ ] `data/.secret` 与数据库分别做加密备份，恢复流程已验证
- [ ] 只有 `brainx.service` 监听 3101，nginx upstream 与 HTTPS 健康检查正常

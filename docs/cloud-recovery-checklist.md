# 云端恢复清单与事件记录

> 上级：[文档书总目录](README.md) · 部署权威说明：[部署编排](DEPLOYMENT.md) · 安全与密钥：[安全操作手册](SECURITY.md)

## 当前生产形态（唯一有效口径）

BrainX 生产环境是阿里云 ECS 上的 **systemd 宿主机进程**，不是 Docker：

- 代码目录：`/opt/brainx`
- 服务单元：`brainx.service`（`Restart=always`）
- 应用端口：`127.0.0.1:3101`
- 对外入口：`https://base.yorkteam.cn`，由 nginx 反向代理到 3101
- 运行用户：root；`lark-cli` 使用 `/root/.lark-cli` 配置

现有生产机禁止运行 `scripts/deploy-ecs-docker.sh` 或启动名为 `brainx` 的容器。旧容器与 systemd 会争抢 3101，造成 `EADDRINUSE`、重复守护和负载异常。Docker 只允许在与生产端口、数据卷完全隔离的测试环境使用。

## 标准发布与恢复

```bash
cd /opt/brainx
git fetch origin
git pull --ff-only
npm ci
npm --prefix frontend/btex-frontend ci
npm --prefix frontend/btex-frontend run build
systemctl restart brainx
systemctl status brainx --no-pager
journalctl -u brainx -n 100 --no-pager
curl -fsS https://base.yorkteam.cn/api/v1/meta/guard
```

发布前按[上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)执行完整门禁。`.env` 和 `data/.secret` 不随 Git 更新；恢复密钥时按[安全操作手册](SECURITY.md)操作。

如果服务重启失败，依次确认：

1. `ss -ltnp | grep 3101` 只有 `brainx.service` 对应进程监听；
2. `systemctl status brainx` 与 `journalctl -u brainx` 没有 `EADDRINUSE`、依赖缺失或环境变量错误；
3. nginx upstream 仍指向 `127.0.0.1:3101`；
4. 本机 `curl http://127.0.0.1:3101/api/v1/meta/guard` 与域名 HTTPS 均返回成功；
5. `data/brainx.db`、`data/.secret` 的所有者和权限允许服务读取。

## 当前遗留事项

1. york-ai 机器人缺少职位盘点 Bitable 权限：飞书错误 `91402 NOTEXIST`；需把应用加入目标 Base 协作者。
2. systemd 停止旧前端子进程偶尔超时：评估为 unit 增加 `KillMode=mixed`，并验证 vinext 子进程能退出。
3. 观察定时推送窗口：确认 `push_log` 成功，失败时应记录可读飞书错误而非命令回显。
4. retention 周度例行化：cron 先 dry-run，计数进入 guard，再执行保留策略。

TTC `-90429` 已通过单顾问轮询、页间节流和限流 fail-fast 治理；若再次出现，应检查租户配额和 journal 退避日志，不要提高并发重试。

## 数据溢出处置记录（2026-08-24）

- 一致备份：`/opt/brainx/data/brainx-backup-preretention-20260824.db.gz`
- retention：recommendations 从 1,684,390 行降到 110,970 行
- checkpoint + VACUUM：`brainx.db` 从 3.4G 降到 267M，系统盘从 100% 降到 63%
- 后续要求：保留定期 retention、磁盘水位告警和恢复演练，不允许依赖临时镜像清理维持容量

## 历史事件（只作复盘，禁止照此恢复）

2026-08-20 至 08-24，旧 Docker 容器和新 systemd 实例同时守护 3101，导致端口竞争；旧容器又缺少宿主机 `lark-cli`，造成定时推送失败。3100 同期已经废弃，旧探针继续访问 3100 才误报“云端不可达”。

当时使用过“把宿主机 CLI 和配置挂入容器”的临时思路现已废弃。恢复生产只按本文件的 systemd 流程执行，不重建旧容器、不挂载宿主机 CLI、不使用 3100 入口。

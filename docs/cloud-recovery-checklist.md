# 云端排查结论与恢复清单（2026-08-25 更新：13 项审计修复已部署）

## 2026-08-25 部署记录（13 项审计修复）

- 代码：PR #10 合并，云端 `6de4292`（= origin/main），前后端依赖重装 + vinext build + systemctl restart；
- 生产验证：journal 可见 `[bridge]` 错误日志（B3）、退避提示（B2）、sync_runs 落 7 行 bridge-error（B3）；
  API/域名 200；TTC -90429 仍在（上游限流，退避已止血我方加重行为）；
- B1 修复：`BRAINX_LARK_PROFILE=york-ai`（.env），lark-cli 发信应用 = OAuth 应用 cli_aaf72a91，跨应用 99992361 消除。

## 遗留事项（需人工/协调）

1. **york-ai 机器人无职位盘点 Bitable 权限**：实测 91402 NOTEXIST——需在飞书把 york-ai 应用加为该 Base 协作者
   （当前走用户令牌直连兜底，bot 兜底通道缺失）；
2. ~~TTC -90429 错峰~~ **已根治（2026-08-25 `880997c`）**：复盘确认我方是主要压力源——旧实现每 tick 6 JWT × ~91 页 ≈ 546 请求/180s ≈ 180 req/min（reloop 用 100条/页，效率高得多）。修正：单顾问轮询（6×↓）+ 分页 120ms 节流 + 限流 fail-fast（outage 期再 6×↓）→ 正常期 ~15 req/min（-92%）。生产已验证 fail-fast 生效，待租户配额窗口恢复后自动回位（成功才推进 ttc_rr 游标）；
3. **systemd 停止超时**：restart 时旧进程需 SIGKILL（前端 vinext 子进程不转发 SIGTERM），可在 unit 加 `KillMode=mixed`；
4. **19:00 CST 推送窗口**：观察 push_log 验证 B1/B4（错误应变为可读 Feishu 报错而非命令回显）。

## 当前生产形态（重要，2026-08-24 确认）

**生产 = systemd 宿主机实例**，不再是 docker：
- `brainx.service`（Restart=always）跑 `/opt/brainx/src/server.js`，端口 **3101**，nginx 反代 `https://base.yorkteam.cn`；
- HOME=/root → lark-cli 可用（容器时代 `spawnSync lark-cli ENOENT` 的推送失败应随之消失，观察 19:00 推送窗口确认）；
- docker `brainx` 容器已手动停止（unless-stopped 策略下不会自启）。**不要再跑 `scripts/deploy-ecs-docker.sh`**——会与 systemd 抢 3101。今后部署 = `/opt/brainx` git pull + `systemctl restart brainx`；
- 08-20 的"重部署"实为切 systemd，但容器没停 → 两套守护抢端口 2 天（systemd 每 10s 撞 EADDRINUSE），这是负载偏高与"服务异常"体感的来源。

## 数据溢出处置记录（2026-08-24 已执行）

- 备份：`/opt/brainx/data/brainx-backup-preretention-20260824.db.gz`（297M，VACUUM INTO 一致快照）
- 清空：`bin/brainx-retention.mjs --apply`（提案 §B 规则），recommendations **1,684,390 → 110,970**（删 93.4%）
- 回收：停容器窗口内 checkpoint + VACUUM，**brainx.db 3.4G → 267M，磁盘 100% → 63%**
- 第一段审计（清空后副本，本机 data/brainx-cloud.db）：feedback=34、人类事件=144、outcomes=1；Top20 标签缺口 123/140（felix 7✓ shanon 9✓ mia 1✓，otto/york/wendy/linda 0）；诊断：similarity 100% 缺失（F1 未部署）、outcomes 86.8% 缺失、天花板效应未触发（24.9%）

## 待办（按序）

1. **部署 F1-F4 + 方案 A（生成节流）**：`/opt/brainx` git pull + 补 `BRAINX_FEEDBACK_SECRET` + `systemctl restart brainx`。方案 A 不上，库仍以 ~0.6G/天 涨（当前余量约 11 天）；
2. **打标下发**：`npm run label:export -- --db data/brainx-cloud.db` 生成标注表，按缺口矩阵只补 123 个坑；
3. **确认 19:00 推送恢复**（systemd 实例 lark-cli 可用性验证）；
4. retention 周度例行化（cron + dry-run 计数上报 guard）。

## 排查结论：云端从未"不可达"，是入口变了 + 三个独立故障叠加

| 现象 | 真相 |
|---|---|
| 3100 不可达 | 08-20 15:31 有人重新部署：容器端口 3100→**3101**，nginx 反代已切到 `https://base.yorkteam.cn → 127.0.0.1:3101`。旧入口 3100 废弃，但仓库 docs/健康简报仍在探测 3100 → 误报"云端挂了" |
| SSH 22 一度超时 | 已恢复（当时抖动或实例短暂异常）；当前主机 uptime 4 天、SSH/80/443 正常 |
| 定时推送连续 FAILED（08-23 起全 6 人） | **容器里没有 lark-cli**（`spawnSync lark-cli ENOENT`）。lark-cli 装在宿主机 `/usr/local/bin`，配置在 `/root/.lark-cli`；新容器只挂载了 data 目录 |
| 系统盘 100% | docker 镜像 6.9G + brainx.db 3.4G + WAL 533M 撑爆 20G 盘。**已于 08-24 处置**：journal vacuum + docker 日志截断 + WAL checkpoint + 镜像 prune → 降至 78%（4.2G 可用） |

## 已完成的处置（2026-08-24）

- [x] 磁盘 100% → 78%（journal 50M 上限、container 日志截断、`PRAGMA wal_checkpoint(TRUNCATE)` 533M→8K、`docker image prune -a` 回收 966M）
- [x] 确认服务健康：`https://base.yorkteam.cn/api/v1/meta/guard` 服务器侧 200

## 待办（按序）

1. **修推送（核心）**：重建容器时补三个挂载，让容器内可用宿主机的 lark-cli：
   ```bash
   # 在原 docker run 参数基础上追加（原参数用 docker inspect brainx 提取）：
   -v /usr/local/lib/node_modules/@larksuite:/usr/local/lib/node_modules/@larksuite:ro
   -v /usr/local/bin/lark-cli:/usr/local/bin/lark-cli:ro   # 注意这是符号链接，需挂真实路径
   -v /root/.lark-cli:/root/.lark-cli
   # 验证：docker exec brainx lark-cli --version，然后等下一个推送窗口看 push_log
   ```
   长效方案：把 `npm i -g @larksuite/cli` 写进 Dockerfile，彻底摆脱宿主机依赖。
2. **部署 F1-F4 修复**（本地已交付、253 测试全绿）：云端仓库拉最新代码重建镜像；`.env` 补 `BRAINX_FEEDBACK_SECRET=<openssl rand -hex 32>`。
3. **拉取生产库 + 打标审计**：`npm run data:pull`（脚本已兼容容器内无 sqlite3 的情况——若 .backup 失败，改走 `docker exec node -e` 在线备份或直接 gzip 宿主机库文件后拉取）。
4. **更新文档中的端口**：所有 3100 引用 → 3101 / base.yorkteam.cn（本机探测走代理时 TLS 会断，属本地代理问题，非云端故障）。
5. **DB 增长治理**：bridge 每 180s 全量冻结候选池，recommendations 已 164 万行（3.4G 主因）。建议 recommend() 只在 input_hash 变化时冻结，或加 recommendations  retention（保留最近 N 轮 + 有事件关联的行）。单独立项，不在本次修复内。

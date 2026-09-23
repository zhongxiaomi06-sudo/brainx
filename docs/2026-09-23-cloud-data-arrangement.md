# 云端数据安排（阿里云账号 1615281587880079）

> 上级目录：[BrainX 文档书](README.md)
>
> 适用范围：BrainX 项目全部云端资源的归属、用途与治理顺序。与 [数据结构与磁盘用途规范](2026-09-23-data-structure-and-disk-layout.md) 配套——那篇管「实例内」，本篇管「云账号内」。

## 1. 资源盘点（2026-09-23 CLI 实测）

| 资源 | 实例 | 现状 |
|---|---|---|
| ECS | i-bp1dgg3rzmehc33fwpsn（launch-advisor-20260616，ecs.g7.large 2C8G，47.110.93.137） | 生产唯一宿主机；20G 系统盘 + 40G 数据盘（已挂载）；RAM 角色 BrainXEcsOssBackup 已绑 |
| RDS MySQL 8.0 | rm-bp12ok9so2ma3i3j7（mysql.n2e.medium.1） | **7 个库**：brainx / recruit_bot / reloop / reloop_app / ttc_talent / york / zxm；**5 个账号**：hayden（**Super 超管**）、recruit_bot、app_bot（无库权限）、ttc_reader、ttc_sync |
| OSS | brainx-backups-yorkteam-93f137（今日建，备份） | 私有，RAM 角色可写 |
| OSS | ot-resume-archive-yorkteam-93f137（7/20 建） | 简历归档，RAM 用户 ot-plugin-oss-writer |
| RAM | 用户 ot-plugin-oss-writer；角色 BrainXEcsOssBackup | — |
| 密钥面 | 本机 root AK（全量权限，调度用）；服务器 dms/recruit_admin 两 profile 已死 | root AK 权限过大，见 §3-4 |

## 2. 目标数据安排（每域一属主，禁止多写者）

| 数据域 | 归属资源 | 写者（唯一） | 读者 |
|---|---|---|---|
| 决策主库（职位/推荐/账本/草稿/指标） | ECS 数据盘 SQLite | BrainX 后端服务 | 各服务 + 只读副本 |
| 每日快照 | 数据盘 backups + OSS brainx-backups-* | brainx-backup.timer | 恢复演练 |
| 人才/候选人库 | **RDS reloop 库** | reloop 同步 worker | brainx 各读路径 |
| 简历原文归档 | OSS ot-resume-archive-* | ot-plugin-oss-writer | 按需 |
| 配置与密钥 | /etc/brainx/*.env（实例内）+ RAM 角色 | 运维人工 | 服务 |

## 3. 错乱点清单（按严重度）

1. **生产用 hayden（Super）连 RDS**——超管账号可读写全部 7 个库，违背 constitution 1.0.1「三账号分离」与 DEPLOYMENT 检查项「专库最小权限」。这是当前最大的权限错乱。
2. **RDS 单实例 7 库混居**：reloop 是生产人才库；其余 6 库 2026-09-23 确权数据如下——

   | 库 | 表数 | 行数 | 最后写入 | 初步判断 |
   |---|---|---|---|---|
   | brainx | 18 | 4 | 2026-09-03 | 近空，遗留试验 |
   | recruit_bot | 6 | 78,851 | 2026-06-18 | 有真实数据但休眠 3 个月，删前必须导出 |
   | reloop_app | 13 | 13,787 | 2026-09-16 | **近期仍被写**，归属待查（疑似 reloop 应用侧） |
   | ttc_talent | 26 | 2,218 | 2026-08-26 | 休眠近 1 个月 |
   | york / zxm | 0 | 0 | — | 空壳占位 |

   删除任一库前必须 mysqldump 导出到 OSS 并 ⚑ 拍板。
3. **AK 散落**：本机 root AK 全量权限（日常调度不该用 root）；服务器两个死 profile（dms 空 OAuth、recruit_admin 占位符 AK）；简历桶另有 ot-plugin-oss-writer。
4. **app_bot 无任何库权限**——疑似孤儿账号。

## 4. 治理顺序（待拍板项标 ⚑）

1. **RDS 三账号分离**（执行 constitution 1.0.1，reloop 库范围）：
   - `brainx_agent_ro`：reloop 只读（Agent 查询路径）；
   - `brainx_sync_rw`：reloop 最小 DML（确定性同步 worker）；
   - DDL 仅用临时账号，用完即删；
   - 应用 env 从 hayden 切到上述账号后，**hayden 降权/停用 ⚑**（影响面：当前所有连 reloop 的进程，需灰度）。
2. **库确权**：逐个核对 6 个非 reloop 库的最后写入时间与表内容，分「保留 / 归档导出后删除 ⚑」两档——删除前必须 mysqldump 导出到 OSS。
3. **AK 治理**：建 RAM 子账号 `brainx-automation`（仅 ECS/RDS/OSS 只读 + OSS 备份桶写）替代日常 root AK 调度；root AK 封存 ⚑。
4. **app_bot 停用 ⚑**（确认无引用后）。
5. 资源命名收口：新建资源一律 `brainx-*-yorkteam` 前缀，登记到本篇 §1 表。

## 5. 调度纪律（AI 操作本账号的规则）

- 已连接：本机 aliyun CLI（root AK，可调度全部资源）。操作顺序一律：**只读盘点 → 方案 → 拍板 → 执行 → 验证留痕**。
- 不替人做的事：删库、删 bucket、停用账号、改安全组/公网、降权 hayden——必须先 ⚑ 拍板。
- 密钥不打印、不跨机复制；root AK 不写到任何服务器。

## 相关文档

- [数据结构与磁盘用途规范](2026-09-23-data-structure-and-disk-layout.md)
- [数据治理运维手册](2026-09-23-data-governance-ops.md)
- [安全操作手册](SECURITY.md)
- [部署编排](DEPLOYMENT.md)

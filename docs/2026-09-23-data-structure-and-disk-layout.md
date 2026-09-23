# 数据结构与磁盘用途规范

> 上级目录：[BrainX 文档书](README.md)
>
> 适用范围：BrainX 全量数据的结构归属、磁盘放置、命名与生命周期。任何新增数据文件/表/库之前先查本规范；与本规范冲突的既存形态以[数据治理规格](../specs/021-data-governance/spec.md)为准逐步收编。

## 1. 数据域总表（唯一权威）

| 数据域 | 载体与位置 | 结构权威 | 生命周期 |
|---|---|---|---|
| 决策主库 | SQLite `数据盘:/opt/brainx/data/brainx.db`（WAL） | `migrations/0001-0053`（schema_migrations 逐文件记账） | 唯一活库；高热表按 §3 窗口 retention |
| 事件账本 | 主库内 `workflow_event_log` + `processed_events` + `consumer_failures` | specs/001、[specs/019 事件契约](../specs/019-hub-event-backbone/contracts/event-types.md) | append-only；90 天窗口归档（只搬不删，引用保护） |
| 消息原文 | 主库内 `lark_messages`（含 PII） | migrations/0030 | 90 天窗口归档；任何导出物不得进 Git |
| 抽取/判断草稿 | 主库内 `job_facts_drafts` / `judgment_drafts` | migrations/0031/0051 | pending→confirmed/rejected 终态；缺关键字段不落 staging（规则见 §4） |
| 反馈指标 | 主库内 `feedback_metrics` | [specs/019 指标口径](../specs/019-hub-event-backbone/contracts/event-types.md) | append-only 快照，同窗重算追加不改写 |
| 人才库 | RDS MySQL `reloop`（hayden 账号） | brainx-talent 技能/相关迁移 | 外挂独立实例，不进 SQLite |
| 每日快照 | `数据盘:/opt/brainx/data/backups/brainx-YYYYMMDD-HHMMSS.db` | bin/brainx-backup.mjs | 本地滚动 14 天 |
| OSS 远端备份 | `oss://brainx-backups-yorkteam-93f137/brainx-backups/` | bin/brainx-oss-sync.mjs | 全量留存永不删除；冷热分层交 bucket 生命周期 |
| 归档区 | `数据盘:/opt/brainx/data/archive/` | bin/brainx-ledger-retention.mjs | 长期只读；`legacy-*` 子目录存历史遗留归置 |
| 本地副本 | 开发机 `data/brainx.db` | scripts/pull-cloud-data.mjs 刷新 | **只读训练/诊断用，不是备份**；定期重拉，不长期留存 |

## 2. 磁盘用途铁律

1. **系统盘（20G vda3）只放 OS + 代码 + 配置**。`/opt/brainx` 仓库根目录禁止落数据文件（备份、临时脚本、导出物一律不得放这里）。
2. **数据盘（40G vdb，`/opt/brainx/data`）放全部 BrainX 数据**：活库、WAL、快照、归档、archive。
3. **一个活库**：生产只认 `brainx.db`。任何进程不得用第二个库文件名（`brainx.sqlite` 事故形态：空 schema 库 + 漂移 WAL，已归置 `archive/legacy-20260923/`）。
4. **备份必须出盘出机**：本地快照在数据盘，每日 03:47 同步 OSS；系统盘上存在超过 24 小时的数据快照视为误用。
5. **密钥与 PII**：密钥只进 `/etc/brainx/*.env`（不落仓库、不落 aliyun config 之外的文件）；含 PII 的导出物只进 `data/` 且不进 Git。
6. **RDS 只走专库账号**（reloop/hayden），白名单仅 ECS，SSL 开启。

## 3. 保留窗口（与 specs/021 一致）

| 表 | 窗口 | 执行 |
|---|---|---|
| lark_messages | 90 天（create_time） | brainx-ledger-retention（周日 04:23，dry-run 可预审） |
| workflow_event_log | 90 天（occurred_at，引用保护） | 同上 |
| openmai_results | 180 天 | 同上 |
| recommendations 系 | 既有规则 | bin/brainx-retention.mjs（既有） |
| 本地快照 | 14 天滚动 | brainx-backup.timer（每日 03:17） |

## 4. 草稿落库纪律（第一批清洗教训转正）

- 抽取草稿：**company 与 role 双缺即 skip 不落 staging**（job 域待补此规则；judgment 域已是 statement=null 即 skip）。
- 系统清洗一律置 `rejected` 并标 `system:cleanup-*`，不发评审事件（保指标口径），执行前必须留快照。

## 5. 2026-09-23 归置记录

- `data/brainx.sqlite{,-shm,-wal}`（9/10 误开的空 schema 库）→ `archive/legacy-20260923/`；
- 仓库根 `/opt/brainx/backups/`（演示脚本备份 + 灰测产物）→ `archive/legacy-20260923/repo-root-backups/`；
- 仓库根 `diag-fact.tmp.mjs`（直连 MySQL 的临时诊断脚本）→ 同上；
- 未动：`bin/ttc-multi-pull.mjs`、`deploy/openclaw/sandbox/`（他人未跟踪工具，待属主认领）；服务器本地删除态 `scripts/demo-offer-seed.mjs`（等属主处理）。

## 相关文档

- [数据治理规格](../specs/021-data-governance/spec.md)
- [数据治理运维手册](2026-09-23-data-governance-ops.md)
- [Hub 事件骨干重整规格](../specs/019-hub-event-backbone/spec.md)
- [安全操作手册](SECURITY.md)

# 数据治理运维手册：备份与高热表保留/归档（specs/021）

> 上级目录：[文档书总目录](README.md) ｜ 规格：[specs/021-data-governance](../specs/021-data-governance/spec.md)

本文是生产 SQLite 决策库（ECS `/opt/brainx/data/brainx.db`，WAL）备份与高热表保留/归档的唯一操作口径。实现：`bin/brainx-backup.mjs`、`bin/brainx-ledger-retention.mjs`、`deploy/systemd/brainx-backup.{service,timer}`、`deploy/systemd/brainx-ledger-retention.{service,timer}`。

## 1. 备份（每日自动快照）

- **计划**：`brainx-backup.timer` 每日 03:17 触发 `brainx-backup.service`（`Persistent=true`，停机期间漏跑会补跑）。
- **方式**：`VACUUM INTO` 在线一致性快照（WAL 安全），源库以只读连接打开，对生产零写入。**禁止直接 `cp` 数据文件**（WAL 下会拿到撕裂副本）。
- **产物**：`$BRAINX_BACKUP_DIR/brainx-YYYYMMDD-HHMMSS.db`（缺省 `data/backups/`；生产建议在 `/etc/brainx/worker.env` 把 `BRAINX_BACKUP_DIR` 指到异盘目录，对应 FR-002）。
- **自检**：每次快照后脚本只读打开产物，`PRAGMA quick_check` 必须全 ok，且 `workflow_event_log` / `lark_messages` / `job_facts` 行数与源库一致，否则判失败并删除半成品。
- **滚动保留**：按文件名日期删除超过 `BRAINX_BACKUP_KEEP_DAYS`（默认 14）天的旧快照。
- **重叠保护**：`.backup.lock`（O_EXCL）。已有实例在跑时退出码 **75**（EX_TEMPFAIL），不算故障。

### 手动触发一次备份

```bash
sudo systemctl start brainx-backup.service
# 或本地/排障直接跑：
node bin/brainx-backup.mjs   # stdout 打一行 JSON 摘要
```

### 恢复演练（验收 SC-002：从快照到可只读打开 < 10 分钟）

```bash
# 1. 选定快照（切勿直接覆盖生产库，先落地为新文件）
SNAP=$(ls -t /opt/brainx/backups/brainx-*.db | head -1)

# 2. 只读打开校验：完整性 + 表计数
sqlite3 "file:$SNAP?mode=ro" 'PRAGMA quick_check;'
sqlite3 "file:$SNAP?mode=ro" \
  'SELECT (SELECT COUNT(*) FROM workflow_event_log),
          (SELECT COUNT(*) FROM lark_messages),
          (SELECT COUNT(*) FROM job_facts);'

# 3. 确认可用后，停服务再替换（会中断生产读写，须选维护窗）
sudo systemctl stop brainx.service brainx-dispatcher.service brainx-backup.timer
cp "$SNAP" /opt/brainx/data/brainx.db
rm -f /opt/brainx/data/brainx.db-wal /opt/brainx/data/brainx.db-shm   # 旧 WAL/SHM 属旧库，必须清掉
sudo chown brainx:brainx /opt/brainx/data/brainx.db
sudo systemctl start brainx.service brainx-dispatcher.service brainx-backup.timer
```

恢复后按 [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md) 的精神做一次冒烟：服务起来、`quick_check` 过、关键计数与快照一致。

## 2. 高热表保留/归档（每周自动）

- **计划**：`brainx-ledger-retention.timer` 每周日 04:23 触发，service 的 `ExecStart` 带 `--apply`。
- **窗口**（env 可调，单位天；窗口内一律不动）：

  | 表 | 默认窗口 | env |
  |---|---|---|
  | `lark_messages` | 90 | `BRAINX_RETENTION_LARK_MESSAGES_DAYS` |
  | `workflow_event_log` | 90 | `BRAINX_RETENTION_EVENT_LOG_DAYS` |
  | `openmai_results` | 180 | `BRAINX_RETENTION_OPENMAI_DAYS` |

- **纪律**：默认 dry-run（只出各表 scanned/keep/archive 计数对照，只读连接，零写入）；`--apply` 才执行，且执行前先自动做一次安全快照（复用 `brainx-backup` 全部自检纪律）。
- **归档不是删除**：超龄行先写入归档库 `$BRAINX_ARCHIVE_DIR/brainx-archive-YYYYMMDD.db`（缺省 `data/archive/`；按需建同名表，列结构按源库 `PRAGMA table_info` 重建，主键保留），确认落盘后才从主库删除。归档先写后主删，崩溃不留数据空洞；重复执行幂等。
- **引用保护**（命中任一即不删不搬，对应 SC-004 零误删）：
  - `lark_messages`：被 `status='pending'` 的 `job_facts_drafts` / `judgment_drafts` 引用（`message_id`）；或被仍将留在主库的 `workflow_event_log.evidence_refs` 引用（MVP 口径：`LIKE '%"id":"<message_id>"%'`，LIKE 通配符已转义）。
  - `workflow_event_log`：被 pending 草稿引用（`event_id`）；或被 `consumer_failures` 未 resolved（`resolved_at IS NULL`）的行引用。
  - 已知边界：被 **confirmed** 草稿引用的事件不在保护范围（草稿字段已含 `*_evidence` 原文锚点，血缘副本在归档库）；连接级 FK 校验在 retention 进程内关闭，否则删除父行会被误拦。

### 调整窗口的审查流程

1. 改窗口前先 dry-run 看影响面：

   ```bash
   BRAINX_RETENTION_LARK_MESSAGES_DAYS=60 node bin/brainx-ledger-retention.mjs | tee /tmp/retention-plan.json
   ```

2. 核对各表 `archive` 计数与业务预期；重点看 `keep` 是否包含近期证据链。
3. 确认后把 env 写进 `/etc/brainx/worker.env`（timer 单元挂的就是它），手动跑一次 `--apply` 验证：

   ```bash
   sudo systemctl start brainx-ledger-retention.service
   ```

4. 磁盘空间回收：DELETE 只标记不缩文件，需要另行在维护窗跑 `VACUUM`（锁库，勿在高峰跑）：

   ```bash
   node -e "import('node:sqlite').then(({DatabaseSync})=>{const d=new DatabaseSync('/opt/brainx/data/brainx.db');d.exec('VACUUM');d.close()})"
   ```

## 3. 失败告警看哪里

两个单元都是 `Type=oneshot`，失败即非零退出，看 journal：

```bash
journalctl -u brainx-backup.service -n 50 --no-pager          # 备份失败原因（stderr 已带具体信息）
journalctl -u brainx-ledger-retention.service -n 50 --no-pager
systemctl list-timers brainx-*                                 # 确认 timer 在排程、上次触发时间
```

判读口径：退出码 75 = 上一次实例仍在跑/锁未释放（若长期存在，检查 `.backup.lock` 是否为崩溃残留，确认无进程后可删）；退出码 1 = 真失败（快照自检不过、磁盘满、源库不可读），当日必须处置（SC-001 要求失败当日可见）。`brainx-guard.mjs` 守护通道后续可对接这两个 journal 面（FR-006 观测输出暂以脚本 JSON 摘要 + journal 为准）。

## 4. env 清单

| env | 缺省 | 作用 |
|---|---|---|
| `BRAINX_DB_PATH` | `data/brainx.db` | 源库路径 |
| `BRAINX_BACKUP_DIR` | `data/backups` | 快照目录（生产建议指异盘） |
| `BRAINX_BACKUP_KEEP_DAYS` | `14` | 快照滚动保留天数 |
| `BRAINX_ARCHIVE_DIR` | `data/archive` | 归档库目录 |
| `BRAINX_RETENTION_LARK_MESSAGES_DAYS` | `90` | 原文保留窗口 |
| `BRAINX_RETENTION_EVENT_LOG_DAYS` | `90` | 账本保留窗口 |
| `BRAINX_RETENTION_OPENMAI_DAYS` | `180` | 找人结果保留窗口 |

## 5. 服务器规格基线

仓库未记录 ECS 硬件规格，磁盘增长预测（SC-003）缺基线。在服务器上执行以下命令采集，回填到本节末尾的「基线记录」小节（一次采集 + 每季度复核）：

```bash
lscpu | grep -E 'Model name|^CPU\(s\)|MHz'        # CPU 型号/核数
free -h                                            # 内存
df -h /opt/brainx                                  # 数据盘总量/可用
ls -lh /opt/brainx/data/brainx.db*                 # 库文件与 WAL 体积
sqlite3 /opt/brainx/data/brainx.db \
  "SELECT 'lark_messages', COUNT(*) FROM lark_messages
   UNION ALL SELECT 'workflow_event_log', COUNT(*) FROM workflow_event_log
   UNION ALL SELECT 'openmai_results', COUNT(*) FROM openmai_results
   UNION ALL SELECT 'recommendations', COUNT(*) FROM recommendations;"
```

### 基线记录

- 待回填（首次部署本手册后采集）：CPU / 内存 / 数据盘 / 各高热表行数与库体积。

## 相关文档

- [specs/021 数据治理规格](../specs/021-data-governance/spec.md)：验收标准与范围边界。
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)：改动与部署前的统一验收清单。
- [部署编排](DEPLOYMENT.md)：systemd 单元安装与 `worker.env` 管理。
- [云端恢复清单](cloud-recovery-checklist.md)：现网恢复的历史基线（本文 §1 为日常快照口径）。

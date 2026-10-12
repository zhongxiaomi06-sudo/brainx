# 数据地基体检报告（2026-09-28 扫射检查）

> 上级目录：[BrainX 文档书](README.md)
>
> 检查方法：对照[数据读取链路与错位诊断规范](2026-09-24-data-reading-pipeline.md)的四类根源（A 位置/B 时间/C 字段/D 键）与[数据渠道全景](2026-09-24-data-channels-roadmap.md)的接入状态，对生产库（47.110.93.137 `/opt/brainx/data/brainx.db`，只读模式）做三轮 SQL 扫射：结构层（迁移记账/建表来源/索引）→ 数据层（时间格式/通道分布/孤儿引用/键断链）→ 关键点归因。检查脚本存 `/tmp/brainx-audit{,2,3}.sql`（本机）。
>
> 本报告登记的是**结构问题**；与既有文档分工：链路怎么读归 reading-pipeline、渠道盘点归 channels-roadmap、存储归属归 data-structure-and-disk-layout。

## 1. 结论速览

| 状态 | 数量 | 最重要 |
|---|---|---|
| 🔴 必须修（结构地雷/读数失真） | 3 | S1 迁移分叉、S2 新表无记账、S4 双层状态不一致 |
| 🟡 应修（数据质量/断链） | 4 | S3 时间未归一、S5 审计断链 596、S6 孤儿草稿 71、S7/S8 草稿结构回潮 |
| ⚪ 已知缺口再实证 | 2 | S9 cockpit 覆盖 0.086%、S10 status 35 枚举待映射 |
| ✅ 扫射通过 | 6 项 | 时间格式/通道分层/键守卫/推送幂等全干净 |

## 2. 🔴 结构层问题（数据地基）

### S1 生产 migrations 目录与仓库分叉（重建地雷）

- 生产 `schema_migrations` 记账 64 条；仓库 `migrations/` 仅 62 文件。
- 差集：生产独有 `0019_position_add_company`、`0020_workbench_preferences`（记账在、**仓库无此文件**）；且生产目录出现**双 0019 并存**（0019_position_add_company 与 0019_ttc_field_reports）。
- 后果：从仓库在新环境重建 → 缺这两份结构；更危险的是旧库回填逻辑（`db.js`：无记账且 user_version=N → 标记前 N 个文件已应用）在文件集不同的机器上会**把错误的文件标成已应用**——A1 类错位在生产现行复发。
- 修法：把生产两文件收回仓库（保持文件名，收进 git）；生产记账不动；新增一条说明性 migration 或在 PRE_PUSH_VERIFICATION 加「生产/仓库 migration 文件集一致性」检查项。

### S2 T7/T8 三张新表无 migration 记账

- `ttc_pipeline_rows` / `ttc_project_rows` / `ttc_task_rows` 的 DDL 只在 sqlite_master 里（ad-hoc 脚本建的），`schema_migrations` 无对应条目、仓库无文件。
- 后果：任何新环境重建即缺表，T7/T8 链路直接崩；与 S1 叠加。
- 修法：三表 DDL 收编成 `0060_ttc_rows_tables.sql`（IF NOT EXISTS 幂等），生产跑一次仅记账不改建。

### S3 ttc_project_rows.created_at 全量非 UTC ISO（3,290 行）

- 源格式为 TTC 返回的本地墙钟串（`2026-06-01 20:14:54`，空格分隔、无时区标记），入库未归一——B1 红线现行。
- 其余各表（job_facts/lark_messages/overrides/pipeline_rows.updated_at）全部合规。
- 修法：确认 TTC 时区语义（按 +08:00）后入库层归一化 + 存量 UPDATE；此后新拉取直接存 UTC ISO。

## 3. 🔴 数据层问题

### S4 双层状态不一致 1,277 个项目（读数失真）

- 实证：`job_facts.active_state='UNKNOWN'` 但 `manual_fact_overrides` 同项目 `active_state='OPEN'` 的项目 **1,277 个**——与 OPEN 从 5,905→4,628 的降幅精确吻合。
- 根因：09-26 写回用「job_facts 表 UPDATE + overrides 免疫」双写，但 ttc sync 的 UPSERT（`sync.js` excluded.active_state 整行覆盖）每几分钟把表内值冲回 UNKNOWN；读层 `effectiveJob`（R2）走 overrides 是对的，但**表内值成了假象**——任何直读 job_facts 的诊断脚本/展示/raw_json 展开都会得出错误结论。
- 关联遗留：override 无 TTL（09-26 已登记），现已放大为结构性双源。
- 修法方向（正式化四件事之一）：T7 信号不覆盖 `active_state` 列，改为独立列（如 `ttc_active_state`）由 `effectiveJob` 合成；或 sync UPSERT 跳过有 active_state override 的项目。**不许两处都写。**

### S5 push_log → decision_runs 审计断链精确规模：596 条

- `DAILY_TOP3` 的 run_id（`openclaw:2026-09-28#1900` 波次合成键）**596 条全部 JOIN 不上** `decision_runs.run_id`（UUID）。上一轮 D4 判断成立，现在有数字。
- 其余 kind（STAGE_REMINDER/RELEASE_NOTICE 等 719-596 条）键形态不同但本就无需 JOIN 决策轮，不属断链。
- 修法：specs/022 已有方案（push_log 记 decision run 引用列），排期实施。

### S6 71 条草稿的原文锚定缺失（成因待归因）

- `job_facts_drafts` 中 71 条 group 来源草稿引用的 `lark_messages` 行不存在（全部 2026-09 产出，**不是 retention 所致**——lark_messages 最早 2024-11 仍在库）；judgment_drafts 引用完好。
- 后果：草稿确认面板证据不可回溯，违反「原文锚定」纪律。
- 修法：先归因（嫌疑：bridge 事件消费与 lark_messages 写入的时序/去重差异），再按 message_id 补拉或草稿转 rejected。

### S7/S8 草稿结构问题在新增量中回潮

- pending 3,045 条（GLM 清洗后 1,644 → 新增 ~1,400），其中**单字段草稿 870 条**（company 有 role 无 679 + role 有 company 无 191），确认价值低。
- **弱后缀 company（尾缀科技/智能/数据且 ≤2-3 字）480 条**：rules 315 + **llm-recovery 135 + llm-split 30**——C1 不是规则层独有，GLM 复活/拆稿层也在产生。规则 v2 施工时必须同时约束两层（LLM 层加「公司名 ≥4 字或含行政区划/组织词」类校验）。

## 4. ⚪ 已知缺口再实证

- **S9**：cockpit_facts 仅覆盖 20/23,294 项目（0.086%）——current_stage 合成覆盖率几乎为零；T7 的 35 种 status（AwaitingJoinProject 6,317 / ToRecommendToClient 2,899 / ClientFilteringResume 3,240 / OfferSigned 120 / HiredProbationPending 127…）就是该缺口的数据源，需建 status→brainx 六阶段映射表后进 job_facts。
- **S10**：ttc_pipeline_rows 无 job_name 8,010 行（权限/脱敏类，**读时过滤，不删**）；同 project+client+job 多行是「一职位多候选人」正常语义（每行=一条候选人 pipeline），**不是重复脏数据**（修正 09-26「疑似重复 21 组」的口径：那是 pipeline_id 维度）。

## 5. ✅ 扫射通过项（本轮无问题）

| 检查项 | 结果 |
|---|---|
| 时间格式（除 S3 外全部表） | UTC ISO 全合规；未来时间 0；gateway 行 received<create 倒挂 0 |
| 通道分层 | origin：gateway 20,575 / backfill 922 分明；memberships source 无新增污染（ttc-owner 273/MANUAL 56/demo 7/job-extract-confirm 4） |
| 孤儿引用 | overrides→job_facts 0；judgment_drafts 0 |
| UNIQUE 索引守卫 | 11 个 UNIQUE 索引全部 WHERE 部分索引或含非空列，D3 红线执行良好；push_log 空哨兵 0 |
| 推荐链健康 | sync_runs ttc complete=1 连续 200；decision_runs 09-28 单日 193 条 COMPLETED；SKIPPED_THROTTLED 64（2h 限流正常） |
| T7 JOIN 率 | pipeline_rows→job_facts 89%（17,413/19,579） |

## 6. 修复排期建议

| 顺位 | 项 | 动作 | 量级 |
|---|---|---|---|
| 1 | S1+S2 | 生产两文件收回仓库 + 三表收编 0060 migration | 小（纯文件+记账） |
| 2 | S4 | T7 写回正式化：独立列或 sync 跳过 override 项目（二选一，拍板后施工） | 中 |
| 3 | S3 | ttc_project_rows 时间归一（确认 +08:00 后 UPDATE+入库归一） | 小 |
| 4 | S5 | specs/022 实施时带 decision run 引用列 | 已在排期 |
| 5 | S6 | 孤儿 71 条归因→补拉或转 rejected | 小 |
| 6 | S7/S8 | 规则 v2 + LLM 层校验双约束（吸收进 docs/2026-09-24-cold-start-rules-v2-profiles.md 施工清单） | 已在排期 |

## 相关文档

- [数据读取链路与错位诊断规范](2026-09-24-data-reading-pipeline.md)：根源分类与本报告编号（S1=A1 复发、S3=B1 违规、S5=D4、S7=C1）的对照依据
- [数据渠道全景与接入路线规范](2026-09-24-data-channels-roadmap.md)：T7/T8 渠道定义
- [数据结构与磁盘用途规范](2026-09-23-data-structure-and-disk-layout.md)：存储归属
- [数据治理运维手册](2026-09-23-data-governance-ops.md)：retention 与引用保护

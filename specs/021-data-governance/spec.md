# Feature Specification: 数据治理（备份 + 保留/归档）

**Feature Branch**: `main`（本仓库以 main 直接协作）

**Created**: 2026-09-23

**Status**: Draft（立项占位，plan/tasks 待排期）

**Input**: User description: "数据治理子规格：备份 + retention；当前数据方案不稳定"

## 背景与立项依据

2026-09-23 存储现状核实（代码 + 脚本对照）：

- **生产库无自动备份**：SQLite 决策库（ECS `/opt/brainx/data/brainx.db`，WAL）的唯一副本动作是 `scripts/pull-cloud-data.mjs` 手动拉取（用途是训练副本，非备份计划）；已知唯一手工备份是 2026-08-19 的本地留档。
- **保留策略只覆盖推荐域**：`bin/brainx-retention.mjs` 是 recommendations 表 5 天膨胀 166 万行（0.6G/天）后补的救急脚本；`lark_messages`（飞书原文）、`workflow_event_log`（账本）、`openmai_results`（含结果 markdown 正文）均无保留/归档策略。
- **规模前提**：目标 300+ 顾问、每日 12-15 万条消息（specs/019 背景）。按此速率原文表将重演推荐表膨胀。
- **云本地单向**：`pull-cloud-data.mjs` 只下不上，无回流、无异地副本。

关联规格：specs/019-hub-event-backbone（事件骨干；本规格治理其数据底盘）。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 生产库每日自动备份可恢复 (Priority: P1)

运维无需人工操作，生产 SQLite 每日自动产生一致性快照并留存到本机以外的位置；恢复演练可按文档执行。

**Why this priority**: 单点单库无备份是当前最大的数据丢失风险，一切其他治理都以可恢复为前提。

**Independent Test**: 触发一次备份任务，验证快照可用 `sqlite3` 只读打开且表计数与源库一致；删除源库后按文档从快照恢复。

**Acceptance Scenarios**:

1. **Given** 备份任务按计划触发，**When** 检查产物，**Then** 存在带时间戳的一致性快照（WAL 安全方式），且保留 N 天滚动窗口。
2. **Given** 一次备份失败，**When** 查看告警面，**Then** 失败可见（非静默），且不影响生产读写。

---

### User Story 2 - 高热表有保留与归档纪律 (Priority: P1)

原文、账本、找人结果等高热表各自有明确的保留窗口与归档去向；磁盘增长有上限且可预测。

**Why this priority**: 推荐表膨胀事故已经演示过无纪律的后果；目标规模下原文表是下一个。

**Independent Test**: 构造超龄数据的测试库，跑保留任务 dry-run 与 apply，验证保留规则命中与误删保护（被证据引用的事件/消息不删）。

**Acceptance Scenarios**:

1. **Given** 超龄且未被引用的原文消息，**When** 保留任务执行，**Then** 被清除或归档，且被 evidence_refs 引用的行一律保留。
2. **Given** 保留任务，**When** 不带显式执行参数运行，**Then** 只输出计数对照（dry-run 为默认，同 brainx-retention 纪律）。

---

### Edge Cases

- 备份窗口与 WAL checkpoint/重写入冲突：快照必须用在线一致性方式（VACUUM INTO 或 .backup），不得直接 cp 数据文件。
- 归档删除不得破坏账本 append-only 语义：账本只归档（搬走），不删除仍在引用窗口内的事件。
- 密钥与令牌表（ttc_tokens 等密文）随库备份即可，不额外导出明文。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 MUST 每日自动生成生产库一致性快照（在线安全方式），保留滚动窗口（默认 14 天），失败可见。
- **FR-002**: 快照 MUST 存放于生产库所在磁盘以外的位置（本机另一磁盘或对象存储）。
- **FR-003**: 系统 MUST 提供按文档可执行的恢复路径，恢复产物可只读打开且校验表计数。
- **FR-004**: lark_messages、workflow_event_log、openmai_results MUST 各自有声明的保留窗口与归档规则；被证据引用（evidence_refs）的行不得删除。
- **FR-005**: 保留/归档任务 MUST 默认 dry-run，显式参数才执行删除，删除前自动留档。
- **FR-006**: 磁盘占用与表行数 MUST 有周期性观测输出（对接既有 guard/报告通道）。

### Key Entities *(include if feature involves data)*

- **备份快照**：带时间戳的库一致性副本，含来源、生成方式、校验计数。
- **保留策略**：表 × 窗口 × 归档去向 × 引用保护规则。
- **归档区**：超龄数据的只读去向（文件或独立库），与生产库分离。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 连续 14 天每日备份成功率 100%，任何失败当日可见。
- **SC-002**: 恢复演练从快照到可只读打开 < 10 分钟，表计数一致。
- **SC-003**: 生产库磁盘增长可预测：高热表行数有上限策略，磁盘日增长较治理前可量化下降。
- **SC-004**: 保留任务零误删：被引用行 100% 保留（测试覆盖）。

## Assumptions

- 存储形态不变（SQLite + WAL 继续承载决策库；RDS 继续承载人才库）；分库/换库不在本规格。
- 备份目标位置第一期用同机异盘或既有对象存储，异地容灾为后续项。
- 保留窗口默认值在 plan 阶段按数据生产速率核算，不在本规格钉死。
- 本规格与 specs/019 并行：019 改链路形态，本规格管数据底盘，互不阻塞。

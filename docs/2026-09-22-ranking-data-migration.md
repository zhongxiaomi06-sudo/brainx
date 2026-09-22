# 推荐重构：数据契约与迁移手册

> 上级入口：[施工总手册](2026-09-22-refactor-agentic-ranking-manual.md) · [文档书](README.md)
> 日期：2026-09-22；状态：目标设计，未执行迁移、回填、清理或生产切换。
> 决策规则：[Algorithm A 契约](2026-09-22-algorithm-a-contract.md)

## 1. 四层数据与存储边界

| 层 | 保存内容 | 生命周期和读取者 |
|---|---|---|
| 来源与证据 | 原始记录索引、必要片段、哈希、ACL、收到时间 | 原文分级保存；适配器与授权证据工具读取 |
| 规范事实 | 职位版本、字段证据、主动画像、信号 | 追加版本；领域服务提供当前投影与历史读取 |
| 决策账本 | 候选集、快照、Agent 决策、曝光、行为、结果、用量 | 不覆盖历史；按保留政策审计和评估 |
| 分析读模型 | 同步、效果、漏斗、成本聚合 | 可从账本重建；看板不扫描原始在线大表 |

短期继续 SQLite 职位/工作流与 MySQL 人才域。推荐事实和发布账本应处在能原子提交的同一存储边界；不能让一次“发布成功”依赖两个数据库恰好同时成功。公司级数据迁入既有 MySQL 的范围由并发、恢复目标和运维能力决定；先抽 repository 再换后端。

一旦跨库：权威写与本地 outbox 同事务，消费端幂等、可重试、可对账。禁止把两个顺序执行的 INSERT 称为原子双写。现有 `integration_outbox` 是外部投递实现，需核对其消息语义、租户边界、租约与崩溃恢复后复用；不能假定它天然支持所有事实复制。

## 2. Canonical Job v1

BrainX 拥有内部身份及规范字段契约，外部系统拥有被登记的字段事实来源。TTC 是当前来源之一；来源优先级由字段权威配置决定，换来源不会自动授权新系统覆盖全部事实。

| 字段 | 类型/语义 | 缺失与约束 |
|---|---|---|
| `tenant_id` | 服务端租户 ID | 必填，不能从模型输出采信 |
| `job_id` | BrainX 稳定内部 ID | 必填；不直接使用 TTC record ID |
| `fact_version`、`schema_version` | 不可变事实版本、契约版本 | 必填，历史版本可定位 |
| `source_type`、`source_record_id` | 本版本主来源引用 | 必填；多来源证据另存映射，不局限单一来源 |
| `title`、`company` | 岗位名、公司 ID/名称 | 身份最低完整度必需；公司名不能单独作为唯一键 |
| `function`、`industry`、`seniority` | 标准词表代码及显示名 | 可空；推断值另带字段证据与状态 |
| `cities` | 标准城市数组 | 未知用 null，空数组不得偷偷代表不限城市 |
| `status` | `OPEN / PAUSED / CLOSED / UNKNOWN` | 原值保留在来源层；只有符合规则的状态进入候选 |
| `headcount` | 已确认剩余需求，非负整数 | 未知 null，不使用 0 填空；区分总 HC 与剩余 HC |
| `urgency`、`priority` | 业务枚举 | 来源缺失为 null，不能由模型升级硬优先级 |
| `owner` | 规范顾问/团队引用 | 不可用姓名直接猜身份；未知则待核验 |
| `created_at`、`updated_at` | 来源业务创建/修改时间 | 来源未知为 null，不用抓取时间伪装更新时间 |
| `observed_at`、`recorded_at` | 采集时间、系统接收落账时间 | 必填，UTC；与业务时间分开 |
| `valid_until` | 来源明确期限或规则有效期 | null 不等于永久有效；按来源 freshness 策略检查 |
| `description`、`requirements` | 脱敏文本/摘要及正文引用 | 大文本走证据存储，限定可见范围 |
| `pipeline_summary` | 结构化阶段、数量、时间和来源 | 未知不猜，有人选级结果时通过 Case 关联 |
| `evidence_refs`、`data_confidence` | 引用、字段完整度与可信状态 | 非 Agent 自报成功概率；规则版本必需 |
| `content_hash`、`source_snapshot_id` | 规范化内容哈希、完整快照引用 | 必填；不能仅看 updated_at 判断变化 |

`job_id` 与现有 `project_id` 的关系通过已验证映射保留；首版可沿用现有稳定内部 ID 的值，但不得重编号。外部显示名及字段只在 adapter/兼容映射层出现，下游只消费规范字段。

### 2.1 来源适配器契约

每个 adapter 输出记录与同步信封：`source_instance_id / adapter_version / schema_version / batch_id / scope / cursor / complete / received_at / records / tombstones / errors`。

- 身份唯一键为 `(tenant_id, source_instance_id, entity_type, external_id)`；相同来源类型的多个表/账号不能撞 ID。
- 完成全部分页、校验记录数量与游标后，才能标记 complete 并推进消费水位；超时/限流/缺页明确失败。
- 增量更新与删除用来源明确事件或完整快照差集判定；缺页不等于删除，停用 adapter 也不等于关停岗位。
- 模糊同公司/同岗位匹配只生成待确认映射；人工合并与拆分追加映射历史，不能删除原 ID 或合并他人的业务记录。
- 同一字段冲突按人工已确认、登记权威来源、其他事实、软推断处理，并考虑有效时间；“更新时间最新”不是唯一裁决。
- 新来源上线需做同一 Canonical Job 的等价夹具测试；来源权限范围仍独立，不因身份合并扩大可见性。

### 2.2 入库 Agent 与字段证据

复用 `src/job-extract/schema.js`、`jd-extract.js`、`confirm.js` 的提炼/确认分离。适配器先映射结构化事实；Agent 只针对变化的授权非结构化片段生成严格字段结果。

每条 `field_evidence` 至少保存：`tenant_id / entity_id / fact_version / field_path / value / origin_kind / evidence_ref / source_span / source_time / recorded_at / confidence / extraction_model / prompt_version / schema_version / review_status`。

`origin_kind` 区分来源事实、人工确认、模型推断；无法定位原文的推断不进入事实。行业、职能、级别等可作软特征；权限、状态、HC、归属、保密和期限不能仅凭模型推断满足硬条件。

提炼缓存键含租户与作用域、正文哈希、提炼 schema、模型和 prompt 版本；内容相同可复用提炼，但授权、有效性和撤回仍单独更新。空值不等于删除，明确清空需有来源操作和证据。

## 3. 数据对象、复用策略与关键约束

以下名称是逻辑对象。优先扩展现有权威表或建立兼容视图，不能仅因命名不同再造平行真值；最终物理 DDL 在对应规格中确认。

| 逻辑对象 | 当前复用基础 / 目标增量 | 最小关键字段与唯一约束 |
|---|---|---|
| `source_records` | 新增索引；复用同步运行与 `entity_links` | 来源身份键、payload_ref/hash、adapter_version、ACL、完整性、水位 |
| `job_fact_versions` | `job_facts` 保留当前投影，新增不可变版本 | `(tenant_id,job_id,version)`；来源/内容哈希；业务有效与接收时间 |
| `field_evidence` | 复用草稿证据形状，建立字段级引用 | 事实版本、field_path、来源片段、可信度、模型与确认状态 |
| `consultant_profile_versions` | 从顾问 JSON 渐进迁移 | `(tenant_id,consultant_id,version)`；主动偏好/排除/容量、操作者、生效时间 |
| `consultant_signals` | 新增短期推断，不覆盖画像 | signal_type、值、窗口、样本数、证据、算法、expires_at |
| `feature_snapshots` | 扩展冻结推荐依据 | profile/load/permission/job 版本、候选集、缺失掩码、as_of、水位、内容哈希 |
| `recommendation_runs` | 优先扩展/映射 `decision_runs` | engine、模式、状态、generation、版本集合、预算、计数、错误、幂等键 |
| `recommendation_items` | 优先扩展/映射 `recommendations` | `(run_id,job_id)` 与 `(run_id,rank)` 唯一；理由、证据、缺口；A score 可空 |
| 推荐曝光 | 复用 `recommendation_impressions` | 曝光事件 ID、run/item、位置、渠道、served/visible 时间、真实 propensity 或 null |
| `decision_events` | 复用现有表与忽略/项目事件 | 事件 ID、actor、job、run/item 可空、动作、occurred/received 时间、幂等键 |
| `business_outcomes` | `job_outcomes`、Case 与 `workflow_event_log` 转换 | outcome_id、case_id、job、顾问、结果、来源、发生/收到时间、更正引用、归因版本 |
| `agent_usage_ledger` | 扩展运行审计，新增逐调用账本 | call/attempt/run、provider/model、Token、费用、延迟、工具、上下文引用和失败码 |
| Context Registry | 新增版本化配置，复用群授权 | scope、文档版本、chunk、ACL、检索策略、摘要版本、TTL、预算 |
| 分析投影 | 复用 `hub/consumer.js` 幂等模式 | 维度、窗口、指标版本、源水位、更新时间；可重建 |

所有新唯一键、索引、查询和消费幂等均检查租户作用域；已有 `entity_links` 等表的唯一键若没有租户/来源实例，先做兼容迁移，不能只在文档里假定已隔离。新表中的 source/actor/group ID 不代替可信授权上下文。

推荐索引至少覆盖：按租户/顾问最新可发布 run、run 内 rank、job 历史版本、来源唯一键、事件时点、case/outcome 幂等、usage run 聚合。确切索引由执行计划与数据量验证，禁止为了未来所有查询无边界加索引。

## 4. 画像、事件与归因

### 4.1 主动画像和信号

主动画像保存行业、职能、地区、客户类型、擅长与发展方向、硬排除、工作容量设置、修改人和理由。修改产生新版本及失效通知。管理员修改须具备权限，不能把普通群成员发言当作本人偏好。

短期信号注明授权来源、窗口、样本量、置信度、推断版本及有效期；可撤回、可过期。浏览只作弱信号，忽略原因区分不合方向、暂时没空和岗位问题。当前负载是项目事实，不由画像中的旧计数代替。

### 4.2 行为与业务结果

- 生成列表、接口返回、真实可见曝光、查看、忽略、撤销、加入项目、开始跟进分别记录；翻页或重试不可重复累计。
- 行为事件保存来自哪个 run/item；从搜索或手动建项目发起时允许 run 为空，不强行归因最近推荐。
- 面试/Offer/Onboard 关联 Case 和权威来源事件；去重键按租户、来源、事件 ID，事件没有可靠 ID 时在规格中定义可验证的组合键。
- 更正结果追加 correction 事件；不直接修改旧评估集。重复曝光不重复计算同一业务结果。
- 首版归因建议绑定导致承接的明确决策事件，并冻结 attribution_version；无关联时只进业务总量，不进推荐贡献指标。
- 7/30/90 日等窗口是可选分析窗口，最终采用的窗口须实验前批准；未成熟样本与真实失败分开。

## 5. Token、上下文与费用

每次模型尝试先创建调用记录，最终更新终态或由对账标记未知：`call_id / attempt_id / run_id / round / tenant / consultant / model / request_ref / input_tokens / output_tokens / cached_input_tokens / reasoning_tokens / usage_status / price_version / estimated_cost / currency / latency_ms / tool_count / context_refs / truncated / status / error_code`。

注意供应商口径：缓存输入和 reasoning 可能是 input/output 的子集，不能相加两遍；保留供应商原始 usage 的受限结构及归一化版本。供应商未返回 usage 记 unknown，不记 0。超时或重试可能已经计费，按请求 ID 对账；相同 attempt 的回调不得重复累计。

run 聚合覆盖所有成功、失败、修复和收尾调用。费用使用当时价格版本，无法计价为 unknown；估算成本与对账费用区分。上下文只记录必要引用、大小和访问范围，密钥/完整简历/原始对话不直接进入用量表。

Context Registry 把群到文档的绑定、内容版本、分块权限与检索预算显式化；读每一片段前鉴权，撤权同步使缓存/索引失效。保留足够信息解释当时依据；发生合法删除后记录证据不可恢复原因，不承诺永远能读到原文。

## 6. 逐步迁移操作流程

迁移实行一个权威写入者。所谓双写对账，指权威提交后可靠地产生影子投影并核对；不是 API 任意同时写两个独立数据库。

| 步骤 | 执行动作 | 放行证据 | 失败处理 |
|---|---|---|---|
| M0 盘点 | 记录版本、表结构、大小、引用、读写入口和 worker；建立一致性备份 | 新实例恢复成功，行数/摘要一致 | 不进入后续迁移 |
| M1 扩展 | 新增可空字段、新表、索引、兼容 reader；分配唯一迁移编号 | 空库安装和旧版本升级都成功；重复执行幂等 | 停新功能，保留旧 schema 可读 |
| M2 回填 | 小批按稳定主键/水位读取，写版本、映射和 checkpoint | 数量/主键/字段摘要匹配，暂停后可续跑 | 重试当前批，不重编号或覆盖已确认版本 |
| M3 追增量 | 原权威事务记录 outbox；消费者应用到新投影 | 无丢事件，延迟受控，重复应用无变化 | 修复/DLQ 重放，旧写继续服务 |
| M4 影子读 | 对相同租户、顾问、时点比较旧新查询 | 无未解释差异；权限集合、忽略和 ID 一致 | 保持旧读，登记差异 |
| M5 灰度切读 | 先固定顾问/租户切到新事实读取，写仍只有一个权威 | 目标流程、性能、错误率达标，审计可回放 | 切回旧读；保持新数据与事件 |
| M6 转移写入 | 仅确需换库时短暂停写/排空；追平高水位，切换 writer epoch | 旧 writer 被隔离、无遗漏、同一业务事件仅提交一次 | 未切成功继续旧 writer；已切后先反向追平再恢复旧 writer |
| M7 退役 | 稳定窗口结束、备份与引用检查后移除旧调用 | 旧读写为零，恢复演练与历史解码通过 | 破坏性删除单独评审，不能靠删表回滚 |

补充操作纪律：

1. SQLite 运行中不能只复制主文件而忽略 WAL；采用经验证的一致性备份方法，恢复演练验证事务与密钥引用。
2. 模型调用和外部网络操作不在长事务内；回填每批设限、超时、取消和冲突处理。
3. 同步游标只有记录与 outbox 成功持久化后才能推进；未知部分失败返回非零，不记录 complete。
4. outbox 要覆盖“发送成功但标记前崩溃”与“SENDING 后崩溃”；消费/投递要有幂等键、租约、重试上限、DLQ 与人工重驱。现有实现需专项核验后才用于新链路。
5. 旧表无历史版本不能制造历史。回填标记 `LEGACY_SNAPSHOT`、当前观察时间与来源可信度，不假造当时完整信息。
6. 每次切换保存代码/schema/数据水位/读写版本/开关、责任人和恢复点。切读回滚不等同迁移数据回滚。
7. 迁移账号与应用账号分离；Agent 只有受限只读工具，不能拿临时 DDL 或后台 DML 凭据。

## 7. 保留、增长与删除

| 数据类 | 首轮工程动作 | 删除前条件 |
|---|---|---|
| `ttc_field_reports` | 相同 schema/内容哈希去重，冷热分层 | 差异样本与审计引用已保留，TTL 获批 |
| `sync_runs`、限流跳过 | 降低无意义重复写，保留窗口聚合和错误样本 | 不影响同步水位、故障调查和快照完整性 |
| 原文/JD/群片段 | 内容寻址、权限与保留级别分离 | 删除授权、活动引用核对和删除账本 |
| 决策/特征快照 | 按评估窗口和审计用途归档 | 活跃运行、实验冻结集、事故调查不能被普通 GC 清除 |
| 事件/结果/usage | 先归档、汇总与对账 | 符合批准的保留策略，金额与业务结果仍可核算 |
| 缓存/分析投影 | TTL、定期重建、容量告警 | 确认来源账本可重建，不误删权威事实 |

保留策略配置包含 owner、数据类别、目的、TTL、访问范围、例外与删除审计。未确认 TTL 前允许测量与 dry-run，不自动删除事实。隐私删除必须传播到证据、缓存、检索索引和恢复流程；账本可保留必要的无内容 tombstone，不把“不可变”理解为永久保留个人原文。

监控按日增长、峰值写入、锁等待、查询 p95、磁盘剩余、备份大小与耗时、恢复耗时。RPO/RTO 和容量余量在正式迁移前由运维确认，并用故障演练证明，不能引用本地 317 MB 推断公司级容量。

## 8. 数据验收清单

- [ ] 同一来源重复投递、缺页、乱序、删除/恢复、字段清空均有 fixture，失败不推进完整水位。
- [ ] 同 ID 在不同租户或来源实例不冲突；合并/拆分不丢 membership、群与 Case 引用。
- [ ] 主动画像、推断信号和个人模型凭据可独立变化；明确排除项在所有入口一致生效。
- [ ] 冻结事实与决策、结果标签双时间正确；历史不可重建时不冒充可回放。
- [ ] 发布结果、事件和 outbox 的原子性有断点故障测试；跨库重试和恢复有对账证据。
- [ ] 两轮模型成功 + 一轮失败的用量分别可查，总计正确；未知 Token/费用不会被记成零。
- [ ] 完成空库/升级/重复迁移/暂停续跑/切读回滚/写切换恢复测试。
- [ ] 正式持久层失败返回可识别错误；用户确认成功的业务写在重启后存在。
- [ ] 清理不破坏活跃回放，隐私删除后备份恢复不会重新暴露已删数据。
- [ ] 分析读模型可按事件重建，曝光与业务结果不重算，实际延迟在界面可见。

## 相关文档

- [施工总手册](2026-09-22-refactor-agentic-ranking-manual.md)
- [Algorithm A 决策契约](2026-09-22-algorithm-a-contract.md)
- [Workflow Hub](workflow-hub-architecture.md) · [候选人事实契约](2026-09-03-candidate-data-contracts.md)
- [安全操作手册](SECURITY.md) · [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)

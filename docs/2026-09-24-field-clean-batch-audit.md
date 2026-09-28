# field-clean 两批清洗数据审计报告（2026-09-24）

> 上级目录：[BrainX 文档书](README.md)
>
> 审计对象：ECS `/opt/brainx/data/draft-cleanup/field-clean-{pending,batch2}.jsonl`（`field-clean.mjs` 临时清洗 runner 产出，不进仓库；咪拍板任务）。
> batch1 = `job_facts_drafts(status=pending)` 字段标准化；batch2 = `lark_messages(origin=backfill)` 判定+抽取。
> 抽取字段：`is_real_job / company_norm / role_norm / role_family / hc / city / stage_hint / evidence`。
> 审计方法：①确定性全量校验（解析/枚举/填充/锚定，零 token）+ ②LLM 双标注（同 prompt 独立重抽 × 字段级对照，batch1 n=30、batch2 随机 n=30）。脚本 `/tmp/fc-{validate,judge}.mjs`（ECS，临时）。

## 1. 结论速览

| 维度 | batch1（pending） | batch2（backfill） |
|---|---|---|
| 总行 / 成功 / 失败 | 1,793 / 1,792 / 1 | 922 / 922 / 0 |
| 解析错误 / 重复 id | 0 / 0 | 0 / 0 |
| 枚举违规（family/stage/hc/is_real_job） | **0** | **0** |
| evidence 空 | 0 | 1 |
| is_real_job=true 占比 | 498（27.8%） | 37（4.0%，回填池闲聊为主） |
| LLM 双标注一致率（n=30） | 全字段 **83%~100%** | 随机 n=30 全字段 100%（仅证不误报）；**true 行全量 n=37：is_real_job 92%、role_family 76% 破线**（§4） |
| evidence 锚定率（全量，拍平+去空白口径） | **93%**（118 条改写） | **98%**（19 条，含 2 条 true 行） |
| evidence 超 40 字 | 153（8.5%） | 79（8.6%） |

**总评：两批的结构质量过硬（零解析错、零枚举违规），LLM 双标注过 ≥80% 验收线；四个真实缺陷需要处置（§3，batch2 true 行复验坐实其中三个），true 行 is_real_job 约 8% 存疑、role_family 破线。**

## 2. batch1 LLM 双标注明细（n=30，同模型独立重抽对照）

| 字段 | match | both_null | null_mismatch | mismatch | 一致率 |
|---|---|---|---|---|---|
| is_real_job | 29 | 0 | 0 | 1 | 97% |
| company_norm | 12 | 15 | 3 | 0 | 90% |
| role_norm | 9 | 16 | 5 | 0 | 83% |
| role_family | 8 | 17 | 5 | 0 | 83% |
| hc | 1 | 29 | 0 | 0 | 100% |
| city | 4 | 26 | 0 | 0 | 100% |
| stage_hint | 5 | 21 | 4 | 0 | 87% |

evidence 锚定（子串硬校验）：30/30。null_mismatch 双向都有（batch1 有值 judge 无值、反之亦然），集中在**日报/汇总类消息**——见 §3.2。

## 3. 三个真实缺陷与处置建议

### 3.1 file 类型消息污染（P1，输入侧过滤缺口）
batch1 有 9 条源消息是纯文件消息（text 仅 `{"file_key":...,"file_name":"xxx.pdf"}`），其中 **4 条从纯文件名判了 `is_real_job=true`** 并抽出 role（如「Agent工程师」「嵌入式软件开发工程师」）。无正文不可能确认「客户在招」，全数假阳性（占全量 0.22%）。
**处置**：清洗池输入侧过滤 `file` 类型（或抽出的行打 `source=file` 标记强制 is_real_job=false 人工复核）。

### 3.2 日报/汇总类消息的口径模糊（P1，两批同源，含 is_real_job）
「清雁科技｜招聘日报」「面试进展汇总」类聚合消息里，batch1 与 judge 对 stage_hint 时给时不给（null_mismatch 4 例全部此类）；**batch2 复验进一步发现 is_real_job 同病**：bot 聚合日报（含候选人简历推送记录）被抽出一个「AI研发工程师」判 true，独立重抽取 null 判 false。
**处置**：prompt 补两句「①日报/进展汇总/多人群发类消息：stage_hint 一律 null；②此类消息 is_real_job 一律 false（聚合内容非单一在招岗位）」。

### 3.3 evidence 7% 为 LLM 改写而非原文引用（P2，进消费规则）
全量锚定校验（post JSON 拍平 + 去空白 + 剥 markdown 加粗后前 12 字比对）：batch1 93% / batch2 98%。未锚定的 evidence 是**改写/拼接/概括**（如表格内容重新排版），不是编造，但**不满足「原文锚点可回溯」的严格口径**。注意：batch2 true 行的粗口径锚定仅 76%——**有内容行的 evidence 改写率显著高于闲聊行**。
**处置**：下游消费把锚定检查当硬门——未锚定行的 evidence 不作回溯依据（字段值本身仍可用，锚定率已列入持续观测）。

### 3.4 role_family 边界词表缺失（P2，batch2 复验新增）
batch2 true 行双标注中 role_family 一致率 **76%（唯一破 80% 线）**：①HRBP 归「管理岗」还是「运营」词表未定义（1 例各执一边）；②多岗位长 JD（如 CTO/技术负责人/后端负责人三合一）「只抽信息最全的一个」口径不稳定，batch2 抽子岗位、judge 抽标题岗（2 例）。
**处置**：词表补边界映射（HRBP→管理岗等高频争议角色写死）；多岗位 JD 口径收紧为「只抽职位标题/第一个岗位」。

## 4. batch2 true 行复验（2026-09-24 晚已闭环）

37 条 `is_real_job=true` 行全量双标注（同 prompt 独立重抽；judge 走同一 tunnel 端点、后端路由 gemini-3.6-flash，与清洗模型不同源——独立模型消自证偏差）：

| 字段 | match | both_null | null_mismatch | mismatch | 一致率 |
|---|---|---|---|---|---|
| is_real_job | 34 | 0 | 0 | **3** | 92% |
| company_norm | 7 | 27 | 2 | 1 | 92% |
| role_norm | 32 | 0 | 3 | 2 | 86% |
| role_family | 25 | 3 | 5 | **4** | **76%** |
| hc | 9 | 25 | 3 | 0 | 92% |
| city | 12 | 24 | 1 | 0 | 97% |
| stage_hint | 1 | 36 | 0 | 0 | 100% |

3 条 is_real_job 分歧定性：**2 条明确假阳性**（1 条 `<file .../>` 纯文件名——与 §3.1 同源，batch2 也有；1 条 bot 聚合日报——§3.2）、1 条多岗位 JD 边界。粗口径（未拍平）evidence 锚定 28/37，印证 §3.3「有内容行改写率更高」。
**结论：batch2 true 行约 8%（3/37）is_real_job 存疑，role_family 76% 破线——处置项 §3.1/§3.2/§3.4 全部由此坐实。**

## 5. 复现口径

- 快照：`/tmp/fc-pending-snapshot.jsonl`（1,793 行）/ `/tmp/fc-batch2-full.jsonl`（922 行）——ECS /tmp，重启即失；正式归档需另行 cp。
- 确定性校验：`node /tmp/fc-validate.mjs <snapshot> <sample-out>`（batch2 用 `fc-validate-b2.mjs`，join 源不同）。
- LLM 双标注：`ZHIPU_API_KEY=... node /tmp/fc-judge.mjs <sample.json> <report.json>`；锚定校验内联于审计脚本（拍平 + squash + 前 12 字）。
- 判定模型：清洗与 batch1 judge 为 `gpt-5.6-luna`（tunnel 端点，同模型双标注）；锚定校验与确定性检查不依赖模型。

## 6. Tier 复核与计算审核落库（2026-09-24 晚）

**分层口径（从 `draft_clean_results` 实测复现）**：
- **Tier1 = 498** = `task=pending AND is_real_job=1`（llm-recovery 442 + llm-split 44 + rules 12）→ 置顶确认队列候选
- **Tier2 = 898** = `task=pending AND is_real_job=0 AND source=llm-recovery`（A 批复活稿清洗后非真岗位）→ 降档处置
- 其余 396（llm-split 73 + rules 323 的 false 行）不在两 Tier 处置范围

**复核规则**（来自本报告 §3 实证）：source_kind = file / daily_report / normal；evidence 锚定（拍平+去空白+前 12 字）。

**落库**：ECS `brainx.db` 新表 `field_clean_tier_audit`（draft_id 主键 / tier / verdict / source_kind / anchor_ok / reasons / audited_at），1,396 行，INSERT OR REPLACE 幂等可重跑；**未改 `job_facts_drafts` 任何行**。

| Tier | verdict | n | 含义 |
|---|---|---|---|
| T2_demote | demote_confirmed | 898 | 维持降档（其中 daily_report 源占比高，佐证降档正确） |
| T1_confirm_queue | pass | 426 | 干净通过，可置顶确认 |
| T1_confirm_queue | pass_anchor_weak | 63 | 字段值可用，evidence 为改写不可回溯 |
| T1_confirm_queue | flag_daily_report | 5 | 日报类，is_real_job 待人工 |
| T1_confirm_queue | demote_file_false_positive | **4** | file 源假阳性（与 §3.1 审计实证的 4 条完全吻合，互证） |

**待拍板的状态处置**（本审计只落审核结果，不改 drafts 状态；机制二选一后一条 SQL 的事）：
- Tier2 降档 = 退回 rejected：`UPDATE job_facts_drafts SET status='rejected' WHERE draft_id IN (SELECT draft_id FROM field_clean_tier_audit WHERE tier='T2_demote' AND verdict='demote_confirmed')`
- Tier1 置顶标记：确认队列按 `field_clean_tier_audit.verdict='pass'` 优先排序（426 条先行，63 条 anchor_weak 次之，5+4 条人工单看）

## 相关文档

- [数据读取链路与错位诊断规范](2026-09-24-data-reading-pipeline.md)：evidence 弱锚定（C 类）已在案，本报告 §3.3 是其量化实证
- [冷启动规则 v2 与客户画像](2026-09-24-cold-start-rules-v2-profiles.md)：岗位词表与通知类误报抑制（§3.2 同源问题）
- [字段补全 Agent 规格（specs/023）](../specs/023-fact-agent/spec.md)：fact-agent 的 evidence 原文锚定是硬校验（无锚定即丢弃），比本批口径更严

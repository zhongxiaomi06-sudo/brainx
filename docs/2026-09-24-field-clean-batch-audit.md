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
| LLM 双标注一致率（n=30） | 全字段 **83%~100%** | 全字段 100%（⚠️ 见 §4 口径局限） |
| evidence 锚定率（全量，拍平+去空白口径） | **93%**（118 条改写） | **98%**（19 条，含 2 条 true 行） |
| evidence 超 40 字 | 153（8.5%） | 79（8.6%） |

**总评：两批的结构质量过硬（零解析错、零枚举违规），LLM 双标注过 ≥80% 验收线；三个真实缺陷需要处置（§3），一个未闭环项（§4）。**

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

### 3.2 日报/汇总类消息的 stage_hint 口径模糊（P2）
「清雁科技｜招聘日报」「面试进展汇总」类聚合消息里，batch1 与 judge 对 stage_hint 时给时不给（null_mismatch 4 例全部此类）。不是抽错，是 prompt 口径未定义「聚合日报里的多人面试动态算不算该消息的 stage_hint」。
**处置**：prompt 补一句「日报/进展汇总/多人群发类消息：stage_hint 一律 null（非单一职位进展）」。

### 3.3 evidence 7% 为 LLM 改写而非原文引用（P2，进消费规则）
全量锚定校验（post JSON 拍平 + 去空白 + 剥 markdown 加粗后前 12 字比对）：batch1 93% / batch2 98%。未锚定的 evidence 是**改写/拼接/概括**（如表格内容重新排版），不是编造，但**不满足「原文锚点可回溯」的严格口径**。
**处置**：下游消费把锚定检查当硬门——未锚定行的 evidence 不作回溯依据（字段值本身仍可用，锚定率已列入持续观测）。

## 4. 未闭环项（P1，需要 key）

**batch2 的 37 条 `is_real_job=true` 行未做 LLM 独立重抽对照**：清洗 key 随 runner 结束被删，本地 stepfun key 被 403（免费版要求人脸实名验证）卡死。随机 30 条样本因回填池 96% 为 null 行，只证明了「闲聊不误报」，**没测到有内容行是否漏抽/错抽**。
**处置**：拿到任一可用 GLM key 后，对 `/tmp/fc-b2-true-sample.json`（ECS，37 条带原文样本已备好）跑 `fc-judge.mjs` 即可，约 20 分钟。

## 5. 复现口径

- 快照：`/tmp/fc-pending-snapshot.jsonl`（1,793 行）/ `/tmp/fc-batch2-full.jsonl`（922 行）——ECS /tmp，重启即失；正式归档需另行 cp。
- 确定性校验：`node /tmp/fc-validate.mjs <snapshot> <sample-out>`（batch2 用 `fc-validate-b2.mjs`，join 源不同）。
- LLM 双标注：`ZHIPU_API_KEY=... node /tmp/fc-judge.mjs <sample.json> <report.json>`；锚定校验内联于审计脚本（拍平 + squash + 前 12 字）。
- 判定模型：清洗与 batch1 judge 为 `gpt-5.6-luna`（tunnel 端点，同模型双标注）；锚定校验与确定性检查不依赖模型。

## 相关文档

- [数据读取链路与错位诊断规范](2026-09-24-data-reading-pipeline.md)：evidence 弱锚定（C 类）已在案，本报告 §3.3 是其量化实证
- [冷启动规则 v2 与客户画像](2026-09-24-cold-start-rules-v2-profiles.md)：岗位词表与通知类误报抑制（§3.2 同源问题）
- [字段补全 Agent 规格（specs/023）](../specs/023-fact-agent/spec.md)：fact-agent 的 evidence 原文锚定是硬校验（无锚定即丢弃），比本批口径更严

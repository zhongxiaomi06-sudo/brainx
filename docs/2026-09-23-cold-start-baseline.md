# 第一批冷启动基线（cold-start-baseline v1，2026-09-23）

> 上级目录：[文档书总目录](README.md) ｜ 关联：[specs/003 草稿闭环](../specs/003-group-message-job-facts-loop/spec.md)、[specs/016 判断抽取](../specs/016-judgment-extract-loop/spec.md)、[specs/022 推送精准度](../specs/022-client-feedback-signals/spec.md)、[回流清单讨论（2026-09-23 上午）](2026-09-23-data-governance-ops.md)

**定义**：第一批冷启动 = 以 2026-09-23 回流清单为基准，对现有存量做第一次全链路激活——GLM 语义清洗（进行中）是第 0 步，人工确认是第 1 步，标签重导与影子重评是收官。**本表是冷启动期间的唯一记账口径**，早间快照中已被当日动作改变的数字以本表实测列为准。

## 基线表 v1（2026-09-23 17:55 生产库实测）

| 环节 | 表 | 早间报告 | 17:55 实测 | 冷启动目标 | 动作与归属 |
|---|---|---|---|---|---|
| 群消息原文 | lark_messages / workflow_event_log | 16,993 / 16,976 | 健康 | 维持（retention 归档管线已验证：107+107 首档） | specs/021 |
| 职位事实草稿 | job_facts_drafts | 8,037，confirmed 4 | **pending 122 / confirmed 4 / rejected 8,132**（队列已瘦身，dispatcher 持续产新） | **confirmed ≥ 50**；当前 pending 全量有一轮处置结论 | GLM 清洗跑批中（A 批 8,127 复活分类 + B 批 99 拆稿）→ apply dry-run → 咪批准实写 → 顾问确认 |
| 顾问判断 | judgment_drafts | 0 | **14 pending** | **≥ 10 有结论** | specs/016 确认队列 |
| 推荐曝光回传 | recommendation_impressions（served_at 非空口径） | 340/7,820 = 4.3% | **380/8,360 = 4.5%** | 冷启动外（需修回传链路，specs/022 US7 诊断） | 断点诊断另立 |
| 行为反馈 | recommendation_feedback | 72 | 72 | 冷启动外（NOT_INTERESTED 单通道是既定纪律） | — |
| 业务结果 | job_outcomes | 11 | **11** | **≥ 30 且可回放** | 来源：草稿确认后产生的职位推进 + 判断草稿确认；specs/022 A 层 INTEREST 事件回写属第二批 |
| LTR 训练 | ltr-export.jsonl / 影子评估 | 203 行，NDCG@10 0.61 / recall@50 0.31 | — | **重导 ≥ 230 行**，影子重评出 v1 对照报告 | 冷启动收官动作 |
| 客户反馈事件 | workflow_event_log（specs/022） | — | — | 第二批（specs/022 US1，规则版已定稿待施工） | — |

## 冷启动 DoD（完成定义）

1. **队列清零一轮**：冷启动启动时点的 pending 草稿（122 + 期间新增）全部有处置结论（confirmed / rejected），不再有从未被看过的存量；
2. **复活稿进入二轮**：A 批 GLM 判 REAL_JOB 的复活稿全部进 pending（source='llm-recovery'）并被顾问处置或明确批量回拒；
3. **job_outcomes ≥ 30** 且每条可回放（brainx_replay 可见）；
4. **judgment_drafts ≥ 10 条有结论**（specs/016 首批闭环走通）；
5. **LTR 重导 + 影子重评**：导出行数 ≥ 230，产出与旧 203 行口径的 NDCG@10 / recall@50 对照；
6. 本表更新为 **v2**（冷启动后口径），未达标环节如实标注，不粉饰。

## 纪律（延续 2026-09-23 拍板）

- GLM 只产建议，复活/拆稿一律 pending 等人工确认，绝不直接转正；
- 清洗动作不发评审事件，extract.field_confirm_rate 只反映真实人工评审；
- GLM 产物全部留痕（source / raw_json 内 llm_* 字段），可追溯可回滚；
- apply 写库前必须 dry-run 过咪的复核；kill-switch BRAINX_LLM_CLEANUP 保守默认关。

## 当前进度钩子

- GLM 清洗（gpt-5.6-luna，团队 CPA 代理）：17:46 启动，17:55 进度 127/8,127、0 失败，预计 ~4.5 小时；日志 ECS /tmp/cleanup-run.log，断点续跑。
- 完成后顺序：apply dry-run 计划 → 咪复核 → --apply → 顾问确认队列（第 1 步）→ outcomes/重导（收官）。

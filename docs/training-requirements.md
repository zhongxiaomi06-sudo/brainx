# 训练组织要求（Brain X 排序迭代 v1，2026-08-24）

目标读者：负责「算法排序优化」的执行人（排期：Mia 初版 → hanyu 优化）。
范围：六维加权打分框架（`src/scorer.js`，POLICY_VERSION=baseline-1.0）的数据驱动迭代纪律。

## 1. 标签定义（事件 → 标签映射）

| 数据来源 | 条件 | 标签值 |
|---|---|---|
| decision_events | 推荐后 7 天内 ACCEPTED | +2（强正） |
| decision_events | 推荐后 7 天内 WATCHED / VIEWED | +1（弱正） |
| decision_events | DISMISSED（含 reason） | -2（强负） |
| 无任何事件 | 推荐后 7 天静默 | -1（弱负） |
| recommendation_feedback | NOT_INTERESTED | -2（强负） |
| job_outcomes stage='人工标注' | 会接/会看/没兴趣/不确定 | +2/+1/-2/0 |
| job_outcomes rating（交付结果） | 1-5 | 质量乘数（终局标签，权重最高） |

冲突裁决：同一（顾问，职位）多源标签时，人工标注 > 行为事件 > 反馈 ×；时间新的覆盖旧的。

## 2. 量级门槛

| 阶段 | 最小标签量 | 可做的事 |
|---|---|---|
| 现在 | ~150（首批人工标注 7×20=140 + 真实行为） | 粗粒度网格搜索调权重（几十组候选，防过拟合） |
| 下一次晋升 | ≥300 正样本 | logistic 回归拟合 P(承接\|六维分)，系数映射权重 |
| 持续 | 每周自然行为 ≥50 | 周度评估报表（Top20 承接率/忽略率/DISMISS 率） |

未达门槛不得晋升 POLICY_VERSION。标签量查询：`npm run data:audit`。

## 3. 数据质量门（每次训练前必查）

- 当轮 sync_runs.complete=1 的推荐才入训练集（不完整同步的推荐是脏样本）；
- breakdown_json 非空（空行无法提供特征）；
- evidence_coverage ≥ 0.5 的行才能用于「分数→动作」阈值校准（OBSERVE 强制行会稀释信号）；
- 诊断脚本无 high 级 verdict（`npm run diagnose -- --db data/brainx-cloud.db`）。

## 4. 迭代节奏

- **每周**：`npm run data:pull` → `npm run data:audit` + `npm run diagnose`（5 分钟，只读）；
- **每月**：一次权重评审会——诊断报告 + 标签量 + 网格搜索/回归结果 → 决定是否晋升；
- **晋升纪律**：新权重先 dry_run 影子对比（同快照 diff 两份 Top20）→ replay 历史指标全胜 → POLICY_VERSION bump（baseline-1.x 递进）→ 冻结旧版本永不改写。

## 5. 角色分工（对齐排期表）

| 角色 | 职责 |
|---|---|
| Mia（初版） | 反馈回写维护（F1-F4 已交付）、打标组织（labeling-standard-v1 执行）、周度评估 |
| hanyu（优化） | 诊断报告解读、权重网格搜索/回归、POLICY_VERSION 晋升提案 |
| 曾老师 | 工程架构评审、云端运维（恢复清单执行、deploy）、数据质量门仲裁 |

## 6. 红线

- 不改冻结的 recommendations 行（训练特征只读快照）；
- 人工标注绝不写入 recommendation_feedback（会触发生产降权），一律走 job_outcomes stage='人工标注'；
- 任何权重变更必须可回放复现（同一快照 + 同一 policy_version → 同一 Top20）。

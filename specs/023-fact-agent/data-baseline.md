# 数据基线与验证方法论（specs/023 附属）

> 上级：[specs/023 字段补全 Agent 与 served 埋点闭环](./spec.md)

本文是 023 立项的全部实测数字来源与验证口径。数据采集方式：2026-09-24 通过 SSH 对生产库 `/opt/brainx/data/brainx.db` 以 `node:sqlite` 只读模式执行诊断脚本（零写入、零代码改动，临时脚本已清理）。所有数字可由本文 SQL 口径复现。

## 1. 档位塌缩现状（问题侧基线）

### 1.1 全体分布

各顾问最新 COMPLETED 轮（2026-09-24，每人 Top200 冻结推荐）action 分布：

| 顾问 | ACCEPT | WATCH | OBSERVE | OBSERVE 占比 |
|---|---|---|---|---|
| felix | 0 | 0 | 200 | 100% |
| frankie | 0 | 0 | 200 | 100% |
| hiroshi | 0 | 0 | 200 | 100% |
| linda | 8 | 77 | 115 | 57.5% |
| mia | 0 | 12 | 188 | 94.0% |
| miya | 0 | 0 | 200 | 100% |
| otto | 0 | 0 | 200 | 100% |
| shanon | 0 | 27 | 173 | 86.5% |
| wendy | 0 | 0 | 200 | 100% |
| york | 0 | 73 | 127 | 63.5% |
| **合计** | 8 | 189 | 1,803 | **90.1%** |

近 7 天全部 COMPLETED 轮汇总：OBSERVE 4,796 / WATCH 574 / ACCEPT 30。

### 1.2 双闸门机制（代码证据）

- 闸门一 `actionOf`（src/scorer.js L226）：coverage<0.5 → OBSERVE（硬规则）；coverage≥0.5 前提下 score≥75 → ACCEPT、≥55 → WATCH。
- 闸门二 `dataConfidenceOf`（src/recommendation-presentation.js L58）：criticalFields 4 项（active_state/relation/hc/current_stage）缺 ≥2 项，或事实超 30 天未更新（stale）→ INSUFFICIENT → **无条件强制 OBSERVE**（src/recommend.js L163）。

### 1.3 典型降档样本（york 最新轮 Top5）

| rank | project_id | score | coverage | missing | age_days | stale | 实际/应为 |
|---|---|---|---|---|---|---|---|
| 1 | JCGQ95P | 75.5 | 0.85 | 当前阶段 | 42 | ✓ | OBSERVE / **应为 ACCEPT** |
| 2 | JDPNHCY | 68.7 | 0.65 | 招聘状态+当前阶段 | 258 | ✓ | OBSERVE / WATCH |
| 3 | JPLWQP0 | 67.8 | 0.85 | 当前阶段 | 34 | ✓ | OBSERVE / WATCH |
| 4 | P-FIX-3EE6811B | 67.4 | 0.85 | HC+当前阶段 | 48 | ✓ | OBSERVE / WATCH |
| 5 | JBHRI4Z | 65.9 | 0.65 | 招聘状态+当前阶段 | 134 | ✓ | OBSERVE / WATCH |

york 整轮降档原因分布（200 条）：`招聘状态+当前阶段+STALE` 92 条、`当前阶段`(PARTIAL) 73 条、`当前阶段+STALE` 31 条、`HC+当前阶段+STALE` 4 条。

### 1.4 linda 对照组（为什么她能出 ACCEPT）

linda 画像关键词为空、manual_fact_overrides 为 0 条。她的 8 条 ACCEPT 全部：coverage 0.85、只缺「当前阶段」1 项（PARTIAL）、age_days 1-29（不 stale）。**结论：linda 不特殊，她的 top 候选恰好 captured_at 新鲜 + active_state 有值。** 档位差异是数据新鲜度差异，不是顾问差异。

### 1.5 stale 的结构性根源

`captured_at` 语义 = 「事实最后变化时间」（src/sync.js L124，字段变化才前进），不是「最后同步时间」。稳定职位的时钟永不走：23,294 个职位中 captured_at 超 90 天的占 18,273（78%）。同时 `chat_last_at`（群活跃）不计入 `dataConfidenceOf` 的 latestFactAt——york rank1 的群 30 天内活跃（chat_msgs_7d 有值），照样判 stale 42 天。

## 2. 字段填充率（生产 job_facts，23,294 行）

| 字段 | 填充率 | 说明 |
|---|---|---|
| hc | **99.3%**（23,136） | hc=1 占 9,353——「HC 缺失」不是真缺口，修正早前误判 |
| current_stage | **无此列** | 唯一自动来源 cockpit_facts 全库仅 20 行——真缺口 ① |
| active_state | **12.0%**（2,794） | 大部分职位 UNKNOWN——真缺口 ② |
| pipeline | 72.5% | 「Interview×4 Recommendation×7」型进度文本 |
| notes | 99.4% | |

## 3. 语料边界（agent 的原料，lark_messages 18,763 条）

- 时间跨度 2026-06-24 至 2026-09-24；origin：gateway 17,841 + backfill 922。
- **147 个 job 绑定群，覆盖 16,493 条消息**（87.9%）；196 个群中有 49 个未绑定职位。
- 信号消息存量（关键词口径）：面试阶段类 1,499、offer 类 493、HC 类 146、状态类（暂停/关闭/满了/招完/急招）99——合计约 2,237 条（去重前口径，供回填预算）。
- **增量约 75 条/天**（近 7 天 528 条）。
- 消息正文是 post 富文本 JSON（`{"title":...,"content":[[{"tag":"text",...}]]}`），需解析层——specs/003 管线已验证（job_facts_drafts 8,657 条 active_state 草稿）。
- **chat→job 一对多是常态**：1,353 个群绑 1 个职位，603 个绑 2 个，长尾到 135 职位/群 → 消歧三分叉（spec FR-2）的依据。
- 富文本中真实信号样本（可抽取性实证）：「长期招聘HC不限」「跨境金融科技新增hc，直接汇报coo」「Pix又发出了一张MLE实习offer」。

## 4. 六冷启动顾问的约束（本 spec 治不了的部分）

frankie/hiroshi/miya/otto/felix/wendy 六人 100% OBSERVE 的主约束是**闸门一不是闸门二**：profile_keywords 空 + 无 MY_JOB/PRIMARY_PM 历史 → direction 维记 null（不惩罚）→ coverage 恒 0.45 < 0.5 → 硬规则 OBSERVE。字段补全对他们无效（模拟实验 S2 下纹丝不动）。他们的解药是画像建设（T8 任务面板真值 / 接单历史），属后续模块，**AC-4 中他们不动是预期不是回归**。

## 5. 验证方法论（跑动验证四层）

### 5.1 回填前——抽样人工核对（质量门）

- 口径：从预筛命中的候选消息随机抽 30 条，人工标注期望的 (field, value)，与 dry-run 输出对比。
- 通过线：字段级正确率 ≥80%（AC-2）。低于则修 prompt/枚举映射表重跑，**不降标准不跳步**。
- 注意：post 富文本要先把嵌套 content 拍平成纯文本再给标注者，避免把格式噪音算成抽取错误。

### 5.2 回填中——幂等与对账

- 同一批连跑两轮 `--backfill`，第二轮 DB 零新增行；CLI 统计（成功/失败/群级/低置信）与 `SELECT COUNT(*)` 逐项对账。

### 5.3 回填后——影子对照（本 spec 的效果证明）

复现模拟实验口径，**用真实 job_agent_facts 数据替换近似假设**：

- S0（现状）：对最新冻结轮重放 `dataConfidenceOf + actionOf`，应与库内冻结 action 完全一致（校验重放逻辑本身无 bug）。
- S2（开启 agent）：合成层插入 AGENT 档后重放，输出 dataConfidence 三档分布 + action 分布的前后对比，按顾问分列。
- 模拟实验参考值（关键词近似，量级锚点可能偏高，见 §6）：

| 顾问 | S0（A/W/O） | S2 模拟（A/W/O） |
|---|---|---|
| linda | 8/77/115 | **20/101/79** |
| york | 0/73/127 | 1/84/115（rank1 解锁 ACCEPT） |
| shanon | 0/27/173 | 1/39/160 |
| 六冷启动顾问 | 0/0/200 | 0/0/200（预期不动） |

- 影子对照**只读不写**：不得改生产 recommendations / decision_runs；报告随 ④ 号 commit 归档（outputs/ 或 docs/audits/）。

### 5.4 上线后——持续观测

- 每日增量统计（候选/命中/成功/失败/token）+ served 置位率周报（基线 4.3%，见 §7）。
- 异常触发回查：抽取成功率骤降（<90%）、群级占比异常升高（>30%，说明消歧在退化）、档位分布突变（周环比 ACCEPT+WATCH 占比波动 >10pp）。

## 6. 当前数据结论的不足（已知局限，开发须知）

1. **模拟的乐观假设**：S2 用「群内有关键词 → 该字段可补」近似 GLM 抽取能力。真实抽取率受富文本噪音、口语变体、消歧失败三重折损，AC-4 量级锚点应视为**上界**。
2. **信号存量是单轮快照**：2,237 条未做去重与跨时间稳定性验证；75 条/天基于近 7 天窗口，波动性未知。
3. **「群活着 → OPEN」是推断不是事实**：群活跃不等于职位在招。FR-4 把 AGENT 填补的 band 上限压到 PARTIAL 正是对此的防线——推断不得直接产生 ACCEPT 级信任。
4. **served 4.3% 是断链读数**：前端回传链路断掉状态下的基线，修复后的「正常置位率」无历史参照，AC-5 只验链路通与趋势。
5. **hc 缺失曾被误判**：早期结论「hc 飞书源基本不产」已被 99.3% 填充率推翻——**hc/relation 不进 MVP 抽取范围**就是这次纠错的直接后果。开发时勿引用旧结论。

## 7. 推送侧基线（served 埋点相关，push_log 实测）

- 累计 942 SENT / 109 FAILED：DAILY_TOP3 403 发/103 败、STAGE_REMINDER 490 发（已成推送主力）、PROJECT_REMINDER 40/6、RELEASE_NOTICE 9。
- 近 7 天 DAILY_TOP3 发出 126 张。
- 近期活跃失败仅 3 条/天：wendy `oc_demo_src_*` demo 群 ×2（invalid receiver）+ linda 一条（bot 不在群）；103 条失败大头是 09-02 历史 config 批量——**demo 群过滤属另案，不在 023 范围**。
- `recommendation_impressions.served_at` 置位 340/7,820（4.3%）——卡片展示→回写链路断点，Story 5 修复对象。
- 审计断链佐证：DAILY_TOP3 的 run_id 是「日期#时段」格式（如 `2026-08-25#1900`），非 decision_run UUID（push_log 补 UUID 属推送四件套，另案）。
- 文案诚实化佐证：miya/frankie/hiroshi 收到的卡片标题「今天建议优先处理 3 个职位」+ 副标「数据完整」，实际 3 条全 OBSERVE、Fit 维为空（`Fit — ·`）。

## 8. 复现口径（诊断 SQL 骨架）

```sql
-- 最新轮与 action 分布
SELECT consultant_id, run_id, created_at FROM decision_runs
WHERE status='COMPLETED' AND created_at = (
  SELECT MAX(created_at) FROM decision_runs d2
  WHERE d2.consultant_id = decision_runs.consultant_id AND d2.status='COMPLETED');
SELECT action, COUNT(*) FROM recommendations WHERE run_id=? GROUP BY action;

-- 降档原因（从冻结 evidence_refs 提取）
-- evidence_refs_json 中 type='decision_presentation' 的 metadata.data_confidence
-- → {band, missing_fields[], stale, age_days}

-- 字段填充率
SELECT COUNT(*) FROM job_facts WHERE hc IS NOT NULL AND hc!='' AND hc!='UNKNOWN';

-- 绑定群与信号密度
SELECT COUNT(*) FROM lark_messages m WHERE EXISTS (
  SELECT 1 FROM job_facts j WHERE j.chat_id = m.chat_id);
SELECT COUNT(*) FROM lark_messages WHERE text LIKE '%二面%' OR ...;

-- served 基线
SELECT served_at IS NOT NULL, COUNT(*) FROM recommendation_impressions GROUP BY 1;
```

（完整脚本随 ③ 号 commit 的 dry-run 工具一并提供，口径以本文为准。）

# 第一批客户健康数据落地与算法驱动推送（specs/022 US6 增量）

> 上级入口：[文档书总目录](README.md) ｜ 规格：[specs/022 客户反馈信号回流](../specs/022-client-feedback-signals/spec.md) ｜ 相关：[顾问判断抽取回路](2026-09-22-judgment-extraction.md)

2026-09-25 建立。把《TTC 客户健康度 · 200家随机抽样全景大盘》（2026-09-18，近 90 天飞书客户群消息，规则版指标 v2）作为第一批客户健康数据落库，并落地生命周期分档的算法驱动推送。

## 接口与数据验证结论（2026-09-25 实测）

**接口满足度**：推送链路（`scheduler.pushSlotFor` → `pushCard`，push_log 幂等）、推荐算法入口（`recommend()` / `scorer.js` 六维加权）、顾问↔群（`consultant_chats`）与群↔职位（`job_facts.chat_id`）映射全部现成；缺口是 `client_metrics` 表（本次 0058 补建）。

**第一批数据成立性**：报告 200 家全部带 chat_id；**160/200（80%）可 join 到生产 `job_facts`，共 966 个职位、434 个活跃**，覆盖 6 名顾问、84 条顾问↔群关联。40 家无职位关联只入表不进推送。注意：`c_dec`（决策效率）200 家全零，第一批该指标落库但不可用，特征层（US4）不引用。

## 落地内容

- `migrations/0058_client_metrics.sql`：`client_metrics`（8 指标 + stage + health_badge + source/window）+ `client_metric_benchmarks`（p25/p50/p75，按 anchor_version 冻结，锚点漂移必须 bump 版本——specs/022 红线）
- `bin/brainx-client-metrics-import.mjs`：报告 HTML 内嵌 JSON 解析（括号配平 + 字符串感知）→ 幂等 upsert；默认 dry-run，`--write` 落库
- `src/client-metrics.js`：只读取数 + `pushPolicyFor(stage)` 策略常量表 + `applyLifecyclePolicy`（dormant 剔除、cold_start 在卡片依据行注入「破冰优先」标注）+ `listFirstBatchConsultants`
- `bin/brainx-first-batch-push.mjs`：第一批顾问的最新算法推荐 → 策略层过滤/标注 → `buildDailyCard` → `pushCard(kind='FIRST_BATCH_TOP3')` 幂等；默认预览，`--send` 真发且只推顾问本人私聊（与 autopush 同一安全边界：绝不推群）

## 边界与红线

- 不改动线上排序（策略层只做剔除/标注，不重排）；v2 客户特征进排序仍走 specs/022 US4 影子评估门槛
- 不触碰 `recommendation_feedback` 通道；served 曝光修复是 US7 另案
- 报告快照是一次性导入（source=`report-snapshot-2026-09-18`）；指标日常化计算器是 US2，落地前本表不会自动更新
- 休眠档零推送的另一半（每周 BD 移交清单）未做，US6 剩余项

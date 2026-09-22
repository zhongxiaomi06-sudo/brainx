# 顾问判断抽取回路（judgment-extract）

> 上级入口：[文档书总目录](README.md) ｜ 姊妹域：[群消息 → job_facts 提炼层研发路径](2026-09-02-job-facts-extraction-roadmap.md) ｜ 规格：[specs/016](../specs/016-judgment-extract-loop/spec.md)

2026-09-22 建立。第二个信息域的抽取回路：从顾问群聊中抽取**业务判断**（客户偏好、硬性要求、例外规则、否决原因、评价），经人工确认后进入权威表 `judgment_facts`。

## 与 job-extract 的关系

完全复刻其四层模式，复用原文层与账本层，零改动：

```
lark_messages（原文，已有）→ workflow_event_log（账本，已有）
  → judgment_drafts（staging，本域新增）→ 人工确认 → judgment_facts（权威，本域新增）
```

`consumeJudgmentExtract` 与 `consumeJobExtract` 是同一 `lark.message_received` 事件上的两个独立消费者，`consumeOnce` 各自幂等，互不干扰。接线点：`src/job-extract/bridge-producer.js` 的 `produceOne`（bridge 链路）。

## 抽取 schema

| 字段 | 取值 | 说明 |
|---|---|---|
| subject_type | CLIENT_COMPANY / PROJECT / CANDIDATE / GENERAL | 判断对象类型，可空（泛化判断无明确对象） |
| subject_ref + subject_evidence | 文本 | 判断对象 + 原文锚点 |
| kind | PREFERENCE / CONSTRAINT / EXCEPTION / REJECTION / EVALUATION | 偏好 / 硬性要求 / 例外规则 / 否决原因 / 评价 |
| statement + statement_evidence | ≤120字 | 归一化陈述 + 原文锚点 |
| confidence | high / medium / low | evidence 与原文重合 = high |
| project_id | 可空 | 由确认人在转正时指定（fail-closed 校验可见性） |

## 纪律（与 job-extract 相同）

- 宁缺勿错：无原文 evidence 的字段一律丢弃，不进权威表
- `isJudgmentRelevant` 关键词规则先行砍 LLM 成本；LLM 失败/schema 违规静默降级规则层
- 规则层故意保守：只抓"客户说…不接受/只要…"类显式句型，本域语义重，其余留给 LLM 层
- LLM 开关独立：`AI_JUDGMENT_EXTRACT_ENABLED=1`（默认关），与 `AI_JOB_EXTRACT_ENABLED` 平行
- 正文 PII 不进账本 payload；对外投影 evidence 脱敏（邮箱/手机号）
- 无可抽取判断（statement=null）时消费层 skip，不落空草稿——判断域的空草稿对确认队列是纯噪音

## 确认入口

agent 工具 `brainx_pending_judgments` / `brainx_review_judgment`（复用 `job_fact_review` 授权域，已外露 OpenClaw 插件）。确认血缘走 `sync_runs(source='lark_judgment_extract')`。

## 已知边界（本版不做）

- WS 网关链路（`bin/brainx-lark-gateway.mjs`）落原文和账本后未接任何抽取消费者（job-extract 同此现状）；补 WS 链路抽取是单独任务
- 判断的 supersede/推翻语义：V1 权威表只追加，推翻旧判断 = 新增一条
- `judgment_facts` 的下游消费（回流推荐排序、顾问画像）是后续任务

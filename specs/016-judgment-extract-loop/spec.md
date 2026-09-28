# 016｜顾问判断抽取回路（judgment-extract loop）

> 设计契约与纪律：[docs/2026-09-22-judgment-extraction.md](../../docs/2026-09-22-judgment-extraction.md)

## 需求

从顾问飞书群聊中抽取业务判断（客户偏好/硬性要求/例外规则/否决原因/评价），作为继职位事实（specs/003）之后的第二个抽取信息域。目标是把"企业特异性的规则与例外"从对话沉淀为可确认、可追溯的结构化事实。

## 范围

- 复用 `lark_messages` 原文层与 `workflow_event_log` 账本层，零改动
- 新增 `judgment_drafts`（staging）与 `judgment_facts`（权威表），migration 0051
- 新增 `src/judgment-extract/`：schema / classify（规则+LLM）/ index（账本消费者）/ confirm（确认闭环）
- bridge 链路接线（`produceOne` 追加独立消费者）；开关 `AI_JUDGMENT_EXTRACT_ENABLED`（默认关）
- agent 工具 `brainx_pending_judgments` / `brainx_review_judgment`，复用 `job_fact_review` 授权域，外露 OpenClaw 插件

## 不做（V1 边界）

- 不泛化为多域注册框架（第三个域出现时再考虑）
- 不接 WS 网关链路的抽取（job-extract 也未接，单独任务）
- 不做判断的 supersede 语义；不做 judgment_facts 下游消费

## 验收

- `tests/judgment-extract-rules.test.mjs` / `-consumer.test.mjs` / `-confirm.test.mjs` 全过
- 一条"客户说 X 不接受 Y"群消息走完 原文→账本→草稿→确认→权威表 全链，每步幂等
- 无 evidence 字段不进权威表；LLM 关闭时规则层独立可用

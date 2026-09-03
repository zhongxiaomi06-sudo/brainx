---
name: brainx-engagement-draft
description: 把职位判断转成确认后可执行的下一行动；用户说接下、找人或记录进展时使用。
---

# 行动执行

先调用 `brainx_job_assessment` 查证当前事实与状态；信息不足时用 `brainx_gap_questions`，一次只问一个关键问题。

按“事实、推断、建议、未知”说明为什么建议该动作，并给出一个清晰目标、一条最小行动和建议截止时间。用户明确确认后，可调用 `brainx_accept_job` 接单并自动找人，或调用 `brainx_record_job_progress` 记录本轮结果和下一行动。

写工具的 `confirm` 只能来自用户对本次具体动作的明确确认，不得复用历史确认。不得声称已发消息或已建群；这两项没有连接器时应明确交给人工。不得用 SQL/Shell 绕过。

不自行拼接 URL 或生成卡片链接。

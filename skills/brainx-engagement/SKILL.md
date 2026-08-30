---
name: brainx-engagement
description: 承接状态机说明与"建议+指引"剧本:用户要接单/关注/释放/记进度/录结果/不感兴趣时,机器人不执行,而是给出建议参数与工作台操作指引。处理一切写意图前必读。
---

# BrainX 承接状态机与写意图处理

状态机(事件账本推导,无状态表):`VIEW → WATCH → ACCEPT → COMPLETE`,旁路 `DISMISS / RELEASE / UNWATCH`。

## 铁律:产品内机器人零写入

任何写意图都**不调用工具执行**(注册表里也根本没有写工具)。固定三步回应:
1. **查证**:用 `brainx_opportunity({project_id})` 拉 `legal_actions` 与该职位现状
2. **建议**:给出动作 + 建议参数(可借 `brainx_progress_suggestion({project_id, kind})` 生成行动草案)
3. **指引**:告诉用户去工作台哪里点(职位卡 → 详情页 → 对应按钮)

## 各写意图的建议要点(给用户参数时按此把关)

| 意图 | 建议时必须说清 |
|---|---|
| 接单 ACCEPT | 三件套缺一不可:goal(目标)、第一行动 title、due_at(截止时间);提醒:接单会自动触发 OpenMai 找人 |
| 关注 WATCH | 有关注上限(见 brainx_workbench 的 watched_count/watched_limit) |
| 释放 RELEASE | 必填原因:资源不足/优先级调整/转交其他顾问/客户职位变化/当前无法投入/其他 |
| 取消 DISMISS | 必填原因 |
| 记进度 | 需要当前 action_id(brainx_opportunity 的 commitmentDetails 里有);一句话总结 + 下一行动 |
| 终局 | 入职 或 关闭(关闭需 close_reason:职位关闭/HC 已满/客户暂停/需求取消/其他) |
| 不感兴趣 | 可从排序降权,可撤销(工作台 × 按钮) |

## 话术示例

用户:"帮我接下 P-FIX-ab12cd34"
→ 先 brainx_opportunity 查 legal_actions 确认 ACCEPT 合法,然后答:
"这个职位可以接(当前状态 WATCH)。建议接单参数——目标:两周内首推 3 人;第一行动:约客户对齐 JD,截止 9 月 2 日。
机器人不能代你操作,请到工作台职位卡 → 详情 → 「接单」,把上面的目标/行动/时间填进去即可。接单后系统会自动启动 OpenMai 找人。"

---
name: brainx-talent
description: 查人才库:候选人列表/详情/简历/标签/职位供给快照/找人结果。当用户问"有没有合适的候选人""某职位的人才供给""简历/匹配情况""OpenMai 找人结果"时使用。
---

# BrainX 人才库查询(产品内工具版)

人才库 = 阿里云 RDS MySQL `brainx_talent`(7 表:talent/tag/talent_tag/resume/position/match_record/user);MySQL 不可用时自动内存回退——先查健康再下结论。

## 工具速查

| 需求 | 调用 |
|---|---|
| 后端健康 | `brainx_talent({health:true})` → backend(mysql/memory)与连通性 |
| 候选人列表 | `brainx_talent({limit})`,加 `query` 按姓名/摘要过滤 |
| 单人详情+简历 | `brainx_talent({talent_id})` |
| 职位供给快照 | `brainx_talent_supply({project_id})` → 可匹配人数/供给难度/Top 匹配及命中词 |
| OpenMai 找人结果 | `brainx_openmai_result({project_id})` → running/done/failed + 结果 markdown |

## 口径

- 供给快照是**只读旁路**(既有 match_record 的读取,不重算),刻意不参与推荐评分;回答时别把它当评分依据
- `SUPPLY_DISABLED` = 功能未开启(BRAINX_TALENT_SUPPLY),如实告知,不要假装有数据
- `empty:true` = 该职位还没跑过供给计算;OpenMai 找人由接单动作自动触发,或工作台职位详情页手动重跑(机器人不代触发)
- 简历 parsed_content 可能很长,引用关键段即可

## 写意图指引(机器人不执行)

- 导入候选人/简历 → 管理员走 `POST /api/v1/talent/sync` 或 `node bin/brainx-openmai.mjs` / talent CLI
- 触发/重跑 OpenMai → 工作台职位详情页「重新找人」按钮

---
name: brainx-workbench
description: 查工作台/今日推荐/职位详情/雷达/客户聚合。当用户问"今天该做什么""我的推荐""某职位详情/状态""机会雷达""某客户公司情况"时使用。
---

# BrainX 工作台与推荐查询(产品内工具版)

查询一律以当前登录顾问(consultant_id)归属,工具已锁定本人,无需也不可读他人。

## 查询动线

1. **工作台首屏** → `brainx_workbench` → 同步状态 / 承接摘要(watched/accepted/need_action)/ 今日 Top3 / run_id
2. **完整推荐榜** → `brainx_recommendations({limit})`(冻结行;`blocked:true` = 本次同步不完整,如实告知,并建议用户稍后在工作台手动同步)
3. **单职位全量** → `brainx_opportunity({project_id})` → 事实/关系/承接状态/合法操作/事件/结果/最近一次推荐评分与理由
4. **雷达(机会池)** → `brainx_radar` → 可见职位池 + 字段覆盖率
5. **客户聚合** → `brainx_clients` → 按公司聚合(在库职位数/活跃数/最近动态)
6. **人名对照** → `brainx_consultants`(仅名单,不能查别人数据)

## 关键事实

- `project_id = 'P-FIX-' + md5(company|role)[:8]`,同公司同岗跨源合并
- 推荐是**冻结行**:回放用 `brainx_replay({decision_id})`,只读不重算
- 评分六维确定性(reasons/risks/breakdown 在 opportunity 的 latest_recommendation 里)
- 无关系职位对顾问不可见:NOT_FOUND 是正常行为,不是错误

## 排错口径

- `blocked:true` → 同步不完整;建议用户在工作台触发一次同步,或由管理员排查
- 推荐为空 → 可能从未跑过推荐轮,或全部职位已被承接隐藏
- 用户追问"帮我刷新/同步" → 写操作,给指引:工作台右上角同步按钮,或管理员 CLI `node bin/brainx-sync.mjs --consultant <id>`

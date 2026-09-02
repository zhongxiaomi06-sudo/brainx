---
name: brainx-talent
description: 查询本人已获授权职位的脱敏候选 shortlist；用户问合适候选人、岗位匹配、人才推荐或待确认项时使用。
---

# BrainX 候选人 shortlist

## 唯一允许的读取路径

调用 `brainx_candidate_shortlist`，只传业务参数：

- `job_id`：当前职位引用；
- `limit`：1—20，默认 5；
- `purpose`：默认 `candidate_review`；
- `page_token`：仅翻页时原样传回。

顾问和租户由服务端绑定，不能从聊天正文推断或覆盖。工具返回空时，只说“没有可展示的已授权候选人”，不得判断人才是否存在。

## 回复口径

- 姓名只使用工具返回的掩码；
- 分开写“候选人实力”和“本职位匹配”，不得合成录用概率；
- 推荐理由只引用 `summary`，关键缺口写 `gaps`、`risks`、`unknowns`；
- `UNKNOWN` 表示待核实，不得改写为不满足；
- 明确算法版本。`reloop-existing-recommendation-v1*` 是现有 reloop 推荐的结构化转换，不是 BrainX 新算法重排；
- 不索取、不输出、不猜测手机号、邮箱、完整姓名、简历原文或飞书路由 ID；
- 不调用 SQL、Shell、文件、网页或通用人才浏览工具补数据。

需要联系方式或简历详情时，告知用户应在权威人才系统内按权限查看；当前 Agent 工具不提供这些字段。

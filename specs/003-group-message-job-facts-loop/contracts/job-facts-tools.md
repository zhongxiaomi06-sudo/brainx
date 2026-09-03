# Contract: 职位事实草稿工具

## `brainx_pending_job_facts`

- 场景：私聊读取当前真实操作者有权审核的待确认草稿。
- 输入：`limit`，可选整数 1–20。
- 输出：`draft_ref`、company/role/city/pipeline_stage、字段证据、来源时间、来源群的脱敏引用。
- 禁止：完整消息历史、其他顾问不可见群、手机号、邮箱、任意 SQL。
- 下一动作：`brainx_review_job_fact`。

## `brainx_review_job_fact`

- 场景：私聊确认或拒绝一条本人可见草稿。
- 输入：`draft_id`、`action=confirm|reject`、可选 `job_id`、`confirm=true`。
- 约束：真实操作者 active；来源群已登记且本人属于该群；指定职位时本人必须可见。
- 结果：确认返回职位稳定引用和血缘；拒绝返回终态；重复裁决保持幂等或返回已处理。
- 禁止：群聊直接写、模型自行设置 `confirm=true` 而未向用户复述、跨人草稿裁决。

## 错误口径

- `UNBOUND_IDENTITY`：未绑定或已离职。
- `NOT_FOUND_OR_FORBIDDEN`：草稿/职位不存在或无权访问，统一响应。
- `INVALID_ARGUMENT`：参数、状态或显式确认不满足。
- `SOURCE_UNAVAILABLE`：Gateway 或存储暂不可用，可稍后重试。


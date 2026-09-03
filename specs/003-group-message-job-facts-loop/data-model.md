# Data Model: York 六人灰度运行闭环

## 复用实体

### consultants

`active=1` 才能解析为操作者。Otto 改为 `active=0`，仅保留历史引用。

### feishu_identity_bindings

ACTIVE 绑定以 `(channel_account_id, open_id)` 唯一解析真实 `consultant_id`。业务主体 York 不写入该字段替代操作者。

### chat_contexts

管理员显式登记的群权威。首轮仅 `enabled=1` 且已核验的群进入同步；`bot_mode=MENTION_ONLY` 控制对话触发，不改变 Worker 的后台同步授权边界。

### consultant_chats

证明某顾问实际属于某群。草稿读取必须同时满足：顾问 active、草稿来源群已登记、顾问属于该群。

### job_facts_drafts

状态机：`pending → confirmed | rejected`。列表仅返回完成判断所需字段、证据片段和稳定 `draft_id`，不返回完整群历史。

### job_facts / sync_runs / job_memberships

确认时沿用现有事务：创建或更新职位事实、记录 `lark_extract` 血缘，新职位给确认顾问建立可见关系。

### agent_runs / agent_tool_calls

分别保存真实 consultant、技术 channel account、工具、参数摘要与授权结果。York 业务主题只用于展示配置，不替换这些字段。

## 权限关系

```text
ACTIVE identity
  + ACTIVE consultant
  + registered/enabled chat
  + consultant_chats membership
  + p2p review request
  + confirm=true for mutation
  = list/review own visible draft
```

任一条件缺失均返回统一的 `NOT_FOUND_OR_FORBIDDEN` 或 `UNBOUND_IDENTITY`，不泄露草稿是否存在。


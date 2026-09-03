# Quickstart: 六人灰度验收

## 2026-09-03 接通前基线

- 生产 commit：`4784e245f7350eff118bc8df767a549e56662564`。
- `brainx`、`brainx-worker`、`brainx-agent-gateway`、`openclaw-brainx` 均 active；旧 `brainx-integration-worker` disabled。
- `job_facts_drafts`：467 pending、0 confirmed；账本与原文各 1023 条；简历入口台账 0 条；`chat_contexts` 0 条。
- 六个 ACTIVE 身份绑定；Otto 无 ACTIVE 绑定但仍需将 consultant 设为 inactive。
- 根盘使用率 92%；3101/4322 仍监听公网地址，必须在宣布灰度通过前收紧。

## 前置

1. 已备份 `.env`、SQLite、systemd、nginx 和生产 commit。
2. 仅六名在职顾问存在 ACTIVE 绑定，Otto 为 inactive 且无 ACTIVE 绑定。
3. 首轮群已显式登记。
4. `brainx`、`brainx-worker`、`brainx-agent-gateway`、`openclaw-brainx` 为 active。

## 验收路径

1. 在已登记群发送一条脱敏职位消息，10 秒内出现一份 pending 草稿。
2. 六名顾问分别私聊机器人请求“查看待确认职位事实”，只能看到自己所在已登记群的草稿。
3. 顾问确认一条字段完整草稿；验证只形成一份职位事实和血缘记录。
4. 顾问拒绝另一条草稿；验证权威职位事实没有变化。
5. 用另一名顾问尝试裁决不可见草稿，应统一拒绝。
6. Otto 或未绑定账号尝试调用，应返回未授权且不产生工具副作用。
7. 未登记群发消息，不得新增草稿。

## 生产观察

灰度期间同时观察四个服务日志、草稿积压、失败记录、Agent 鉴权拒绝与磁盘。至少连续 24 小时无越权、重复写入和不可解释积压后，才能扩大群范围或切换 York 展示主题。

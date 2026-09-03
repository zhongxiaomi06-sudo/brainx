# Research: York 六人灰度运行闭环

## 决策 1：首轮不自动授权 108 个历史群

- **Decision**: 只登记 OpenClaw 生产配置中已经核验的灰度群，后续逐群扩容。
- **Rationale**: 历史消息存在不等于当前业务授权；自动扩大范围违反默认拒绝。
- **Alternatives considered**: 从 `job_messages` 全量生成群范围或扫描所有顾问会话，都会误纳入私人群或已失效群。

## 决策 2：York 是业务主体，不是审计操作者

- **Decision**: 当前六个 active 飞书绑定继续解析到各自 consultant；展示主题最后切换。技术账号后续从 `mia` 迁移到 `braintex-prod` 时做显式绑定迁移。
- **Rationale**: 当前链路已经能准确区分真实操作者，直接把六人绑定改成 York 会破坏隔离和审计。
- **Alternatives considered**: 所有请求固定 `consultant_id=york`，不可接受。

## 决策 3：草稿审阅走 Agent Gateway

- **Decision**: 增加受限的“列出本人可见草稿”和“确认/拒绝草稿”工具，写操作仅私聊且要求 `confirm=true`。
- **Rationale**: 旧 MCP 只有按 `draft_id` 写入，OpenClaw 用户拿不到草稿列表；直接开放 SQLite/SQL 会扩大攻击面。
- **Alternatives considered**: 维护者手工运行 sqlite3，只能用于救援，不能作为六人业务入口。

## 决策 4：离职撤权保留历史

- **Decision**: 将 Otto 设为 inactive，并撤销残留 ACTIVE 绑定；不删除 consultant、历史消息、动作或审计记录。
- **Rationale**: 授权查询已经联结 `consultants.active=1`，可即时 fail-closed，同时保持历史可追溯和可恢复。
- **Alternatives considered**: 删除 Otto 行或历史数据，不可恢复且破坏审计。

## 决策 5：生产 Worker 权威名称

- **Decision**: 本轮使用现行 `brainx-worker.service`；`brainx-integration-worker.service` 保持 disabled，避免双消费者。
- **Rationale**: 生产实测 `brainx-worker` 正在承担 bridge、简历和推送任务。
- **Alternatives considered**: 同时启用两个 Worker，会导致重复扫描、游标竞争和运维歧义。

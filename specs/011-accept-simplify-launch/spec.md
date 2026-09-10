# 011 — 接单链路简化与「接单直接拉群」

状态：Implemented（2026-09-10）
上游：york 机器人会话诊断（2026-09-10）。证据：09-01 以来 `brainx_accept_job` 网关调用 0 次；模型（stepfun step-3.5-flash）契约遵循差（gap_questions 参数错多次、幻觉工具调用），而接单工具要求一次传全 6 个必填参数。代码侧「接单→拉群」（launchProject）已存在但生产 `project_launches` 全空，从未跑通。

## 1. 三项调整

### 1.1 accept_job 减参（根因修复）

- `brainx_accept_job` 必填参数收敛为 **`job_id` + `confirm`**；`goal` / `action_title` / `due_at` / `idempotency_key` 变为可选，缺省时由服务端生成：
  - goal 默认：`完成候选人搜索、筛选与匹配评估`
  - action_title 默认：`启动候选人搜索并跟进交付`
  - due_at 默认：复用 `workflowDueAt()`（48h 后的 18:00 CST 语义，自 project-launch.js 导出）
  - idempotency_key 默认：`bot:accept:<consultant_id>:<job_id>`（确定性键：同顾问同职位重复调用天然幂等；显式传入仍优先）
- 同步两处声明：`tool-registry.js` required 收敛、`plugins/brainx-openclaw/runtime.js` required 收敛 + 版本 1.3.6→1.3.7。工具名未变，生产 tools.allow 无需改。

### 1.2 skill 写死接单调用模板（治标）

- 三个 sourcing skill（openmai/supermai/reloop）各增加「接单（一句话完成）」节：给出两参调用示例 `{ "job_id": "...", "confirm": true }`，说明服务端自动补默认值、成功后自动启动找人，并强调必须经顾问明确确认后才能调用（保持 agent-skills 测试的「确认」口径）。

### 1.3 web 接单后自动拉群（接单直接拉群）

- `POST /api/v1/opportunities/:id/engagement` 在 `action=ACCEPT` 且成功后，best-effort 调用 `launchProject`：
  - 幂等键 `web-accept-launch:<consultant_id>:<job_id>`；重复接单/已 READY 直接 already，不重复建群。
  - 失败（含 preflight blocker、飞书 API 故障）**不阻塞接单返回**：响应附 `project_launch: { ok:false, code, message }`；成功附 `{ ok:true, launch }`。
  - **拉群对象（默认拍板）**：沿用 launchProject 既有规则——顾问本人为群主，项目协作者（MY_JOB/TEAM_SHARED 且完成飞书绑定的顾问）进群，机器人设为群管理员。后续如需扩邀请（如客户、团队负责人）另立规格。

## 2. 边界与不变量

- 只改 web 端接单路由与接单工具参数；bot 端 `brainx_accept_job` 不自动拉群（群里按钮命令走既有 launch 路由）。
- 接单幂等语义不变（decision_events idempotency_key 去重、already 分支、 repaired 分支全部保留）。
- 接单自动启动 OpenMai 找人的既有行为不变；拉群失败不影响找人触发。
- 证据先行：所有默认值写入响应（active_action），顾问可在工作台看到接单目标与截止时间。

## 3. 验收

1. `brainx_accept_job({ job_id, confirm:true })` 最小参数接单成功，响应含默认 goal/action/due_at；同参重复调用幂等。
2. 显式传全参数行为与旧版一致（回归）。
3. web ACCEPT 成功后响应含 `project_launch`；无飞书凭证环境下该字段为 ok:false 且接单仍 200。
4. 插件声明与网关注册 required 一致为 ['job_id','confirm']；openclaw-plugin 版本断言更新。

## 4. 修订 A（2026-09-10 晚）：接单 SOP——用户全程不碰参数

- 上游：用户反馈「现在的接单很不稳定，大家不想找参数」——减参解决了模型写参数的问题，但用户仍可能被要求报 job_id。
- 全局系统提示（plugins/brainx-openclaw/prompt.js）新增三步接单 SOP：①定位唯一职位（本轮推荐/简报映射，brainx_daily_brief 兜底，对不上列选项让用户挑，绝不让用户找参数）②先给两三句岗位理解（公司·职位·城市·HC·匹配分·风险/缺口）再明确求确认，用户认可即视为确认 ③brainx_accept_job 仅 { job_id, confirm: true }，其余服务端生成；无法唯一定位或未确认不得调用。
- 三个 sourcing skill「接单（一句话完成）」节同步改写为「接单流程（用户不碰参数）」；PLUGIN_VERSION 1.3.7→1.3.8；openclaw-plugin 测试增 SOP 断言。

# 群成员找人权限放开与旧群绑定自愈（2026-09-15）

> 上级：[文档书总目录](README.md) · 相关：[机器人进群接管规格](../specs/015-group-intake/spec.md)、[项目群卡片动作规格](../specs/014-launch-card-actions/spec.md)、[安全操作手册](SECURITY.md)

## 背景与决策

2026-09-14 生产实证（恒星力量群）：共享职位的项目群里，非职位协作者（mia）点候选工具全部
`NOT_FOUND_OR_FORBIDDEN`，自助接单也被拒——当时记录为"设计行为"。2026-09-15 用户决策反转该设计：

1. **职位绑定群里的任何已登记顾问都能点找人/候选动作/自助接单**，不再限于职位协作者
   （MY_JOB/TEAM_SHARED）。群即信任边界：飞书事件投递本身证明发送人在群内。
2. **旧群绑定自愈**：机器人被拉进旧群后，不再依赖 10 分钟轮询登记才能绑定。

信任边界不降级部分：`resolveBinding` 仍要求发送人是绑定状态 ACTIVE 的登记顾问；
私聊与非绑定群仍按 `jobVisibleTo` fail-closed；scope 的 purpose 与 project_refs 校验不变。

## 改动点

| 层 | 文件 | 改动 |
|---|---|---|
| 可见性 | `src/visibility.js` | 新增 `jobAccessibleFromGroup`：调用上下文为群且该群是职位当前绑定群（`job_facts.chat_id` 或 READY `project_launches.chat_id`）时放行 |
| 授权 | `src/agent-gateway/authorization.js` | `authorizeGroup` 不再校验 `allowed_senders`（列保留，写入逻辑不变）；`authorizeIntakeBinding` 对无 intake 登记的群放行到 handler 自愈，`BOUND`/`SKIPPED` 仍拒 |
| 绑定 | `src/group-intake.js` | `bindGroupToProject` 对未登记群实时调 `listBotChats` 核对机器人在群：在群则补登记 SEEN 并继续绑定，不在群仍 `GROUP_NOT_INTAKED`（防越权绑定陌生 chat_id） |
| 工具 | `src/agent-gateway/tools-actions.js`、`tools-jobs.js`、`tools-candidate-actions.js` | 所有 `jobVisibleTo` 检查追加 `jobAccessibleFromGroup` 群上下文放行；`start_candidate_search`/`openmai_search`/`supermai_scout` 的"本人须 ACCEPTED"检查在绑定群上下文同样放行（搜索本就是项目级共享） |

行为结果：

- 绑定群里任何人可点"找人"按钮、初筛通过、加入 reloop、取简历、自助接单（接单落点击者本人
  MY_JOB 成员关系）。
- 机器人被拉进旧群后，顾问在群里 @机器人 绑定职位即刻可用：授权层放行 → handler 实时核对
  机器人在群 → 补登记 → 激活 scope → 发找人卡。轮询的基线抑制、静默失败、10 分钟窗口都不再阻塞绑定。

## 验证

- 新增 `tests/group-member-access.test.mjs`（群放行/私聊与非绑定群 fail-closed/自助接单）。
- `tests/group-intake.test.mjs` 新增自愈绑定正反对应用例；`tests/agent-authorization.test.mjs`
  更新 sender 政策断言。
- 专项 40/40、job/openmai/supermai 相关 56/56、后端全量见提交日志。

## 部署注意

- 生产更新重启后，存量旧群仍只会被轮询标 SEEN（基线不发卡），但绑定已不再依赖该登记；
  要绑定某旧群，直接在群里 @机器人 说绑定职位即可。
- 生产 root 因 `brainx-agent-gateway` 读不到 `/opt/brainx/.env` 导致 `BRAINX_BASE_URL_REQUIRED`
  的历史坑见 [提交日志 2026-09-11](AGENT_COMMIT_LOG.md)，更新时确认 `/etc/brainx/base-url.env` 仍在。

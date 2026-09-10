# 013 — 拉群即见卡：OpenClaw 群准入降级为后置补偿

状态：Implemented（2026-09-10）
上游：生产事故（2026-09-10 20:01，york / JPTLM25 韬润半导体-业务助理）。web 接单自动拉群后群建成功、卡片没发，顾问 46 秒后退单。

## 1. 事实与根因

- 链路（`src/project-launch.js#launchProject`）：createProjectChat → **ensureOpenClawProjectGroup** → sendInteractiveCard → activateGroup + 置 READY。
- 生产唯一记录：`project_launches` 单行，status=FAILED、current_step=POST_JOB、chat_id=`oc_baf49b41b90843d832315da3cb696b7b`、**message_id=null**、error_code=error_message=`OPENCLAW_GROUP_ALLOWLIST_FAILED`。
- 后续：顾问 20:02:22 退单；20:02:59 群内发言，openclaw 日志 `group oc_baf49b... not in groupAllowFrom` → 机器人不响应。
- 手工重放 `ensureOpenClawProjectGroup` 于 20:09 成功（added=1,count=4）→ 瞬时故障，非配置错误。
- 实测：openclaw CLI `config get` 1.5s、`config set` 5.1s，runner `timeoutMs=12_000`；apply 串行最多 5 次调用。真实 cause（TIMEOUT/COMMAND_FAILED）被 `safeError` 吞成统一 `ALLOWLIST_FAILED`，无法定位。

**根因**：群准入只是「让卡片按钮与群内对话可用」的增强，却被实现为发卡的硬前置；一次瞬时失败就废掉整条链路，且错误不可诊断、不可恢复。

## 2. 改动

### 2.1 顺序调整（P0）

`launchProject` 新顺序：

1. createProjectChat（无 chat_id 时）
2. **sendInteractiveCard** —— 卡片是硬指标，失败仍整条失败（但 chat_id 已落库，可重放）
3. ensureOpenClawProjectGroup —— **best-effort**，失败不再抛错
4. activateGroup + `job_facts.chat_id` + 置 READY（同一事务）

launch 置 READY 时写入：`message_id`、`openclaw_status`（OK / PENDING）、`openclaw_error`。返回值附 `openclaw` 段。

### 2.2 状态与补偿（P0）

- migration `0048_project_launch_openclaw_status.sql`：`project_launches` 增列 `openclaw_status`（默认 'PENDING'）、`openclaw_error`、`openclaw_attempts`、`openclaw_updated_at`。存量行默认 PENDING，会被补偿任务捡起。
- 新文件 `src/openclaw-group-retry.js`：`startOpenclawGroupRetryWorker(db, opts)` 每 10 分钟（`BRAINX_OPENCLAW_RETRY_INTERVAL_MS`）扫 `chat_id NOT NULL AND openclaw_status='PENDING'`（limit 5）重放准入：
  - 成功 → OK、清 error、触发 gateway 重启钩子；
  - 失败 → attempts+1，attempts ≥ 12 置 'FAILED' 并告警日志；
  - `BRAINX_OPENCLAW_RETRY_OFF=1` 关闭。
- 重启钩子：`systemctl restart openclaw-brainx`（openclaw 白名单不热生效，必须重启）。节流 `BRAINX_OPENCLAW_RESTART_MIN_INTERVAL_MS` 默认 15 分钟；开关 `BRAINX_OPENCLAW_RESTART_ON_ALLOWLIST` 默认 1。注入式 `restartGateway` 便于测试。

### 2.3 错误可观测（P1）

- `personal-model-config.js` runner：子进程非 0 退出 / 超时时把 stderr 摘要挂到错误上（`OPENCLAW_COMMAND_FAILED` / `OPENCLAW_TIMEOUT`）。
- `openclaw-group-access.js` 抛错带 cause 描述；`project-launch.js` 落库格式 `OPENCLAW_GROUP_ALLOWLIST_FAILED: OPENCLAW_TIMEOUT(...)`，不再是 code 复述。
- CLI 超时 12s → 20s（`BRAINX_OPENCLAW_TIMEOUT_MS` 可调）。

### 2.4 补发入口（P2）

`bin/brainx-agent-admin.mjs` 增 `launch-redeliver --tenant --project --consultant`：对已有 chat_id 的 launch 重跑 `launchProject`（跳过建群、补发卡片、重试准入），幂等。

### 2.5 卡片文案

卡片第二段补一句「机器人正在接入本群，如按钮暂无响应请稍候再点」，覆盖准入未完成时的窗口期。

## 3. 边界与不变量

- 发卡失败仍然整条失败（不静默降级），因为卡片是拉群的产物；chat_id 已落库保证可重放。
- 幂等不变：`idempotency_key`、`ensureSingleProjectLaunch`、READY 短路全部保留。
- activateGroup 与 job_facts 更新仍在同一事务内。
- 补偿任务只在 PENDING 上工作，不触碰 OK/FAILED；重启 gateway 有节流，避免抖动。

## 4. 验收

1. 准入抛错时：卡片已发（sendCard 被调用）、launch=READY、openclaw_status=PENDING、error_message 含真实 cause。
2. 准入成功时：openclaw_status=OK，重启钩子被调用一次。
3. 发卡失败时：status=FAILED、chat_id 保留、error_code=FEISHU_JOB_POST_FAILED。
4. 补偿 worker：PENDING→OK，失败累加 attempts，超阈值置 FAILED；节流期内不重复重启。
5. `npm run verify`（full）通过。

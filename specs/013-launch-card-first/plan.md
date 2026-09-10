# 013 — 实施计划

## 改动清单

| 文件 | 改动 |
|---|---|
| migrations/0048_project_launch_openclaw_status.sql | project_launches 增 openclaw_status / openclaw_error / openclaw_attempts / openclaw_updated_at |
| src/project-launch.js | 顺序改为「发卡 → 准入(best-effort) → 事务置 READY」；落库 openclaw 状态与真实 cause；卡片文案补一句 |
| src/openclaw-group-access.js | 抛错带 cause 描述 |
| src/personal-model-config.js | runner 错误带 stderr 摘要；超时默认 12s→20s |
| src/openclaw-group-retry.js | 新增：PENDING 准入补偿 + 节流重启 gateway |
| src/worker.js | 挂载补偿 worker（BRAINX_OPENCLAW_RETRY_OFF=1 关闭） |
| bin/brainx-agent-admin.mjs | launch-redeliver 子命令 |
| tests/project-launch-openclaw.test.mjs | 新增：四条分支 + 补偿 worker + 重启节流 |

## 部署同步（生产 47.110.93.137）

1. 代码经 SSH 直推 deploy-tmp → ff-only 合并。
2. 重启 brainx（HTTP 进程）+ brainx-worker（补偿任务）；openclaw-brainx 由补偿任务按需重启。
3. 补发 york/JPTLM25 卡片：`node bin/brainx-agent-admin.mjs launch-redeliver --tenant yorkteam --project JPTLM25 --consultant york`（需 load openclaw.env 的飞书凭证）。
4. 冒烟：群内应出现卡片；`project_launches.openclaw_status` 应为 OK。

## 风险

- 自动重启 openclaw-brainx 会让机器人短暂离线（约 10 秒）；已加 15 分钟节流，且只在准入从 PENDING 变 OK 时触发。
- 补偿 worker 与 launchProject 可能并发操作同一 openclaw.json；`createOpenClawGroupAccess` 内部已有串行队列，但跨进程仍可能竞争 → 失败仅累加 attempts，不会破坏 launch 状态。
- 以 root 执行 openclaw config set 会把 openclaw.json 属主改掉；生产 `BRAINX_OPENCLAW_RUN_AS=brainx`（来自 /opt/brainx/.env）已规避，不要手工以 root 写该配置。

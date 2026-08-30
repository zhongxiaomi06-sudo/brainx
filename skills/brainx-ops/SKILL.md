---
name: brainx-ops
description: 运维口径与排错手册:同步/推荐/推送/OpenMai/TTC 健康检查、常见故障处置、服务与端口。机器人本身只读,本技能用于回答"系统怎么了/该怎么修"并把 CLI 指引给管理员。
---

# BrainX 运维手册(机器人只读视角)

项目为零依赖 Node ≥22 栈;本地常驻 `http://127.0.0.1:3100`(launchd),云版 `http://47.110.93.137:3100`(systemd)。

## 机器人能做的诊断

| 症状 | 查证 |
|---|---|
| 推荐为空/被阻断 | `brainx_workbench` → sync.state;INCOMPLETE 时看 errors |
| 职位详情异常 | `brainx_opportunity` → 关系/承接/事件流水 |
| 找人没结果 | `brainx_openmai_result` → status;failed 有原因 |
| 人才库异常 | `brainx_talent({health:true})` → backend 是否落 memory |
| 自定义核查 | `query_sql`(sync_runs/push_log/openmai_results 等表) |

## 给管理员的 CLI 指引(机器人不执行)

| 目的 | 命令(项目根,Node ≥22) |
|---|---|
| 同步干跑(只校验) | `node bin/brainx-sync.mjs --source fixture --consultant <id> --dry-run` |
| 正式同步 | `node bin/brainx-sync.mjs --source feishu --consultant <id>` |
| 跑一轮推荐 | `node bin/brainx-recommend.mjs --consultant <id> --top 10` |
| 决策回放 | `node bin/brainx-replay.mjs --decision-id <id>` |
| 推送预览 | `node bin/brainx-push.mjs --consultant <id>`(加 --send 才真发) |
| OpenMai 晨检 | `node bin/brainx-openmai-health.mjs`(TTC JWT/配额/连通,exit 0/1) |
| 人才库自检 | `node scripts/talent-health.mjs` |
| 影子评估 | `node bin/brainx-shadow-daily.mjs`(规则 vs LambdaMART) |
| 服务重启 | `launchctl kickstart -k gui/$(id -u)/com.brainx.web`(本地) |

## 常见故障口径

- **推荐 blocked** → `sync_runs.complete=0`:看 sync.errors;多为飞书令牌过期或桥接中断,重新授权/重启服务
- **OpenMai 失败** → 先 openmai-health:TTC JWT 过期走浏览器扩展重新 ext-sync
- **前端白屏** → vinext 长驻 + 前端重建导致哈希错位;重启 web 服务(先 curl 对比页面 JS 哈希与 dist)
- **DB 慢/锁** → WAL 模式;确认无进程以写模式长开 data/brainx.db

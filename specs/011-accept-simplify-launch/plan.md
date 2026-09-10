# 011 — 实施计划

## 改动清单

| 文件 | 改动 |
|---|---|
| src/project-launch.js | `workflowDueAt` 加 export |
| src/agent-gateway/tools-actions.js | acceptJob 四参数服务端兜底；import workflowDueAt |
| src/agent-gateway/tool-registry.js | brainx_accept_job required → ['job_id','confirm'] |
| plugins/brainx-openclaw/runtime.js | required 收敛 + 描述更新 + PLUGIN_VERSION 1.3.7 |
| src/server.js | engagement ACCEPT 成功后 best-effort launchProject，响应附 project_launch |
| skills/brainx-sourcing-{openmai,supermai,reloop}/SKILL.md | 增「接单（一句话完成）」节 |
| tests/agent-action-tools.test.mjs | 新增最小参数接单 + 幂等回归 |
| tests/openclaw-plugin.test.mjs | 版本断言 1.3.6→1.3.7 |

## 部署同步（生产 47.110.93.137）

1. 代码经 SSH 直推 deploy-tmp → ff-only 合并。
2. 插件副本同步：`cp plugins/brainx-openclaw/{runtime.js,openclaw.plugin.json} /var/lib/brainx/.openclaw/extensions/brainx-openclaw/`（先备份）。
3. 重启 openclaw-brainx（插件副本变更）+ brainx-agent-gateway（工具 schema）+ brainx。
4. 冒烟：registry.has/最小参数语义用只读方式核对 schema；拉群链路用 felix 已接单职位做 preflight 查询（不真建群）。

## 风险

- engagement 路由等待飞书 API（约 1-3s）才返回——可接受；失败路径已兜底不阻塞。
- project-launch.js 进入 gateway 模块图（feishu-bot 等）——纯函数无副作用，不影响启动。

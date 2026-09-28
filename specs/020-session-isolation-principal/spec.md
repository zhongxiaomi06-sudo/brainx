# Feature Specification: Session 隔离下沉 gateway principal（300 顾问承载形态）

**Feature Branch**: `main`

**Created**: 2026-09-23

**Status**: Draft（占位，待 specs/019 US4 验收达标后启动 plan）

**Input**: specs/019-hub-event-backbone US4：三百顾问会话隔离由系统承载

## 背景

当前 session 隔离建在 OpenClaw 多 Agent 能力上，`deploy/openclaw/openclaw.production.json` 的 `maxAgents: 20` 在配置层封顶 20 人——目标规模（单分公司 300+ 顾问）装不下。gateway 鉴权层（`src/agent-gateway/authorization.js`）本就是多租户的（tenant_id / channel_account_id / 群 scope / decide() 五态），specs/019 US4 已补并发边界测试。**方向：隔离边界从「OpenClaw Agent 实例」下沉到「gateway principal 裁决」，OpenClaw 降级为哑通道。**

## 待解决问题（plan 阶段展开）

1. 会话上下文隔离：OpenClaw 侧共享/少量 Agent 池时，per-consultant 的会话记忆、技能上下文、个人模型凭据（specs/004）如何不串味；
2. 群会话与私聊会话的 principal 传递链：openclaw → 插件 → gateway 的身份断言在当前共享 Agent 形态下是否逐请求保真；
3. 容量形态：OpenClaw dynamic agent 上限、会话路由表、以及 300 顾问并发时的调度与限流口径；
4. 迁移路径：现有 ≤20 顾问的形态如何无感迁移（身份绑定表不动，壳子配置先行）。

## 验收标准（承接 specs/019 US4）

- 300 名顾问并发会话下，跨顾问数据越权访问为零（以 gateway 审计日志 + 越权测试为准）；
- 新增顾问无隔离配置动作（绑定即生效，不开新 Agent 实例）；
- OpenClaw 层不承载任何业务正确性判断（全部下沉 gateway/插件确定性代码）。

## 关联

- [specs/019 Hub 事件骨干重整](../019-hub-event-backbone/spec.md)（US4 母规格）
- [specs/004 顾问个人模型配置](../004-personal-model-config/spec.md)
- [OpenClaw 多顾问生产运行手册](../../docs/2026-09-03-openclaw-production-runbook.md)

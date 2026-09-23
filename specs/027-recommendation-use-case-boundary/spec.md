# 027 — 推荐用例、仓储与入口边界收口

状态：Implemented，待最新提交完整门禁（2026-09-23）

上游：[仓库重构施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)阶段 03、
[Algorithm A 决策契约](../../docs/2026-09-22-algorithm-a-contract.md)、
[Server 路由边界规格](../026-server-route-boundaries/spec.md)。

## 1. 目标与现状

当前 API、CLI 与 worker 直接调用 `recommend.js`，scheduler、推送和工作台又各自读取最新轮次；推荐配置散落为模块级环境变量。入口因此知道领域实现，后续接入 Algorithm A 时容易出现多套状态机、不同节流口径和循环依赖。

本单元建立唯一推荐用例、显式数据库 repository adapter 和集中配置解析，让 API、CLI、scheduler、worker 通过同一接口运行或读取推荐。保留 `recommend.js` 兼容导出，供现有内部调用和测试渐进迁移。

## 2. 行为要求

### S1｜唯一用例

`createRecommendationUseCase()` 必须统一提供生成推荐、读取指定/最新轮次、列出顾问和构建推荐上下文的能力。API、推荐 CLI、worker 自动推荐和 scheduler 推送必须复用该用例，不得直接导入 `recommend.js`。

### S2｜仓储边界

用例不得直接执行 SQL，也不得读取数据库表名；所有持久化查询、事务、节流审计和冻结写入由显式 repository port 提供。SQLite adapter 可复用现有领域查询函数，但不能反向依赖用例。

### S3｜配置边界

推荐节流、跳过审计间隔和单轮冻结上限集中解析并校验。缺省值保持 2 小时、1 小时和 200；非有限整数、负值或冻结上限小于 1 时稳定失败关闭，不携带秘密或环境内容。

### S4｜入口组装

推荐 HTTP 路由由独立 route factory 承接，并允许注入同一个用例实例；`server.js` 的工作台、事实修正重算和推送路径也复用该实例。worker 创建一次用例，同时交给 bridge 与 scheduler。

### S5｜兼容契约

不得改变推荐资格、分数、排序、理由、风险、快照、冻结数量、节流、状态码、路由、CLI 输出、推送幂等或隐藏已承接项目的行为。`recommend.js` 的既有导出继续可用，且不保留 SQL 或另一套实现。

## 3. 非目标与安全边界

- 不实现或启用 Algorithm A，不改变 `baseline-1.1`。
- 不新增依赖、表、迁移或业务配置名。
- 不连接生产、回填、清理、发布或 push。
- 不借结构改造改变鉴权、权限、数据可见性或用户确认边界。

## 4. 验收

1. 错误依赖结构能被回归测试阻断：入口直连旧实现、用例含 SQL、repository 反向依赖用例、主服务内嵌推荐 handler 均失败。
2. API、CLI、scheduler、worker 使用同一用例接口，兼容 facade 与用例生成结果等价。
3. 非法推荐配置稳定失败；合法缺省保持现有值。
4. 现有推荐、分页、事实修正、scheduler、worker、HTTP 和 MCP 回归通过。
5. 快速门禁及最新提交完整门禁通过，报告 Push 条件满足。

## 相关文档

- [实现计划](plan.md)
- [任务清单](tasks.md)
- [施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)
- [上传前完整验证](../../docs/standards/PRE_PUSH_VERIFICATION.md)

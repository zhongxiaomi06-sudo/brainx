# 027 Plan — 推荐用例、仓储与入口边界收口

## 实现方案

1. 先增加结构、配置与兼容回归，证明旧入口直连和缺失边界会失败。
2. 新增推荐配置模块，集中解析三个既有环境变量并注入用例。
3. 新增 SQLite recommendation repository，集中读取快照、画像上下文、候选、轮次与冻结事务。
4. 将现有推荐编排迁入无 SQL 的 use case；`recommend.js` 收缩为兼容 facade。
5. 新增推荐 route factory；server、CLI、worker、scheduler 共享用例实例和依赖注入。
6. 运行专项回归、快速门禁、原子提交与完整门禁，再更新施工手册状态。

## 兼容与回滚

- 旧导出、HTTP 路由、CLI 参数和返回形状保持不变。
- repository 继续使用同一 SQLite 事务和已有领域函数，无 schema 或数据迁移。
- 若任何排序、冻结或推送回归变化，停止并修复，不以更新快照接受差异。
- 回滚只恢复旧入口调用和 facade 实现，不涉及数据回滚。

## 验证

- `node --test tests/recommendation-use-case-boundary.test.mjs tests/core.test.mjs tests/policy-1.1.test.mjs tests/scheduler.test.mjs tests/server-routing.test.mjs tests/facts.test.mjs tests/worker.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`

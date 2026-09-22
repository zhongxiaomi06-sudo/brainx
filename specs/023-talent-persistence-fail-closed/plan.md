# 023 Plan — 人才库持久层显式选择与失败关闭

## 实现方案

1. 新建小型后端策略模块，解析显式模式并提供稳定、安全的配置错误。
2. `src/talent.js` 保留现有业务 API 与内存/MySQL 实现，仅把后端选择改为策略模块驱动。
3. MySQL 连接后查询基础表与迁移历史验证就绪；运行链路删除自动建表调用。
4. 健康探针捕获稳定错误并返回诚实状态；业务读写继续抛错，由现有 HTTP 边界转为 502。
5. 更新本地、Agent 和 worker 环境示例；迁移 CLI 仍是唯一 DDL 入口。

## 兼容与回滚

- 已就绪 MySQL 的 SQL、返回形状与幂等键不改。
- 本地演示改为双重显式开关；测试继续使用 `useMemoryBackend()`，不访问网络。
- 回滚代码不会改动 schema；若需临时恢复旧版本，不能把内存回退声称为持久化恢复。
- 本轮没有生产数据变更，不存在数据回滚动作。

## 验证

- `node --test tests/talent-backend-policy.test.mjs tests/talent.test.mjs tests/resume.test.mjs`
- `node --test tests/talent-migrations.test.mjs tests/candidate-shortlist.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`

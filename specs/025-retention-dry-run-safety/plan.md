# 025 Plan — 清理路径隔离与显式策略 dry-run

## 实现方案

1. 删除推荐事务对旧裁剪函数的调用，保留每轮最多持久化 200 条的生成侧上限。
2. 将旧 retention CLI 变为安全兼容入口：`--apply` 立即拒绝，其余参数转到只读盘点。
3. 新建纯 SELECT dry-run 规划器，使用 CTE 统计 TTL、最近轮次和五类引用保护，不建临时表。
4. 新 CLI 以 SQLite 只读模式打开数据库，从 JSON 文件读取策略；策略只影响计数，不开放执行。
5. 对字段报告、同步运行和原始上下文显式报告尚未实现，避免虚构安全删除规则。

## 兼容与回滚

- 推荐生成、排序、返回和单轮持久化数量不变，只停止旧历史的隐式删除。
- 旧 CLI 的 dry-run 名称继续可用但输出升级为只读盘点；旧 `--apply` 有意不兼容并返回稳定错误。
- 本单元没有数据写入；回滚代码不需要数据回滚，但不得恢复未经证明安全的自动删除。

## 验证

- `node --test tests/retention-dry-run.test.mjs tests/policy-1.1.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`

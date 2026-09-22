# 020 Plan — 排序特征冻结快照

## 实现方案

1. 新增迁移 `0051_recommendation_feature_snapshots.sql`，只增加可空列，不回填历史。
2. 在 `src/ltr-features.js` 增加快照创建和严格解析函数，复用现有特征定义。
3. `recommend()` 在同一事务写入推荐与特征快照；正式返回契约不增加内部字段。
4. LTR 导出、离线影子评估和分歧日报只读取冻结快照。
5. 缺失或非法快照按稳定原因码排除，并在输出中报告数量。

## 兼容与回滚

- 新列可空，旧应用和旧记录继续可读；新代码对旧记录 fail-closed，不伪造历史。
- 回滚代码时新列无人读取，不影响正式推荐；不删除列或历史数据。
- 本轮不运行生产迁移、回填或切读。

## 验证

- `node --test tests/ranking-feature-snapshot.test.mjs tests/ranking-evaluation.test.mjs tests/spec-backend-1.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`

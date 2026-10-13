# 019 Plan — 排序评估正确性

## 实现方案

1. 在 `src/ranking-metrics.js` 建立无依赖的 `dcg` 与 `ndcgAtK`，由规则和影子评估共用。
2. 指标函数先按预测位置截 Top K，再忽略未知收益；IDCG 从全组已知标签取 Top K。
3. 把 Python `ndcg` 提到模块级，用预测索引读取标签并保持稳定平局顺序。
4. 把评估 SQL 的 LIMIT 从模块默认值改为局部 `runs`。
5. 用 Node 测试覆盖 JavaScript、Python 手算例和局部参数。

## 风险与控制

- 修复后历史报告数值会变化：保留字段名，并在文档说明旧报告不可作为晋升证据。
- 部分标注 NDCG 只能诊断：本单元不扩大结论，只保证位置和 IDCG 计算正确。
- Python 测试通过系统 `python3` 导入纯函数，不加载 LightGBM 或 NumPy。
- 新文件保持 500 行以内，不新增依赖或迁移。

## 验证

- `node --test tests/ranking-evaluation.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`

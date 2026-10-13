# 024 Plan — 数据增长、引用与保留责任只读盘点

## 实现方案

1. 建立表/列能力探测与安全聚合函数，只运行仓库内固定 SELECT，不接受任意 SQL。
2. 为五类数据建立统一摘要：字段报告、同步运行、限流跳过运行、推荐/特征快照、原始上下文。
3. 把跨表引用统计与责任/TTL/恢复阻断合并为版本化 JSON；没有审批时一律不输出删除候选。
4. CLI 使用 `DatabaseSync(path, { readOnly: true })`，不复用带迁移和播种副作用的数据库入口。
5. 新建权威盘点文档，登记现有自动裁剪和 retention apply 的差距，供下一原子单元设计 dry-run。

## 兼容与回滚

- 只新增读取入口、测试和文档，不修改 schema、业务读写或现有脚本执行结果。
- 删除新增入口即可回滚；数据库无数据回滚动作。
- 表/列缺失按能力标记，不为旧库自动升级。

## 验证

- `node --test tests/data-retention-inventory.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`

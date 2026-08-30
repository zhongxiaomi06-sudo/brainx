# TTC 职位字段库

> 上级目录：[BrainX 文档书](README.md)

## 目标

TTC 是 BrainX 的职位权威源。字段库只解决一件事：让正式页面与推荐算法只能使用已经确认语义的 TTC 字段，避免前端把推断标签、空字段或演示指标伪装成真实筛选条件。

权威实现位于 `src/ttc-field-catalog.js`。字段库是轻量代码契约，不建设独立数据平台。

## 默认职位表字段

| BrainX 字段 | TTC 来源 | 主表 | 筛选语义 |
|---|---|---:|---|
| role | name | 是 | 搜索 |
| company | company_name / company_name_for_c | 是 | 多选 |
| city | cities[] | 是 | 多选；多城市拆项 |
| active_state | status | 是 | 活跃 / 冷却 / 待确认 |
| hc | head_count | 是 | 数值范围 |
| pipeline | pipeline_info.pipeline_step_count | 是 | 阶段人数 |
| owner_name | managers[0].name | 是 | 多选 |
| captured_at | update_time | 是 | 日期范围 |
| notes | analytics / description | 否 | 详情搜索 |
| project_id | unique_id | 否 | 权威主键 |

行业、公司阶段、综合分、招聘意愿和前端猜测的职位类型不属于 TTC 已验证核心字段，不进入默认主表。

## 运行规则

1. 必需字段缺失记为阻断错误；可选字段形状异常记为警告并降级对应能力。
2. 标准化职位保留字段库版本、结构化 Pipeline 和检查结果，文本摘要只用于展示。
3. `filterAvailable` 继续表示覆盖率达到 90% 的“完整筛选”能力。现代职位工作区对已经完整取得的 Radar 列表执行本地筛选时，只要字段 `displayAvailable` 就可以筛选已知值，但必须保留“待确认”入口并明确缺失值，不能把部分覆盖描述成完整数据。城市下拉只能派生城市级标准项并去掉“市”后缀；国家、省份、区县、详细地址和远程描述不进入筛选项，原始字段仍按源值展示。
4. 正式页面只能从字段库的默认列与能力状态生成表头；Storybook 使用同形脱敏数据。
5. TTC 字段变化时先更新契约与回归测试，再调整正式页面，不允许前端独立猜测。

## API 与覆盖率报告

`GET /api/v1/radar` 返回三层内容：

- `items`：每条职位同时包含 `cities[]`、`pipeline_steps`、`owner_name`，并保留旧的 `city`、`pipeline` 摘要以兼容现有调用方；
- `field_capabilities`：针对当前顾问可见职位计算八个主字段的覆盖率，以及能否展示、能否筛选；
- `field_report`：该顾问最近一次 TTC 同步时留下的完整字段质量快照。

每个新的 TTC `sync_runs` 批次都会在同一事务内写入一条 `ttc_field_reports`。报告记录同步批次、字段库版本、读入行数、完整性、错误、警告以及每个字段的覆盖率。同步失败时不会留下“看似成功”的独立报告；事务回滚时两者一起回滚。

报告可以通过以下接口核对：

- `GET /api/v1/ttc/field-report`：本人最近一次 TTC 字段报告；
- `GET /api/v1/sync-runs/:id`：指定本人同步批次，并内嵌对应 `field_report`；
- `GET /api/v1/radar`：正式职位表消费的当前能力与最近报告。

迁移前的历史同步不会补造当时覆盖率；部署后下一次 TTC 同步开始持续生成报告。

## 验证

运行：

    node --test tests/ttc-field-catalog.test.mjs tests/radar.test.mjs

完整交付仍遵守[上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)与[内部 Storybook 组件库](storybook-component-library.md)。

## 相关文档

- [BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md)
- [前端交互架构](frontend-interaction-architecture.md)
- [内部 Storybook 组件库](storybook-component-library.md)

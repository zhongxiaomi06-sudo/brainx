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
3. 字段有值不等于可以筛选。默认覆盖率达到 90% 才开放表头筛选；不足时可以诚实展示已知值，但筛选保持关闭。
4. 正式页面只能从字段库的默认列与能力状态生成表头；Storybook 使用同形脱敏数据。
5. TTC 字段变化时先更新契约与回归测试，再调整正式页面，不允许前端独立猜测。

## 验证

运行：

    node --test tests/ttc-field-catalog.test.mjs

完整交付仍遵守[上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)与[内部 Storybook 组件库](storybook-component-library.md)。

## 相关文档

- [BrainX v2.0 产品需求文档](prd-2026-08-24-brainx-v2.md)
- [前端交互架构](frontend-interaction-architecture.md)
- [内部 Storybook 组件库](storybook-component-library.md)

# 021 Plan — 排序标签观察窗口与样本成熟度

## 实现方案

1. 新增 `0052_ranking_label_times.sql`，只加可空双时间列和查询索引，不回填历史。
2. 新增独立时间切分标签模块；旧 `labelFor()` 保持兼容，评估链路切到新模块。
3. `engage()`、结果写入和导入路径写入收到时间；允许可信业务发生时间显式传入。
4. 推荐项关联必须校验顾问、职位和 `decision_id` 一致；无关联事实不计推荐贡献。
5. LTR 导出、离线评估和影子日报记录标签版本、窗口、截点与排除统计。

## 兼容与回滚

- 新列可空，旧库记录继续可读；新评估对历史缺时间或缺关联数据失败关闭。
- `observed_at` 继续记录系统观察/写入时间，现有提醒、API 与页面无需切读。
- 回滚代码时新增列无人读取；不删除列、旧记录或业务结果。
- 本轮不运行生产迁移、回填或模型训练。

## 验证

- `node --test tests/ranking-label-window.test.mjs tests/ranking-evaluation.test.mjs tests/ranking-feature-snapshot.test.mjs tests/spec-backend-1.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`

# 012 — 实施计划与任务

## plan

- `src/openmai-task.js`：
  - `fetchCrmJob`：查无时抛 `e.code='JOB_NOT_FOUND'`（与 401/403/HTTP 错区分）。
  - `startOpenmaiTask` 异步体：真身解析改为 try CRM → NOT_FOUND 时 ①同名真身绑定（回写 source_url）②自建岗判据降级（伪 job + buildPrompt + 自建岗说明，`callOpenmaiContent` 不带 jobId）③无行保持原报错。
  - 污染检测/重试/settle/bus 对两种模式统一生效。
- `tests/openmai-task.test.mjs`：新增 4 组用例（mock global.fetch，模式照抄「显式启动」用例）。

## tasks

- [x] specs/012 三件套
- [x] fetchCrmJob 错误标记 + 三级递进实现
- [x] 测试 4 组（映射不变/自动绑定+回写/判据降级/无行报错 + 401 不降级）
- [x] 专项 + verify:quick + full 门禁
- [x] AGENT_COMMIT_LOG + commit + push
- [x] 生产部署 + 冒烟（felix 长角鹿岗观察）

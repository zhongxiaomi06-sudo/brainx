# 007 — Plan

## 改动文件

1. `src/openmai-task.js`：从 `callOpenmai` 提取 `callOpenmaiContent(jwt, content, { jobId })`
   并导出（SSE + 异步轮询 + 持久化读取逻辑完全复用）；job 主流程行为不变。
2. `src/supermai-sourcing.js`：整文件重写为「SuperMai 按判据找人入口」——
   `supermaiCriteriaKey(criteria)`、`buildScoutPrompt(criteria)`、
   `startSupermaiScoutTask(db, bus, consultant_id, criteria, { force })`。
   删除旧 web API 代码与凭证兑换代码。
3. `src/agent-gateway/tools-jobs.js`：`supermaiScout` 改为触发/读取两段式，
   done 时解析 BRAINX_CANDIDATES_V1 机器块返回结构化 candidates。
4. `src/agent-gateway/tool-registry.js`：supermai_scout 参数改为 `{ criteria }`。
5. `plugins/brainx-openclaw/runtime.js`：同参数 + 新描述；PLUGIN_VERSION 1.2.1 → 1.3.0。
6. `tests/supermai-sourcing.test.mjs`：按新契约重写。

## 不改

- `plugins/brainx-openclaw/openclaw.plugin.json` tools 白名单（工具名不变）。
- `deploy/openclaw/openclaw.production.json`（工具名不变）。
- `tests/fixtures/openclaw-production/plugin-contract.json`（只含工具名清单）。
- 数据库迁移（复用 openmai_results）。

## 验证

- `node --test tests/supermai-sourcing.test.mjs`（新契约用例）。
- 受影响回归：`node --test tests/agent-job-tools.test.mjs tests/agent-tools.test.mjs`
  （如存在）+ `npm run verify:quick`。
- 冒烟（部署后）：gateway registry.execute('brainx_supermai_scout', {criteria}) 返回
  running → 完成后 done + candidates。

## 风险

- OpenMai criteria 模式单次运行可达数分钟 → 采用与 job 模式一致的两段式，
  不做长阻塞同步调用。
- 合成 project_id 不匹配 project_launches → 无投递副作用（已核对 JOIN 条件）。

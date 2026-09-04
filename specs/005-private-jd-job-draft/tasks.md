# Tasks: 私聊 JD 直接提交建岗草稿

**Feature Branch**: `[005-private-jd-job-draft]`

## 1. 数据层

- [ ] T001 新建 `migrations/0038_job_facts_drafts_p2p.sql`：origin/submitted_by 列 + submitted_by 索引 + p2p message_id 部分唯一索引

## 2. 提炼层

- [ ] T002 `src/job-extract/classify.js`：提取 `mapLlmFields` 为导出函数，`extractLlm` 复用（行为不变）
- [ ] T003 新建 `src/job-extract/jd-extract.js`：JD 专用 prompt + chatJson(8s) + mapLlmFields，返回 {fields, extra}
- [ ] T004 新建 `src/job-extract/p2p-submit.js`：submitPrivateJd（原文入库→账本→幂等短路→LLM/规则→校验→落草稿 origin='p2p_jd'）

## 3. 工具层

- [ ] T005 新建 `src/agent-gateway/tools-jd-submit.js`：brainx_submit_job_jd handler（confirm 守门 + envelope 组装）
- [ ] T006 `src/agent-gateway/tool-registry.js`：AGENT_TOOL_ROWS 增行（p2pOnly/jd_text 50–8000/confirm 必填）+ registry 接线
- [ ] T007 `src/agent-gateway/tools-job-facts.js`：VISIBLE_DRAFT 扩展「登记群 OR 本人 p2p 草稿」，同步两处调用点参数
- [ ] T008 `plugins/brainx-openclaw/runtime.js`：BRAINX_OPENCLAW_TOOLS 增行 + PLUGIN_VERSION 1.2.0
- [ ] T009 `tests/fixtures/openclaw-production/plugin-contract.json` 与 `tests/openclaw-plugin.test.mjs`：allowed_tools 增行、计数 22→23、版本断言同步

## 4. 测试与验证

- [ ] T010 新建 `tests/job-extract-p2p-submit.test.mjs`：规则层提交/幂等/可见性隔离/确认转正/JD_TOO_SHORT
- [ ] T011 回归：agent-job-facts-tools / openclaw-plugin / agent-tools / agent-gateway-http 全绿
- [ ] T012 `npm run verify:quick` 通过；full verify 与 push 与在途工作协调后执行

## 5. 文档与交接

- [ ] T013 `docs/README.md` 登记本规格；`docs/AGENT_COMMIT_LOG.md` 追加中文记录
- [ ] T014 接入阶段（生产部署 + 插件重装 + AI_JOB_EXTRACT_ENABLED 开关）按 plan.md 接入清单执行

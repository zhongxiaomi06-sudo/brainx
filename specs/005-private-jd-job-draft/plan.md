# Plan: 私聊 JD 直接提交建岗草稿

**Feature Branch**: `[005-private-jd-job-draft]`

## 现状核实（2026-09-04 代码事实）

- 群链路已通：`bridge-producer.js` → 事件账本 → `src/job-extract/index.js`（规则层）→ `job_facts_drafts` → 私聊 `brainx_pending_job_facts` / `brainx_review_job_fact`（`src/agent-gateway/tools-job-facts.js`）→ `confirmDraft` 建权威岗位 + MY_JOB 关系。
- 私聊 JD 的三个断点：① 私聊消息无入账路径；② `VISIBLE_DRAFT` 只 join `chat_contexts`+`consultant_chats`；③ 规则层对整段 JD 抽不出字段（需要 LLM 层）。
- 可复用件：`appendEvent`（幂等账本）、`mapLlmFields`（LLM 输出→草稿字段映射，本次从 `classify.extractLlm` 中提为导出函数）、`extractRules`、`validateDraft`、`confirmDraft/rejectDraft`、openclaw 工具工厂（HMAC principal assertion → gateway :3102）。

## 方案

### 数据层

- 新迁移 `migrations/0038_job_facts_drafts_p2p.sql`：
  - `ALTER TABLE job_facts_drafts ADD COLUMN origin TEXT NOT NULL DEFAULT 'group'`
  - `ALTER TABLE job_facts_drafts ADD COLUMN submitted_by TEXT`
  - 索引：`idx_jfd_submitted_by`；部分唯一索引 `idx_jfd_p2p_message ON job_facts_drafts(message_id) WHERE origin='p2p_jd'`（数据库层兜底防重）。

### 提炼层（src/job-extract/）

- `classify.js`：把 `extractLlm` 内部的字段映射块提为导出函数 `mapLlmFields(out, src)`（行为不变，群链路零影响）。
- 新 `jd-extract.js`：JD 专用 prompt（整段 JD、宁缺勿错、salary/requirements 仅存档）→ `chatJson`（timeout 8s）→ `mapLlmFields` 统一映射；输出 `{fields, extra}`。
- 新 `p2p-submit.js`：`submitPrivateJd(db, {consultant_id, chat_id, text})`
  1. 规整文本，<50 字抛 `JD_TOO_SHORT`；
  2. `message_id = p2pjd_ + sha256(consultant_id+\n+text)[:24]`；
  3. `lark_messages` INSERT OR IGNORE → `appendEvent`（idem_key=`lark.message_received:{message_id}`，正文不进 payload）；
  4. 按 `(message_id, submitted_by)` 查既有草稿命中即幂等短路返回；
  5. 抽取：LLM 优先（AI_JOB_EXTRACT_ENABLED=1 且 isLlmConfigured），失败/schema 违规回退 `extractRules`；
  6. `validateDraft` 校验；一个有效字段都没有 → 返回 `action:'no_fields'` 不产草稿；
  7. 落草稿（origin='p2p_jd'，submitted_by，source=layer，raw_json 含 jd_extra）。

### 工具层

- `src/agent-gateway/tools-jd-submit.js`：`brainx_submit_job_jd` handler（confirm!==true 拒绝；调 `submitPrivateJd`；回 envelope：draft_ref/fields/layer/unknowns/next_allowed_actions）。
- `tool-registry.js`：AGENT_TOOL_ROWS 增行（p2pOnly，jd_text 50–8000，confirm 必填）+ `createProductionToolRegistry` 接线。
- `tools-job-facts.js`：`VISIBLE_DRAFT` 改为带括号的 WHERE 子句——EXISTS(登记群成员) OR (origin='p2p_jd' AND submitted_by=本人)；两个使用点的占位符同步加参。
- `plugins/brainx-openclaw/runtime.js`：BRAINX_OPENCLAW_TOOLS 增行（purpose='job_fact_review'，参数与注册表一致）；PLUGIN_VERSION → 1.2.0。
- `tests/fixtures/openclaw-production/plugin-contract.json`：allowed_tools 增 `brainx_submit_job_jd`（22→23，同步改 openclaw-plugin.test.mjs 计数断言）。

## 关键权衡

- **sha256 幂等键含 consultant_id**：同一 JD 两人提交各自成草稿（staging 是个人事实）；跨人不会互相短路误判。
- **不改动 0031 字段集**：salary/requirements 无权威列，走 raw_json 存档，避免波及 confirmDraft/job_facts schema。
- **LLM 超时 8s**：插件 fetch 硬超时 10s，8s+落库 < 10s；超时即降级规则层，不阻塞用户。
- **VISIBLE_DRAFT 重写而非拼接**：原 JOIN 改为相关 EXISTS 子查询，保持「无权不泄露存在性」语义（EXISTS 不命中即 0 行）。

## 验证

- 新增 `tests/job-extract-p2p-submit.test.mjs`：规则层提交/幂等短路/可见性隔离/确认转正/JD_TOO_SHORT/confirm 校验。
- 回归：`tests/agent-job-facts-tools.test.mjs`（群草稿可见性不受影响）、`tests/openclaw-plugin.test.mjs`、`tests/agent-tools.test.mjs`、`tests/agent-gateway-http.test.mjs`。
- `npm run verify:quick`；push 前按门禁跑 full（requireCleanWorktree——需与其他在途改动协调）。

## 接入（部署）清单

1. 生产 `git pull`（ECS 走 HTTP/1.1 重试）→ 重启 brainx 服务（迁移 0038 自动应用）。
2. 重建/更新 openclaw 插件（brainx-openclaw 1.2.0）→ `systemctl restart openclaw-brainx.service`。
3. 生产 openclaw 侧按需开启 `AI_JOB_EXTRACT_ENABLED=1`（worker env）；不开启则纯规则层。
4. 验收：mia 私聊发真实 JD → 卡片回草稿要点 → 一键确认 → `brainx_job_assessment` 可读。

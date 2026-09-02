# Tasks: OpenClaw 多顾问生产化

**Input**: [spec.md](spec.md) · [plan.md](plan.md) · [research.md](research.md) · [data-model.md](data-model.md) · [contracts/agent-gateway.md](contracts/agent-gateway.md)

**Tests**: 必须包含。用户要求每个任务结束后验收；constitution 第 IV 条要求实现前先写能失败的 `node:test` 回放。

## Phase 1: Setup

- [x] T001 固定 OpenClaw 2026.7.1-2 插件契约夹具与禁止工具基线到 tests/fixtures/openclaw-production/
- [x] T002 校验插件发布包、Python parser 产物和本地密钥排除规则并按需更新 .gitignore 与 .npmignore

---

## Phase 2: Foundational

- [x] T003 [P] 先写 App 身份、群范围、Agent 审计、nonce、限流和任务表迁移测试到 tests/agent-migrations.test.mjs
- [x] T004 实现 additive SQLite 迁移到 migrations/0032_agent_gateway.sql 与 migrations/0033_integration_jobs.sql
- [x] T005 [P] 先写 canonical body hash、HMAC、时效、篡改和重放输入测试到 tests/agent-assertion.test.mjs
- [x] T006 实现短时主体声明签发与验证到 src/agent-gateway/assertion.js
- [x] T007 [P] 先写 App 维度身份、白名单群、sender、purpose 和项目范围负向测试到 tests/agent-authorization.test.mjs
- [x] T008 实现 fail-closed 身份与群授权到 src/agent-gateway/authorization.js
- [x] T009 [P] 先写统一成功/错误 envelope、脱敏审计和限流测试到 tests/agent-runtime-guards.test.mjs
- [x] T010 实现统一 envelope、审计与固定窗口限流到 src/agent-gateway/envelopes.js、src/agent-gateway/audit.js、src/agent-gateway/rate-limit.js

**Checkpoint**: assertion、身份、群范围、审计和限流可脱离 OpenClaw 独立验收。

---

## Phase 3: User Story 1 - 顾问在任意设备安全对话 (P1)

**Goal**: 飞书 runtime 身份经原生插件签名后，只能读取该顾问/群有权范围。

**Independent Test**: 两名顾问、两个群、同一对象编号回放；合法私聊成功，伪造身份、跨用户、未知群和重复 nonce 全部拒绝。

- [x] T011 [P] [US1] 先写 HTTP 方法、body cap、服务 token、assertion、未知工具和健康检查契约测试到 tests/agent-gateway-http.test.mjs
- [x] T012 [US1] 实现唯一生产工具注册表与回环 HTTP Gateway 到 src/agent-gateway/tool-registry.js、src/agent-gateway/server.js、bin/brainx-agent-gateway.mjs
- [x] T013 [P] [US1] 先写绑定/撤销顾问和登记/撤销群 scope 的管理员命令测试到 tests/agent-admin.test.mjs
- [x] T014 [US1] 实现显式管理员身份与群范围命令到 src/agent-gateway/admin.js、bin/brainx-agent-admin.mjs
- [x] T015 [US1] 添加跨顾问、跨群、跨项目、身份参数注入和群/私聊字段隔离回放到 tests/agent-isolation.test.mjs

**Checkpoint**: BrainX Gateway 本身满足身份不可伪造和 0 越权；尚不依赖真实飞书。

---

## Phase 4: User Story 2 - 顾问完成猎头黄金工作流 (P1)

**Goal**: 10 个只读/计算工具提供今日简报、职位、人才、证据、草稿准备和个人复盘数据。

**Independent Test**: 用一份授权脱敏职位—候选人夹具完成五步连续工作流，所有结论有证据或未知标记且无业务写入。

- [ ] T016 [P] [US2] 先写 me context、daily brief、job assessment、job gap 和 personal review 的契约/可见性测试到 tests/agent-job-tools.test.mjs
- [ ] T017 [US2] 复用现有领域函数实现职位域工具到 src/agent-gateway/tools-jobs.js
- [ ] T018 [P] [US2] 先写 shortlist、candidate facts、fit、candidate gap 和 interview prep 的授权/脱敏/版本测试到 tests/agent-talent-tools.test.mjs
- [ ] T019 [US2] 复用 candidate_fact_v1 与版本化 match run 实现人才域工具到 src/agent-gateway/tools-talent.js
- [ ] T020 [US2] 将 10 个工具接入注册表并添加黄金工作流只读回放到 tests/agent-golden-workflow.test.mjs
- [ ] T021 [US2] 将七个生产 Skill 对齐新工具名、事实/推断/建议/未知格式与一次一问规则到 skills/brainx-today/、skills/brainx-job/、skills/brainx-talent/、skills/brainx-match/、skills/brainx-engagement-draft/、skills/brainx-interview-prep/、skills/brainx-review/

**Checkpoint**: 不经 OpenClaw 模型也能证明每个工具的权限、schema、证据和失败语义。

---

## Phase 5: User Story 4 - 管理员可部署、审计和恢复 (P1)

**Goal**: 原生插件、三个服务和 HTTPS 深链可从干净服务器安装，顾问端零安装。

**Independent Test**: 打包安装插件、枚举运行时工具、安全审计、服务重启和手机/异机深链均通过。

- [ ] T022 [P] [US4] 先写插件 manifest/运行时上下文缺失拒绝/固定 URL/签名请求/工具集合测试到 tests/openclaw-plugin.test.mjs
- [ ] T023 [US4] 实现并打包 BrainX 原生 OpenClaw 插件到 plugins/brainx-openclaw/
- [ ] T024 [P] [US4] 先写生产 OpenClaw 配置的插件 allowlist、工具 deny、沙箱和会话隔离策略测试到 tests/openclaw-production-config.test.mjs
- [ ] T025 [US4] 新增无密钥生产配置模板、安装脚本和 systemd 单元到 deploy/openclaw/、deploy/systemd/
- [ ] T026 [P] [US4] 先写候选卡和工作流卡只允许 HTTPS 基址、对象深链和页面再鉴权的测试到 tests/agent-deep-links.test.mjs
- [ ] T027 [US4] 将卡片深链改为受控 HTTPS 对象 URL 并删除生产 localhost 回退到 src/candidate-shortlist-card.js 与相关渲染层
- [ ] T028 [US4] 更新部署、安全、权限、运维、回滚和文档总目录到 docs/DEPLOYMENT.md、docs/SECURITY.md、docs/README.md、docs/2026-09-03-openclaw-production-runbook.md

**Checkpoint**: 发布包和配置可以在服务器复现，客户端只需要飞书或浏览器。

---

## Phase 6: User Story 3 - 授权人才被持续盘活 (P2)

**Goal**: 结构化人才增量同步、撤权、解析任务和匹配评测可恢复且不静默改变正式排序。

**Independent Test**: 结构化增量、重复批次、撤权、数字文档、扫描件、恶意提示、重启租约和 shadow 评测 fixtures 全部回放。

- [ ] T029 [P] [US3] 先写 source cursor 只在完整成功后前移及 383 档案增量分页测试到 tests/talent-pipeline.test.mjs
- [ ] T030 [US3] 实现 reloop 结构化档案增量同步与幂等事实写入到 src/talent-pipeline/sync-cursor.js、src/talent-pipeline/facts.js、scripts/sync-reloop-incremental.mjs
- [ ] T031 [P] [US3] 先写撤权后查询、待发通知、缓存和索引均失效的测试到 tests/talent-revocation.test.mjs
- [ ] T032 [US3] 实现人才授权与撤权传播到 src/talent-pipeline/grants.js
- [ ] T033 [P] [US3] 先写任务幂等、费用上限、租约过期、重启恢复、取消和 outbox 去重测试到 tests/integration-jobs.test.mjs
- [ ] T034 [US3] 实现持久任务仓库、worker 和 outbox 到 src/integration-jobs/repository.js、src/integration-jobs/worker.js、src/integration-jobs/outbox.js、bin/brainx-integration-worker.mjs
- [ ] T035 [P] [US3] 先写数字 PDF/DOCX、空文本 OCR_REQUIRED、schema 失败和提示注入文档测试到 tests/document-parser.test.mjs
- [ ] T036 [US3] 实现隔离 MarkItDown 解析适配与文档状态到 parser/、src/talent-pipeline/document.js
- [ ] T037 [P] [US3] 先写正式顺序冻结、shadow run 和 Recall@20/NDCG@10 报告测试到 tests/match-evaluation.test.mjs
- [ ] T038 [US3] 实现固定评测集运行与可复跑报告到 src/talent-pipeline/evaluation.js、scripts/eval-candidate-matching.mjs

**Checkpoint**: 人才规模化不依赖全量重拷贝，撤权可验证；新算法仍不能未经签署切正式排序。

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T039 执行 npm run verify:quick、完整专项测试、插件 npm pack 安装、openclaw plugins inspect/doctor/security audit 并修复全部失败
- [ ] T040 在最新 commit 的干净工作区运行 npm run verify，确认 .quality-gate/reports/latest.md 为通过且 Push 条件满足
- [ ] T041 按 docs/2026-09-03-openclaw-production-runbook.md 部署 ECS、迁移真实库、绑定最多三名灰度顾问并完成私聊/群聊/HTTPS 深链真实验收
- [ ] T042 复核 git diff、提交记录和生产证据后推送 codex/feishu-agent-prd-20260901 并创建 GitHub PR
- [ ] T043 运行 speckit-converge 对照 spec/plan/tasks 回扫缺口；如追加任务则继续 implement，直到报告 Converged

## Dependencies

- T003-T010 是所有用户故事的安全前置。
- US1（T011-T015）阻塞 US2、原生插件和真实灰度。
- US2 的人才读取依赖现有 candidate 数据契约；US3 可在 US1 后独立施工，但共享人才文件时必须串行。
- T033 依赖 Gateway 契约稳定；T035 依赖插件包和进程入口；T041 依赖 T039-T040 全绿。
- Push/PR（T042）只允许在 T040-T041 完成后；最终 T043 若发现缺口，必须在 PR 完成声明前继续修复。

## Parallel Opportunities

- 每个“先写测试”任务可在其依赖数据模型完成后独立准备，但同一共享工作区仍由单一 Agent 顺序写入。
- SQLite 权限底座与人才 RDS fixtures 可分别实现；实际提交保持原子化。
- 插件测试与部署模板可在 Gateway HTTP 契约冻结后准备。

## Implementation Strategy

1. 先完成 Phase 2-3，得到不依赖模型的多顾问权限底座。
2. 再完成 Phase 4，让真实业务价值在新权限边界内成立。
3. Phase 5 原生插件和服务器部署优先于 Phase 6 的解析/算法增强；结构化 reloop 数据足以支撑首批灰度。
4. Phase 6 保持增量、可取消和 shadow，不为“智能”牺牲授权与可恢复性。
5. 每完成一个实现任务：运行对应专项测试 → `npm run verify:quick` → 自我复盘 → 更新本清单与 `docs/AGENT_COMMIT_LOG.md` → 独立中文 commit。

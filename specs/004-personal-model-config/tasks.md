# Tasks: 顾问个人模型配置

**Input**: Design documents from `specs/004-personal-model-config/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/model-profile-api.md

**Tests**: 用户要求每个步骤验收，constitution 要求先写会失败的回放测试；所有实现任务均有对应自动化或真机证据。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可与同阶段其他任务并行，但本共享工作区仍由当前 Agent 顺序修改
- **[Story]**: 对应 spec.md 用户故事

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 固定契约、迁移和可注入边界

- [ ] T001 新增个人模型非敏感状态迁移与迁移回归测试 `migrations/0036_consultant_model_profiles.sql`、`tests/personal-model-config.test.mjs`
- [ ] T002 [P] 定义个人模型供应商目录、输入校验、错误类型和 OpenClaw 运行路径配置 `src/personal-model-config.js`
- [ ] T003 [P] 增加生产功能开关、OpenClaw state/config/bin/account 环境模板 `deploy/openclaw/openclaw.env.example`、`.env.example`

**Checkpoint**: 数据状态与配置入口存在，尚不写任何真实凭据

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 先证明个人 Agent、凭据和发布不会互相覆盖

- [ ] T004 先写并运行两顾问 Agent 派生、binding 校验、stdin 密钥、固定参数、超时与泄密负向测试 `tests/personal-model-config.test.mjs`
- [ ] T005 实现无 shell OpenClaw CLI runner、个人 Agent binding 解析、每顾问并发闸和安全错误归一化 `src/personal-model-config.js`
- [ ] T006 先写并运行动态 Agent、会话 self、agent-to-agent 关闭、无全局 StepFun、共享 Skills 与升级保留配置测试 `tests/openclaw-production-config.test.mjs`
- [ ] T007 实现 OpenClaw 动态个人 Agent、安全会话/模型作用域、批准 provider catalog 和无全局个人凭据配置 `deploy/openclaw/openclaw.production.json`
- [ ] T008 改造安装器为首次 seed、升级验证式 patch，并把七个 Skill 安装到 state 级共享目录 `deploy/openclaw/install.sh`

**Checkpoint**: Foundation ready；假密钥隔离实验可证明两个 Agent 互不读取，重复安装不删除动态路由

---

## Phase 3: User Story 1 - 配置我的飞书 Agent 模型 (Priority: P1) 🎯 MVP

**Goal**: 已登录、已绑定顾问能从工作台为本人 Agent 保存供应商、模型和 API Key

**Independent Test**: 两个 session 分别配置不同 provider/model，响应和状态互不覆盖且无完整 Key

### Tests for User Story 1

- [ ] T009 [P] [US1] 先写 GET/PUT 认证、同意、禁止身份字段、非法输入、Agent 未就绪和响应脱敏接口测试 `tests/personal-model-routes.test.mjs`
- [ ] T010 [P] [US1] 先写个人模型设置页面存在、无 localStorage/key 回显、同意交互和提交契约静态测试 `frontend/btex-frontend/tests/personal-model-ui.test.mjs`

### Implementation for User Story 1

- [ ] T011 [US1] 实现按当前 session open_id 查个人 Agent、写个人 auth profile、设置 Agent 显式 model 和非敏感审计状态 `src/personal-model-config.js`
- [ ] T012 [US1] 实现 GET/PUT personal model API 并挂载到现有登录鉴权 `src/personal-model-routes.js`、`src/server.js`
- [ ] T013 [US1] 实现前端 API 客户端和个人模型表单，不把 Key 放入 URL/持久化/错误消息 `frontend/btex-frontend/app/personal-model-api.ts`、`frontend/btex-frontend/app/personal-model-panel.tsx`、`frontend/btex-frontend/app/personal-model-panel.css`
- [ ] T014 [US1] 把个人模型分组接入真实设置中心并加载当前顾问状态 `frontend/btex-frontend/app/settings-center-review.tsx`、`frontend/btex-frontend/app/workbench-settings-page.tsx`
- [ ] T015 [US1] 将 `/brainx` “配置我的模型”改为 HTTPS 设置深链并更新确定性卡片测试 `plugins/brainx-openclaw/onboarding.js`、`tests/braintex-onboarding.test.mjs`

**Checkpoint**: US1 可在本地 HTTP 集成与隔离 OpenClaw state 中独立验收

---

## Phase 4: User Story 2 - 自动获得隔离的个人 Agent (Priority: P1)

**Goal**: 首次私聊自动创建并复用个人 Agent，未知用户不能获得业务能力

**Independent Test**: 两个 allowlist open_id 首次 DM 形成两个 Agent/binding；重复消息不新增；未知用户渠道层拒绝

### Tests for User Story 2

- [ ] T016 [US2] 扩展生产配置契约测试，覆盖动态 Agent 上限、named account peer binding、个人 session 和共享 Skill 可见性 `tests/openclaw-production-config.test.mjs`

### Implementation for User Story 2

- [ ] T017 [US2] 完成动态 Agent workspace/agentDir 模板、20 人上限、configWrites 与 allowlist 共存配置 `deploy/openclaw/openclaw.production.json`
- [ ] T018 [US2] 在安装/验收脚本中增加 Agent/binding/auth 元数据只读核验且不输出凭据 `deploy/openclaw/install.sh`、`specs/004-personal-model-config/quickstart.md`

**Checkpoint**: US1 与 US2 组合后无需管理员为新增白名单顾问手建 Agent

---

## Phase 5: User Story 3 - 安全更换或停用个人模型 (Priority: P2)

**Goal**: 顾问可轮换、切换、停用；部分失败可恢复

**Independent Test**: 假 Key 轮换后旧 profile 不被选用；停用后普通问答失败关闭而 `/brainx` 可用

### Tests for User Story 3

- [ ] T019 [P] [US3] 先写替换、停用幂等、并发冲突、CLI 部分失败和回滚测试 `tests/personal-model-config.test.mjs`、`tests/personal-model-routes.test.mjs`
- [ ] T020 [P] [US3] 先写前端停用确认、保存中禁用和失败恢复交互测试 `frontend/btex-frontend/tests/personal-model-ui.test.mjs`

### Implementation for User Story 3

- [ ] T021 [US3] 实现 profile 原子替换、旧 provider 清理、Agent model 回滚、DELETE 幂等停用 `src/personal-model-config.js`、`src/personal-model-routes.js`
- [ ] T022 [US3] 实现前端状态、轮换和停用交互 `frontend/btex-frontend/app/personal-model-panel.tsx`

**Checkpoint**: 凭据生命周期可由本人完成，错误不影响其他顾问

---

## Phase 6: User Story 4 - 管理员看状态但看不见密钥 (Priority: P2)

**Goal**: 形成六人上线可核验、不可取密钥的运维证据

**Independent Test**: 管理查询列出顾问/Agent/provider/model/status/time，Key 扫描为零

### Tests for User Story 4

- [ ] T023 [US4] 先写管理员权限、非管理员拒绝和全响应密钥扫描测试 `tests/personal-model-routes.test.mjs`

### Implementation for User Story 4

- [ ] T024 [US4] 增加复用现有管理员 allowlist 的非敏感就绪清单和配置审计读取 `src/personal-model-routes.js`
- [ ] T025 [US4] 增加不含正文/密钥的运维验收输出与文档 `docs/2026-09-03-openclaw-production-runbook.md`、`docs/2026-09-03-braintex-server-deployment-agent-manual.md`

**Checkpoint**: 管理员能判断谁可用，但无法通过 BrainX API 获得个人凭据

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 发布一致性、安全回归和生产证据

- [ ] T026 同步权威 PRD、部署手册、飞书首页说明、前端审核台账与审核记录 `docs/prd-2026-09-02-openclaw-ai-recruiting-workflow.md`、`docs/2026-09-03-braintex-feishu-home.md`、`docs/frontend-reviews/README.md`、`docs/frontend-reviews/2026-09-03-braintex-personal-model.md`
- [ ] T027 运行专项、`npm run verify:quick`、干净提交后的 `npm run verify`，登记每个原子 commit `docs/AGENT_COMMIT_LOG.md`
- [ ] T028 备份生产 OpenClaw state/config/SQLite/env，部署已验收 commit，确认重装不覆盖个人 Agent 数据 `specs/004-personal-model-config/quickstart.md`
- [ ] T029 绑定并验收 Mia、Felix、York、Wendy、Linda、Shanon 六人，至少由两位凭据所有者完成不同供应商真机问答 `specs/004-personal-model-config/quickstart.md`
- [ ] T030 推送分支、更新 PR、复核远端 CI 与生产 commit 一致并登记最终证据 `docs/AGENT_COMMIT_LOG.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 → Phase 2：先有状态和配置边界，才能操作 OpenClaw。
- Phase 2 → US1/US2：个人配置和动态 Agent 都依赖 CLI runner、隔离策略与保留式安装。
- US1 + US2 → US3：轮换/停用建立在可工作的首次配置和个人 Agent 上。
- US1 + US2 → US4：管理员只读取已形成的非敏感状态。
- 所有用户故事 → Phase 7：完整门禁和生产发布不得提前。

### User Story Dependencies

- **US1 (P1)**: 在基础完成后可独立配置已存在的个人 Agent。
- **US2 (P1)**: 在基础完成后可独立证明动态创建；与 US1 集成后形成完整首次使用路径。
- **US3 (P2)**: 依赖 US1 的 profile 服务。
- **US4 (P2)**: 依赖 US1 状态表，可与 US3 实现并行但共享路由文件时顺序修改。

### Parallel Opportunities

- T002 与 T003 可并行；T009 与 T010 可并行；T019 与 T020 可并行。
- 测试文件先于相应实现落地；共享工作区遵守单 Agent 写锁，不实际并发写文件。

## Parallel Example: User Story 1

```text
Task: T009 在 tests/personal-model-routes.test.mjs 写后端接口失败用例
Task: T010 在 frontend/btex-frontend/tests/personal-model-ui.test.mjs 写页面契约失败用例
```

## Implementation Strategy

### MVP First

1. 完成 Phase 1—2。
2. 完成 US1，让已存在个人 Agent 的顾问能自助配置。
3. 完成 US2，让新顾问首次私聊自动拥有个人 Agent。
4. 先用假 Key 和隔离 state 验收，再进入任何真实供应商调用。

### Incremental Delivery

1. 基础隔离与保留式部署。
2. 首次配置 + 动态个人 Agent。
3. 轮换/停用。
4. 管理状态。
5. 六人生产灰度；真实 API Key 必须由各自所有者提交。

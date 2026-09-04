# Feature Specification: 私聊 JD 直接提交建岗草稿

**Feature Branch**: `[005-private-jd-job-draft]`

**Created**: 2026-09-04

**Status**: Draft

**Input**: User description: "当前的对话式咨询出现了问题；顾问希望直接给 BrainX 机器人私聊发整段 JD 完成建岗。方案 A：新增 brainx_submit_job_jd 工具，JD 原文作为证据入库、sha256 幂等防重，LLM 提炼结构化字段（规则层保底、超时降级），草稿 source 标记 p2p 来源且仅提交人可见，确认复用现有 confirmDraft，建岗后衔接既有接单/找人链路。"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 顾问私聊发 JD 形成草稿（Priority: P1）

作为已绑定顾问，我希望在私聊中把整段 JD 原文直接发给 York AI 助手，系统自动提炼为带原文证据的待确认职位事实草稿，而不需要先把消息转发到已登记工作群。

**Why this priority**: 这是本功能的唯一新入口；没有它，私聊 JD 建岗链路不存在。

**Independent Test**: 已绑定顾问在私聊提交一段 ≥50 字的 JD 原文，验证系统产生且只产生一条 `origin='p2p_jd'` 的待确认草稿；重复提交同一段 JD 不产生第二条草稿。

**Acceptance Scenarios**:

1. **Given** 顾问身份绑定有效且 JD 原文 ≥50 字，**When** 顾问经 `brainx_submit_job_jd` 提交并确认执行，**Then** 系统产出一条 pending 草稿，字段带原文证据，原文全文与提交事件可追溯。
2. **Given** 同一顾问重复提交同一段 JD 原文，**When** 系统处理，**Then** 原文表、事件账本、草稿均保持单份，返回既有草稿引用（幂等短路）。
3. **Given** 提交文本不足 50 字，**When** 提交，**Then** 系统拒绝且不产生任何业务副作用。
4. **Given** AI_JOB_EXTRACT_ENABLED=1 但 LLM 未配置、超时或输出违反草稿 schema，**When** 提交，**Then** 系统降级为规则层提炼，不向顾问报错中断。
5. **Given** LLM/规则层都无法提炼出任何有效字段，**When** 提交，**Then** 不产生空草稿，返回明确的「无法提炼」结果。

### User Story 2 - 提交人查看并裁决草稿（Priority: P1）

作为提交 JD 的顾问，我希望在私聊的待确认列表中看到自己提交的 JD 草稿并确认或拒绝；其他顾问看不到、也无法裁决我的草稿。

**Why this priority**: 私聊来源草稿若不可见，User Story 1 的产出无法进入业务真值；可见性边界是本功能的安全核心。

**Independent Test**: 两位顾问分别提交各自 JD，验证每人只能列出并裁决本人提交的草稿；确认后形成职位权威事实并可被接单/推荐链路读取。

**Acceptance Scenarios**:

1. **Given** 顾问提交了一条 JD 草稿，**When** 顾问列出待确认草稿，**Then** 该草稿出现且带有来源与证据；其他顾问的列表中不出现该草稿。
2. **Given** 其他顾问尝试确认或拒绝该草稿，**When** 请求发生，**Then** 系统默认拒绝且不泄露草稿存在性。
3. **Given** 提交人确认信息充分的草稿，**When** 确认成功，**Then** 形成职位权威事实、确认人获得 MY_JOB 项目关系，并可被现有接单/推荐链路读取。
4. **Given** 草稿已被裁决，**When** 重复确认，**Then** 返回已处理结果，不重复写入。

### User Story 3 - 工具面契约一致（Priority: P2）

作为系统维护者，我希望新工具在 openclaw 插件、agent-gateway 注册表和插件契约 fixture 三处声明一致，p2p-only 与参数上限统一生效。

**Why this priority**: 工具契约漂移会让生产校验与插件清单脱节。

**Independent Test**: 三处工具清单断言一致；registry 校验 `jd_text` 长度上限 8000、`confirm` 必填、非 p2p 通道被拒。

**Acceptance Scenarios**:

1. **Given** 插件清单、注册表与 fixture，**When** 校验工具清单，**Then** 三处均包含 `brainx_submit_job_jd` 且数量一致。
2. **Given** group 通道调用或 `confirm` 缺失，**When** 调用工具，**Then** 校验失败且不触达 handler。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 MUST 提供 `brainx_submit_job_jd` 工具，仅限 p2p 私聊、仅限已绑定在职顾问，参数为 `jd_text`（50–8000 字符）与 `confirm`（必须为 true）。
- **FR-002**: 提交的 JD 原文 MUST 全文存入 `lark_messages` 并以 `lark.message_received` 事件入账本，作为后续确认的证据链。
- **FR-003**: 幂等 MUST 以 `sha256(consultant_id + "\n" + JD 原文)` 派生 message_id 实现：原文表 INSERT OR IGNORE、账本 idem_key 唯一、草稿对 `origin='p2p_jd'` 建部分唯一索引；重复提交 MUST 安全短路返回既有草稿。
- **FR-004**: 提炼 MUST 优先使用 LLM 层（AI_JOB_EXTRACT_ENABLED=1 且 llm 已配置），任何失败（未配置/超时/schema 违规）MUST 静默降级为规则层；LLM 超时 MUST ≤8 秒以适配插件 10 秒请求上限。
- **FR-005**: 抽取字段 MUST 遵循「宁缺勿错」：只抽原文明确存在的信息并回带 evidence 原文子串；salary/requirements 仅存 raw_json 存档并回显，不得写入权威列。
- **FR-006**: 草稿 MUST 记录 `origin='p2p_jd'` 与 `submitted_by`（提交人 consultant_id）；存量数据 origin 默认 'group'。
- **FR-007**: 草稿可见性 MUST 扩展为「登记群成员可见群草稿，或 origin='p2p_jd' 且 submitted_by=本人」；裁决守门沿用现有可见性判断，越权默认拒绝。
- **FR-008**: 确认/拒绝 MUST 复用现有 `confirmDraft`/`rejectDraft`；新建职位仍要求 company+role，本功能不得引入绕过确认门直写权威表的路径。
- **FR-009**: 提炼不出任何有效字段的提交 MUST 不产生草稿，并返回可区分的「无法提炼」结果。

### Key Entities

- **JD 提交事件**：p2p 私聊提交的 JD 原文事实，具有 sha256 派生的稳定消息身份与证据引用。
- **p2p 职位事实草稿**：origin='p2p_jd' 的待人工裁决事实，仅提交人可见。
- **职位权威事实**：确认后进入既有职位域，与群链路产物同构、同链路消费。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 已绑定顾问私聊提交一段真实 JD，10 秒内返回一条带证据的 pending 草稿；重复提交 100 次草稿保持单份。
- **SC-002**: 两位顾问各自提交的草稿互相不可见、不可裁决；提交人确认后职位事实可被 `brainx_job_assessment` 读取。
- **SC-003**: AI 开关关闭时全链路可完整演示（规则层）；开关开启且 LLM 正常时草稿 layer=llm，LLM 故障时自动降级且不报错中断。
- **SC-004**: 插件清单、注册表、fixture 三处工具契约断言一致；非 p2p、confirm 缺失、jd_text 越界均被拒绝且有测试覆盖。
- **SC-005**: 现有全部测试（含群链路 job-facts 测试）回归通过，可见性改动不引入群草稿越权。

## Assumptions

- 复用 `src/llm.js`（chatJson）、`classify.js`（mapLlmFields/extractRules）、`schema.js`（validateDraft）、`confirm.js`（confirmDraft/rejectDraft），不新建提炼框架。
- 草稿 schema（migrations/0031 的字段集）不变；薪资/任职要求无权威列，仅存档于 raw_json，权威列扩展留待后续规格。
- 生产部署（openclaw 插件重装、brainx 服务重启、环境变量 AI_JOB_EXTRACT_ENABLED）属于接入阶段，不在本规格代码范围内。
- 一次只激活一个 feature；本功能不改变 003 群链路行为。

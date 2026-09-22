# 招聘工作流技术栈与 Q&A 代码核对

> 上级入口：[文档书](../README.md) · [展示页](../design/braintex-ai-recruiting-os.html)
> 相关：[本轮前端记录](../frontend-reviews/2026-09-17-workflow-tech-stack.md) · [上传前完整验证](../standards/PRE_PUSH_VERIFICATION.md)

## 范围与结论

2026-09-17，基于 `7a5aef6` 核对四阶段、16 节点的调用链、依赖与测试。此为演示技术口径审阅，不是全面安全审计或生产验收；没有读取生产凭据、调用收费搜索、发送飞书消息或写业务库。

核心结构是：飞书 / OpenClaw 负责交互与工具编排，BrainX 负责确定性业务规则、权限和持久化，上游找人接口负责外部搜索。后端为 Node.js / JavaScript，基础数据使用 `node:sqlite`，人才数据使用 `mysql2` 连接 RDS MySQL；没有理由把架构规划中的组件全部写成当前技术栈。

## 逐节点证据

| 节点 | 当前机制与技术 | 直接代码证据 |
|---|---|---|
| 职位汇总 | TTC REST API、飞书 Bitable、分页/增量游标、SQLite 完整快照；Radar 是内部视图 | [bridge.js](../../src/bridge.js)、[ttcsdk/job.js](../../src/ttcsdk/job.js)、[sync.js](../../src/sync.js) |
| AI 分析 | `baseline-1.1` 六维确定性加权、硬规则、冻结推荐；不是 LLM 分数 | [scorer.js](../../src/scorer.js)、[recommend.js](../../src/recommend.js) |
| 顾问选项目 | 画像关键词、历史项目、公司级正负反馈；人工确认后记决策和首个行动 | [scorer.js](../../src/scorer.js)、[engagement.js](../../src/engagement.js)、[commitment.js](../../src/commitment.js) |
| 自动派单 | Node Worker 定时推送，个人订阅，`push_log` 防重；接单与建群为受控动作 | [scheduler.js](../../src/scheduler.js)、[push.js](../../src/push.js)、[project-launch.js](../../src/project-launch.js) |
| 职位画像 | 职位事实与 criteria 拼接；独立 JD 入口为 LLM JSON 抽取、Zod 校验、规则兜底与确认转正 | [openmai-task.js](../../src/openmai-task.js)、[jd-extract.js](../../src/job-extract/jd-extract.js)、[p2p-submit.js](../../src/job-extract/p2p-submit.js)、[schema.js](../../src/job-extract/schema.js)、[confirm.js](../../src/job-extract/confirm.js) |
| 多渠道推人 | OpenMai/SuperMai 共用 completions，分别按职位/判据；SSE+Polling；Reloop 入口为授权预计算 shortlist | [openmai-task.js](../../src/openmai-task.js)、[supermai-sourcing.js](../../src/supermai-sourcing.js)、[candidate-shortlist.js](../../src/candidate-shortlist.js)、[tools-talent.js](../../src/agent-gateway/tools-talent.js) |
| 筛选与打标 | 人工初筛写 SQLite 重点名单；独立规则模块从技能事实/摘要回填 MySQL 标签 | [candidate-focus.js](../../src/candidate-focus.js)、[talent-tag-backfill.js](../../src/talent-tag-backfill.js) |
| 人才入池 | `brainx_talent_pool_add` 将姓名、脱敏摘要、来源标记写入 RDS `talent`，写前检查已有记录 | [tools-candidate-actions.js](../../src/agent-gateway/tools-candidate-actions.js)、[db.js](../../src/db.js) |
| 群内交互 | OpenClaw 原生插件 / Tool Calling → HTTP Agent Gateway；HMAC-SHA256 主体声明、nonce、防重放、项目用途范围、审计 | [runtime.js](../../plugins/brainx-openclaw/runtime.js)、[assertion.js](../../src/agent-gateway/assertion.js)、[authorization.js](../../src/agent-gateway/authorization.js)、[audit.js](../../src/agent-gateway/audit.js) |
| 电话沟通 | 人工电话；手工纪要进入群消息/进展；报告侧 PII 文本遮蔽；未接自动拨号/ASR/TTS | [commitment.js](../../src/commitment.js)、[candidate-report.js](../../src/candidate-report.js) |
| 推荐跟进 | 状态机、事务、幂等键、下一行动；阶段与静默窗口提醒 | [engagement.js](../../src/engagement.js)、[commitment.js](../../src/commitment.js)、[stage-reminder.js](../../src/stage-reminder.js)、[project-reminder.js](../../src/project-reminder.js) |
| 需求更新 | 插件缓存同群条件并注入 criteria；后端轮次与 TTC 排除集 | [search-start-notice.js](../../plugins/brainx-openclaw/search-start-notice.js)、[search-rounds.js](../../src/search-rounds.js)、[tools-jobs.js](../../src/agent-gateway/tools-jobs.js) |
| 上下文汇总 | 基于 project/candidate 引用组装重点候选快照、来源群摘要和近期讨论，脱敏后迁入决策群 | [candidate-decision-group.js](../../src/candidate-decision-group.js)、[candidate-report.js](../../src/candidate-report.js) |
| Offer 分析 | 固定六节模板组装证据与检查清单，调用飞书 Docx API；生成函数未调用 LLM | [candidate-report.js](../../src/candidate-report.js)、[feishu-document.js](../../src/feishu-document.js) |
| 多轮完善 | 复用单文档，REGENERATE 追加、READ 读取当前正文；机器人以工具返回正文问答 | [candidate-report.js](../../src/candidate-report.js)、[feishu-document.js](../../src/feishu-document.js)、[prompt.js](../../plugins/brainx-openclaw/prompt.js) |
| 最佳实践 | Markdown 方法库、人工蒸馏与确认、Skill 按需加载；不等于自动训练 | [猎头经验蒸馏器](../hunter-distillation.md)、[方法库](../../skills/brainx-hunter-playbook/SKILL.md)、[skills.js](../../src/agent/skills.js) |

## 现场追问口径

1. **AI Native 体现在哪里？** 从真实业务步骤出发，将语言理解、结构化提取、工具调用和上下文连接到具体动作；不是所有步骤都必须由 LLM 执行。确定性规则仍承担权限、排序和状态写入。
2. **模型是什么？** 后端 `llm.js` 支持配置化的 OpenAI-compatible Chat Completions；OpenClaw 模型另由其配置/个人模型入口管理。本次未读取生产配置，因此不宣称统一使用某个具体模型。配置示例不是正在运行的模型证据。
3. **算法是不是自研？** 职位排序是本地 `baseline-1.1`；人才预计算可使用 `supply-match-v1`（技能 0.5、意向 0.3、文本 0.2）。外部 OpenMai/SuperMai 的内部搜索算法不在本仓库，不能归为自研。
4. **是不是向量检索 / RAG / Fine-tuning？** 当前审阅主链是 SQL、词项匹配和工具取数后组装上下文。不能因使用上下文就宣称已上线向量 RAG。BGE-M3、FAISS、LambdaMART、Bandit、SHAP 在算法规划中，不属于当前正式链路。
5. **记忆在哪里？** 顾问偏好、项目决策、候选重点名单等在结构化业务库；群搜索补充条件另存在插件内存 Map，不具备跨重启持久性。方法文档是 Skill 上下文，不是模型参数。
6. **为什么不会重复推荐？** 下一轮提取可识别 TTC 稳定编号，并继承已有排除集；不是姓名级全渠道实体合并，也不保证第三方一定完全遵守。编号排除上限为 100；未知编号时不能许诺全量去重。
7. **找人能力有多大？** 本地 `talent-match-run.js` 当前扫描至多 500 条人才并输出每岗至多 20 条预计算结果；模块不自带定时循环，不能说已对任意规模全库实时召回。Reloop shortlist 空不等于外部搜索没有人。
8. **为什么能稳定执行？** 本地已有任务状态、幂等键、超时、推送去重及审计等工程机制；不将其表述为绝对 exactly-once，也不假设每条跨系统写入都有完整重试队列。
9. **是不是已经全部上线？** 本次只核对代码与本地测试。单报告编辑稿问答的目标环境验证仍待补证，详见[已有记录](../frontend-reviews/2026-09-16-candidate-offer-single-report.md)。

## 审阅中确认的限制（仅记录，不改后端）

- “加入reloop”当前直接写 BrainX RDS 人才表，没有在该 handler 中调用 ReLoop 应用写接口；`sync_pending` 返回分支没有在此落持久重试任务，不能口头保证失败后自动完成同步。
- Offer 模板只汇总已有证据；群消息按最近 60 条读取，追加逻辑按消息数量计算，不是覆盖任意长历史的增量游标。报告使用组织内链接可编辑权限，不应描述为只有该群成员可编辑。
- 文档读取问答已经有代码与模拟测试，但人工编辑稿是否在目标环境正确进入回答，必须另行真机验收。
- 规则标签回填、人才匹配跑批、Skill 方法加载是独立能力；不得把存在模块等同于所有按钮已自动串联这些能力。

## 验证方法

- 新增展示文档回归测试：16 个节点都有技术栈、机制和 Q&A；默认折叠；关键边界保留；锚点有效；不新增脚本或远端资源。
- 运行对应业务已有测试与 `npm run verify:quick`；用 Playwright 检查桌面/手机展开与键盘交互，人工复核截图。
- 本轮实际结果与发布边界见[前端复核](../frontend-reviews/2026-09-17-workflow-tech-stack.md)；完整门禁在提交后运行，生产环境不在本次验证范围。

## 相关文档

- [工作流架构](../workflow-hub-architecture.md)
- [算法标准与当前基线](../BrainX岗位推荐算法与评分标准.md)
- [前端审核台账](../frontend-reviews/README.md)

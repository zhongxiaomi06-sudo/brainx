# specs/036 — sourcing 快照结构化与群内检索（sourcing-recall）

## 背景与实证

2026-10-13 群内回归实测（f6d44a0）：顾问 @bot 问「上次那轮结果里筛出有小红书或字节背景的」，
`agent_tool_calls` 审计表零工具调用——bot 纯靠会话记忆回答「我这边没有保留那张卡片的内容，没法直接筛」，
并提议把筛选条件写进判据重新付费搜索。三个问题一次实证：

1. 机器人失忆：快照数据在 `openmai_results` / `sourcing_group_deliveries`，agent 无检索入口。
2. 语义错位：把「在已有结果里筛」当成「重新搜新人」，搜索判据与筛选条件无概念区分。
3. 付费当解法：零成本过滤被转化为一次新的 OpenMai 付费任务。

附带实证：CONTACT 一律报 not_authorized，已入库待撞库 / 库中无数据 / 真未授权三态不分；
`next_allowed_actions` 在群内指向 p2pOnly 工具；tools.allow 含两个死条目（openclaw 日志每次重启警告）。

## 目标

1. 每轮搜索结果拆行落库为结构化候选人行（`sourcing_candidates`），append-only。
2. 新工具 `brainx_sourcing_recall`：在本人历史搜索结果中按条件筛选 / 排序 / 计数，零 OpenMai 费用、秒回。
3. CONTACT 返回语义拆为三态：`in_pool_pending_match`（已入库待撞库）、`no_contact_data`（未撞库无数据）、
   `not_authorized`（真未授权）。
4. 群内体验配套：外部搜索前先报库内已有匹配；结果卡候选人带生涯徽标；搜索触发后发状态消息；
   recall 工具与 scout 工具的 description 明确「筛选 vs 新搜索」语义分工。
5. 部署一致性：`bin/sync-agent-tools.mjs` 从 tool-registry 生成插件声明并同步 tools.allow，消除人肉三处同步。

## 非目标（明确推迟）

- `openmai_results` 拆 append-only 轮次表：改动面覆盖全部搜索读写链路，风险高；`sourcing_candidates`
  已按轮保留候选人快照，历史盘点需求已可满足。原 result_text 仍按现行覆盖语义运行。
- 判据多轮结构化收集（agent 引导式补全城市/年限）：需要多轮交互设计，单独立项。

## 契约

### 数据（migration 0067）

`sourcing_candidates`：主键 `(search_key, consultant_id, search_round, candidate_ref)`；
列 = 快照字段（name/company/title/city/experience/education/evaluation/score_raw/score_num/
talent_url/resume_url/profile_url）+ `career_status`（recommended|screened|in_pool|rejected|restored）。
列宽全部 TEXT 不设限；解析层（openmai-result.js V1 契约）已按 60/120/300 截断字段，
落库层如实保存不做二次截断，另设 2000 字符防御上限兜底。城市索引 `(consultant_id, city)`。

写入时机：`settleOpenmaiTask`（openmai/openmai/supermai 两入口的公共 settle 点）done 时同步拆行；
四动作 / 入库动作回写 `career_status`（单写方向：动作→状态）。

### 工具（agent gateway）

`brainx_sourcing_recall`，purpose `candidate_review`：
- 参数：`search_key`（可选，省略查本人全部自由找人历史）、`filter`（自由文本关键词，匹配
  公司/职位/评估/姓名）、`city`、`order_by`（score|time，默认 score）、`limit`（1-20，默认 10）。
- filter 语义：多个词之间 AND；「|」/「｜」分隔 OR 组——组内 AND、组间 OR
  （2026-10-13 群测第二次回归实证：「小红书或字节」按纯 AND 查询零命中，工具层把
  「或/或者/or//」归一化为「|」后由数据层分组匹配）。
- 只读本人行（consultant_id 隔离），返回脱敏行，字段不触投影禁词（GROUP_FORBIDDEN_KEY）。
- description 明确：「在已有搜索结果里筛选用本工具；要找全新的人用 brainx_supermai_scout；
  用户说的『或』写成 A|B。」

### CONTACT 三态

`sendCandidatePrivateContact` 在调用授权查询前先查 talent 库 `[ref:xxx]` 是否在库：
- 在库且无 cfv/grant/phone → `in_pool_pending_match`（话术：已入库待撞库，可开 TTC 深链）；
- 不在库 → `no_contact_data`（话术：尚未入库，联系方式需要先加入 reloop 或走 Reloop 授权流程）；
- 有 cfv+grant 但无 phone → 既有 `pending`；无 grant → `not_authorized`。

### 群内体验

- scout 触发新搜索前（freeform 模式）先查 `sourcing_candidates`：命中≥3 人返回 internal_matched
  让 agent 询问「看库内匹配还是继续外搜」，顾问确认后才付费触发——不做静默拦截。
- 结果卡候选人姓名旁渲染生涯徽标（已初筛/已入库/已拒绝）；卡片渲染回归场景登记 + 基线更新。
- 搜索 triggered 后 best-effort 发一条状态消息（「正在找人，完成后结果自动进群」），失败不阻断。
- `next_allowed_actions` 在群上下文只指向群内可用动作（p2pOnly 工具不再出现在群内建议）。

## 验收（全部群内真实话术）

1. 「上次那轮里筛出有小红书或字节背景的」→ recall 秒回名单（3 秒内、零 OpenMai 调用、答的是原批人）。
2. 对已入库候选人查联系方式 → bot 答「已入库待撞库」，不再说「未授权」。
3. 新判据触发外搜前 → bot 先报库内已有匹配数并询问是否继续。
4. 结果卡上已处理过的候选人带生涯徽标。
5. 群内 case 流转后的下一步建议不再指向私聊专属工具。
6. 部署：单脚本完成插件声明 + tools.allow 同步，openclaw 重启无 unknown entries 警告。

## 验证纪律

- 每步 `npm run verify:quick`；卡片改动跑渲染回归 `--update` 更新基线后提交；
  完工跑 full `npm run verify`（已知 worker 就绪测试为并行负载环境态，单跑复核）；
  部署生产后以 live 特征串 + 群内真实回归收尾。

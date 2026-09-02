# 候选人事实与 shortlist 数据契约（v1）

> 上级入口：[BrainX 文档书](README.md)
>
> 产品依据：[BrainX × OpenClaw AI 猎头工作流 PRD](prd-2026-09-02-openclaw-ai-recruiting-workflow.md) §9—§14
>
> 适用场景：解析 worker、匹配 worker、人才 RDS 和 OpenClaw 候选人只读工具之间的数据交付。

## 1. 当前结论

本阶段不安装 Resume-Matcher 整套应用，也不改变正式推荐算法。先交付能承载后续解析与影子匹配的数据脊柱：

1. `candidate_fact_v1`：候选人的版本化结构事实；
2. `candidate_match_bundle_v1`：某次已完成匹配运行的脱敏 shortlist 投影；
3. 人才 RDS 独立迁移历史及十张增量表；
4. `brainx_candidate_shortlist` 单顾问 PoC 工具。

OpenClaw 只读取 BrainX 已经处理完成并授权的数据，不直接读取原始简历、不执行 SQL、不临时扫描整个人才库。

## 2. 代码权威

| 内容 | 权威实现 |
|---|---|
| 两个 JSON 契约及隐私校验 | `src/talent-contracts.js` |
| shortlist 授权查询与字段投影 | `src/candidate-shortlist.js` |
| reloop 结构化事实转换 | `src/reloop-shortlist-pipeline.js` |
| reloop 推荐批次导入 | `src/reloop-shortlist-sync.js`、`scripts/sync-reloop-shortlist.mjs` |
| 固定飞书安全文案 | `src/candidate-shortlist-message.js`、`scripts/preview-candidate-shortlist.mjs` |
| Agent 分析飞书卡片外壳 | `src/candidate-shortlist-card.js` |
| 人才 RDS 迁移执行器 | `src/talent-migrations.js` |
| 增量迁移 | `talent-migrations/0001_candidate_data_v1.mjs`、`0002_job_access_grants.mjs` |
| OpenClaw 本地 PoC 工具 | `mcp/server.mjs` |

文档用于解释设计，字段真值以 Zod 契约和迁移代码为准。修改字段时必须同时更新契约测试、迁移兼容性说明和本文。

## 3. `candidate_fact_v1`

### 3.1 用途

它把 PDF、DOCX 或旧文本解析结果变成可校验、可追溯、不可悄悄覆盖的事实版本。后续无论使用 Docling、MarkItDown 还是自研规则，最终都必须先通过这一契约才能写入事实版本表。

### 3.2 顶层结构

```json
{
  "schema_version": "candidate_fact_v1",
  "fact_version_id": "cfv_...",
  "candidate_ref": "cand_...",
  "document": {
    "document_ref": "doc_...",
    "source_format": "pdf",
    "content_hash": "64位sha256",
    "parser_version": "parser-name@version",
    "processed_at": "ISO-8601"
  },
  "identity": {},
  "work_experiences": [],
  "education": [],
  "skills": [],
  "constraints": [],
  "evidence": [],
  "quality": {}
}
```

关键规则：

- 每段工作、教育、技能和已确认约束必须引用 `evidence_ref`；
- 所有引用必须在同一版本的 `evidence` 列表中存在；
- 证据只存来源引用、页码/段落/字符范围和片段 hash，不在证据表复制简历原文；
- 未知求职约束使用 `state=UNKNOWN`、`value=null`，不能猜测；
- 电话、邮箱和完整简历字段不属于本契约；联系方式只允许使用不透明 `contact_ref`；
- 契约为 strict，新增未知字段会直接失败；文本中检测到手机号或邮箱也会失败。

### 3.3 质量状态

| 状态 | 含义 | 是否可进入 shortlist |
|---|---|---|
| `READY` | 结构和证据达到当前读取门槛 | 是 |
| `NEEDS_REVIEW` | 可保存供人工复核 | 否 |
| `OCR_REQUIRED` | 扫描件或文本质量不足 | 否 |
| `REJECTED` | 文件或结构被拒绝 | 否 |

当前 shortlist 查询只读取 `READY`，不会由 Agent 自行降低质量门槛。

## 4. `candidate_match_bundle_v1`

### 4.1 用途

这是发给 Agent 的最终候选人列表，而不是算法内部任意特征。它由数据库归一表实时组装并再次通过 strict schema 和敏感文本检查。

每个候选人必须分开呈现：

- `strength`：候选人自身实力，0—100；
- `job_fit`：针对当前职位的匹配，0—100；
- `hard_conditions`：逐条 `PASS|FAIL|UNKNOWN`；
- `gaps`、`risks`、`unknowns`；
- `data_freshness`；
- 支撑判断的 `evidence_refs`。

为了让 Agent 能作出猎头可用的判断，而不是只复述分数，读取投影还包含：

- `job_context`：职位标题、职责摘要、经验/学历要求、必需与优先能力，以及源数据明确缺失的职位条件；
- `profile`：候选人的脱敏地点、最近四段结构化经历、最多三段教育和显式技能；
- 工作摘要最多返回 700 字，只来自已经通过 `candidate_fact_v1` 的字段，不返回事实中的完整姓名、联系方式、原文或证据片段。

以上是 `candidate_match_bundle_v1` 的向后兼容读取增强；数据库中的旧 match payload 不改写。服务端在读取时从同一不可变 fact version 构造最小投影，再执行 strict schema 和敏感文本检查。

不得把两类分数合并成“录用概率”，也不得返回手机号、邮箱、完整简历、飞书 `chat_id` 或其他路由身份。

### 4.2 分页

- 每页最多 20 人，MCP 默认 5 人；
- 首次读取选择该租户、职位最新的 `SUCCEEDED` run；
- 下一页 token 固定 `match_run_id` 和上一页最后 rank，避免翻页期间新 run 导致串页；
- token 不是授权凭证。每次翻页仍重新校验租户、职位、顾问、人才授权、有效期和事实质量；
- 非法 token 在查询数据库前失败。

## 5. 人才 RDS 表

`npm run init-talent` 会先保证原七张基础表存在，再运行 `talent-migrations/` 中按文件名排序的增量迁移。

| 表 | 作用 |
|---|---|
| `talent_schema_migrations` | 记录文件名、内容 checksum 和执行时间 |
| `talent_access_grants` | 人才、授予者、被授权对象、scope、purpose、有效期和撤销状态 |
| `candidate_source_links` | reloop 等外部候选人与内部最小影子人才的稳定映射 |
| `candidate_documents` | 文档 hash、解析器版本和处理质量，不存原文 |
| `candidate_fact_versions` | `candidate_fact_v1` 不可变 JSON 版本 |
| `candidate_fact_evidence` | 字段到来源位置的证据锚点 |
| `job_criteria_versions` | 职位条件不可变版本 |
| `match_runs` | 匹配运行及 `PENDING→RUNNING→SUCCEEDED|FAILED|CANCELLED` 状态 |
| `candidate_job_matches` | 每次 run 的候选人排名、双分数和解释 payload |
| `source_sync_cursors` | 外部人才源增量同步水位 |
| `job_access_grants` | 外部职位、顾问、purpose、有效期和撤销状态 |

迁移遵循 additive-first，不修改历史 migration、不删除旧表/旧列、不覆盖 `resume.parsed_content` 和 `match_record`。MySQL DDL 会隐式提交，因此每条 DDL 都必须可幂等重放；全部执行成功后才登记 migration checksum。已经登记的迁移文件禁止改写，应新增下一个文件。

## 6. 授权查询

`brainx_candidate_shortlist` 的读取顺序是：

1. MCP 启动时同时存在 `BRAINX_MCP_CONSULTANT_ID` 与 `BRAINX_MCP_TENANT_ID`，否则工具不出现在清单；
2. BrainX 本地职位先使用 SQLite `jobVisibleTo`；`reloop-position:<id>` 只允许精确格式进入 RDS 授权查询；
3. RDS 查询锁定相同租户和外部职位引用，并要求有效 `job_access_grants`；
4. 只选择 `SUCCEEDED` 且有完成时间的 match run；
5. 每名候选人都必须有未撤销、未过期、purpose 相同的 `resume_facts` grant；职位和人才两道授权缺一不可；
6. 事实版本必须是 `READY`；
7. 服务端只选择契约所需列，姓名只返回首字符加星号；
8. 输出前再做 schema 和敏感文本校验。

人才不存在、职位不存在、无授权和没有可用 shortlist 对外统一为空或 `NOT_FOUND_OR_FORBIDDEN`，不能靠响应差异枚举对象。RDS 不可用返回 `SOURCE_UNAVAILABLE`，不退到 `src/talent.js` 的进程内内存库，也不输出 SQL、主机名或凭据提示。

## 7. OpenClaw 接入边界

当前 `mcp/server.mjs` 的实现只适用于“服务端绑定一个顾问和一个租户”的可信本地/隔离 PoC：

```text
BRAINX_MCP_CONSULTANT_ID=<内部顾问ID>
BRAINX_MCP_TENANT_ID=<内部租户ID>
```

这两个值必须由部署配置注入，不能成为模型参数或写进 Skill。OpenClaw allowlist 只增加精确工具名 `brainx-domain__brainx_candidate_shortlist`，不能开放整台 MCP server。

多人生产仍按权威 PRD 使用 OpenClaw 原生插件读取可信 requester context，再由 BrainX Agent Gateway 做 App 维度身份映射、短时签名、重放防护、字段裁剪和审计。单顾问环境变量绑定不能替代生产身份网关。

## 8. 当前完成与未完成

### 8.1 2026-09-03 真实环境核验

- 当前配置的 RDS `reloop` 旧七表为空，但同实例 `reloop_app.talent_profiles` 是真实结构化人才源；`COUNT(*)` 精确值为 4,156（不能使用 `information_schema.TABLE_ROWS` 的 2,264 估算值作业务口径）；
- `York团队AI助手` 数据账号的 `ttc_bound_name` 明确为 `Mia 钟笑咪`，该账号下 383 份人才、6 个职位、20 条现有推荐；
- 首个 PoC 选取仍启用的 `reloop-position:31`（“沐仞科技 HR岗”），只读取最新 pending 推荐批次；
- 10/10 候选人通过 `candidate_fact_v1`，已写入 10 个最小影子人才、10 份事实、144 条 hash 证据、候选授权、职位授权和版本化 match run；
- 当前最新 run 使用 `reloop-existing-recommendation-v1.2`。它仍不改变候选排序，只允许职位能力在结构化技能或工作经历中出现明确词项/保守同义证据时标为 `PASS`，修复已有招聘交付却显示“招聘待确认”的误导；
- OpenClaw `brainx` profile 已绑定 `consultant=mia`、`tenant=ttc-york-team`，MCP probe 确认只外露 7 个精确只读工具，其中包含 shortlist；
- `brainx-talent` Skill 已通过 OpenClaw 官方本地安装入口进入 main Agent 工作区，状态为 Ready 且对模型可见；回答规范改为“岗位投入判断—候选结论—真实证据—最大风险—首问问题”，禁止字段搬运和长串待确认项；
- 数据责任人已明确授权脱敏 shortlist 进入当前 OpenAI 模型。OpenClaw 使用 `gpt-5.5` 完成一次真实 Agent turn，执行记录显示只调用 1 次 `brainx_candidate_shortlist`、失败 0 次；生成结果经敏感字段复核后由飞书企业机器人发送到 Mia 私聊，飞书返回消息 ID `om_x100b66b20466a0a0c218868c5e0df24`。
- 用户反馈首版内容没有猎头决策价值。新版工具已在真实 RDS 返回职位画像和 Top 3 脱敏成果经历，v1.2 Top 10 已写入新不可变 run `rrun_5aa9caf49ab03ce299b504c4992b159557b401ebe2a94dff`；数据责任人随后明确授权脱敏公司、岗位、教育和成果数字进入当前 OpenAI 模型并发送给 Mia 私聊。
- 第二版 OpenClaw run `ce8d43af-8fe2-4126-a24e-24dbf73a263f` 使用 `openai/gpt-5.5` 成功生成猎头判断。审计记录显示人才数据只由 `brainx_candidate_shortlist` 返回；另一次 `bash` 调用仅以只读方式打开 `brainx-talent/SKILL.md`，没有读取数据库、其他文件或网络。输出中的公司、岗位和成果数字均能在 shortlist 字段中定位，手机号、邮箱、完整姓名和简历原文复核为 0。
- 首次用旧 BrainX 飞书应用的 Mia `open_id` 发送时，飞书以 `open_id cross app` 拒绝，未产生消息；改用当前 OpenClaw 飞书应用中已配对且标记为 owner 的应用内 `open_id` 后发送成功，消息 ID 为 `om_x100b66b2b17f98a4c226a29b1de8d0a`。卡片按钮指向本机 `http://127.0.0.1:3100/`，发送前 HTTP 200 已验证；公网 `http://47.110.93.137:3100/` 当时不可达，因此本次按钮只适用于同一台电脑，不代表公网部署完成。
- 10 份事实重新通过生产 Zod 契约，排除 hash/ref 后的可展示文本手机号/邮箱命中均为 0；数据库整段正则会误扫 SHA-256 连续数字，不作为隐私验收方式。

已完成：

- 两个 strict 数据契约；
- 联系方式内容检测与未知字段拒绝；
- 人才 RDS 迁移执行器和十张增量表；
- 只读授权 SQL、版本固定分页、错误收口；
- 单顾问/单租户 MCP shortlist 工具；
- reloop 结构化档案到事实契约的确定性转换；
- 现有推荐批次的幂等导入、版本化 run 和固定文案预览；
- 真实 RDS migration、真实 Top 10 导入、OpenClaw 双层白名单与 MCP probe；
- 脱敏职位画像/成果履历读取投影、猎头判断 Skill 和带 BrainX 查询按钮的固定卡片外壳；
- OpenClaw 真实读取脱敏 Top 3、生成推荐文案并由飞书机器人投递 Mia 私聊；
- 契约、迁移、查询、MCP 暴露条件回归测试。

尚未完成：

- 尚未把全部 383 份档案或其他顾问数据增量同步；
- 尚未安装 Docling/MarkItDown 或启动解析 worker；
- 尚未对非结构化 PDF/DOCX 生成新事实；当前首批直接复用 reloop 已有结构化档案；
- 尚未用 BrainX 新算法重排，当前保留 reloop 既有 Top 10 顺序；
- 尚未实现候选人详情、fit 和 gap 工具；
- 尚未实现多人生产 Agent Gateway、撤权后的缓存/索引删除传播。

因此当前已经完成单顾问 PoC 的“真实数据 → 严格事实 → 双重授权 → OpenClaw 读取 → Agent 生成 → 飞书机器人私聊投递”闭环；它证明了技术链路可行，但不能表述为多人生产已完成。

## 9. 下一步

1. 由 Mia 核对第二版飞书互动卡片的展示口径，再决定每日发送时间和 Top N；
2. 部署可由其他顾问访问的 HTTPS BrainX 正式入口，并把卡片按钮从本机地址切到稳定对象深链；
3. 把 `reloop_app` 的用户—顾问授权同步从本次人工绑定改为可撤销的正式同步作业；
4. 为 383 份结构化档案做增量游标，而不是每天全量复制；
5. 用顾问反馈标注比较 reloop 既有排序与 BrainX 影子算法，达标后才切换排序；
6. PDF/DOCX 无结构化来源时再引入 Docling/MarkItDown，扫描件明确标 `OCR_REQUIRED`；
7. 实现生产 Agent Gateway、可信 requester 身份映射和撤权传播后，才向其他顾问推广。

### 9.1 当前 PoC 命令

以下命令默认只读；导入命令只有显式 `--apply` 才写影子表：

```text
npm run candidate:sync:reloop -- --tenant <tenant> --consultant <cid> \
  --source-owner <reloop_user_id> --bound-name <ttc_bound_name> --position <id>

npm run candidate:preview -- --tenant <tenant> --consultant <cid> \
  --job reloop-position:<id> --job-name <职位名> --limit 3
```

## 10. 验证

专项测试：

```text
node --test --test-force-exit tests/talent-contracts.test.mjs \
  tests/talent-migrations.test.mjs tests/candidate-shortlist.test.mjs \
  tests/mcp.test.mjs tests/mcp-write-guard.test.mjs
```

提交前仍须执行 `npm run verify:quick`。如要 push，按[上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)在干净 commit 上执行完整 `npm run verify`。

## 相关文档

- [BrainX × OpenClaw AI 猎头工作流 PRD](prd-2026-09-02-openclaw-ai-recruiting-workflow.md)
- [工具外露白名单](2026-09-02-tool-exposure-whitelist.md)
- [BrainX 下游 MCP 交付](2026-09-02-brainx-mcp-deliverable.md)
- [安全操作手册](SECURITY.md)
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)

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
3. 人才 RDS 独立迁移历史及八张增量表；
4. `brainx_candidate_shortlist` 单顾问 PoC 工具。

OpenClaw 只读取 BrainX 已经处理完成并授权的数据，不直接读取原始简历、不执行 SQL、不临时扫描整个人才库。

## 2. 代码权威

| 内容 | 权威实现 |
|---|---|
| 两个 JSON 契约及隐私校验 | `src/talent-contracts.js` |
| shortlist 授权查询与字段投影 | `src/candidate-shortlist.js` |
| 人才 RDS 迁移执行器 | `src/talent-migrations.js` |
| 首个增量迁移 | `talent-migrations/0001_candidate_data_v1.mjs` |
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
| `candidate_documents` | 文档 hash、解析器版本和处理质量，不存原文 |
| `candidate_fact_versions` | `candidate_fact_v1` 不可变 JSON 版本 |
| `candidate_fact_evidence` | 字段到来源位置的证据锚点 |
| `job_criteria_versions` | 职位条件不可变版本 |
| `match_runs` | 匹配运行及 `PENDING→RUNNING→SUCCEEDED|FAILED|CANCELLED` 状态 |
| `candidate_job_matches` | 每次 run 的候选人排名、双分数和解释 payload |
| `source_sync_cursors` | 外部人才源增量同步水位 |

迁移遵循 additive-first，不修改历史 migration、不删除旧表/旧列、不覆盖 `resume.parsed_content` 和 `match_record`。MySQL DDL 会隐式提交，因此每条 DDL 都必须可幂等重放；全部执行成功后才登记 migration checksum。已经登记的迁移文件禁止改写，应新增下一个文件。

## 6. 授权查询

`brainx_candidate_shortlist` 的读取顺序是：

1. MCP 启动时同时存在 `BRAINX_MCP_CONSULTANT_ID` 与 `BRAINX_MCP_TENANT_ID`，否则工具不出现在清单；
2. 使用现有 SQLite `jobVisibleTo` 判断该顾问能否看此职位；
3. RDS 查询锁定相同租户和外部职位引用；
4. 只选择 `SUCCEEDED` 且有完成时间的 match run；
5. 每名候选人都必须有未撤销、未过期、purpose 相同的 `resume_facts` grant；
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

已完成：

- 两个 strict 数据契约；
- 联系方式内容检测与未知字段拒绝；
- 人才 RDS 迁移执行器和八张增量表；
- 只读授权 SQL、版本固定分页、错误收口；
- 单顾问/单租户 MCP shortlist 工具；
- 契约、迁移、查询、MCP 暴露条件回归测试。

尚未完成：

- 尚未执行真实 RDS migration；
- 尚未把旧 `resume` / `match_record` 回填为 legacy 版本；
- 尚未安装 Docling/MarkItDown 或启动解析 worker；
- 尚未生成真实 `candidate_fact_v1` 和 match run；
- 尚未实现候选人详情、fit 和 gap 工具；
- 尚未实现多人生产 Agent Gateway、撤权后的缓存/索引删除传播。

因此当前完成的是“安全的数据与读取骨架”，不是“真实候选人已经能在飞书展示”。

## 9. 下一步

1. 在测试库执行 migration 并核对表、索引、外键及账号权限；
2. 选取一小批已获授权且脱敏的 PDF/DOCX，隔离运行 Docling 影子解析；
3. 只把通过 `candidate_fact_v1` 的结果写入新版本表；扫描件明确标 `OCR_REQUIRED`；
4. 用现有 `supply-match-v1` 与结构化特征并行生成影子 run，正式排序保持不变；
5. 建有效 `resume_facts` grant 后，用绑定 Mia 的 MCP 做真实只读烟雾测试；
6. 人工检查 Top 3 的证据、未知项和脱敏结果，再把精确工具名加入 OpenClaw allowlist。

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

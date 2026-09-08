# 007 — 找人双入口：OpenMai（按职位）× SuperMai（按判据）

状态：Implemented（2026-09-08）
上游：用户拍板「建立两个入口，可以选择找人」；「SuperMai 找人 = 在猎聘、脉脉上找人，不在 TTC」。

## 1. 背景与根因（已验证）

- `brainx_supermai_scout` 旧实现（2026-09-07）按前端 chunk 接了
  `app.ttcadvisory.com/app/sourcing/api/sourcing/v1`（/sessions + /chat/sql_query，
  渠道 linkedin/bonjour/paper/github）。**这是接错对象**：SuperMai 找人的真实形态
  是在猎聘、脉脉上找人（用户拍板），该 web 检索后端实测 /auth/login 与 /auth/me
  200 正常、/sessions 与 /chat/* 持续 404（五重证据排除探测机因素，见自动化记忆
  2026-09-08）。
- OpenMai 引擎（`gateway.ttcadvisory.com/api/openmai/v1/completions`，SSE + 异步
  轮询）是生产已验证的猎聘/脉脉/BOSS 找人链路（openmai-task.js）。
- 2026-09-08 18:12 最小付费实测：completions **不带 job_id** 的自由 content 请求
  返回 200，会话正常创建、助手正常回复 → 「按判据自由找人」可行。

## 2. 决议：两个可选入口，共用一个引擎

| 入口 | 工具 | 形态 | 引擎 |
|---|---|---|---|
| 入口 1（按职位） | `brainx_openmai_search` | 有已接单职位 → CRM 职位详情 → 找人 | OpenMai completions（带 job_id） |
| 入口 2（按判据） | `brainx_supermai_scout` | 无需职位，直接给找人判据（如「北京 5 年 React 资深前端」） | OpenMai completions（无 job_id，criteria 模式） |

模型按语境选择入口；两个入口均沿用 openmai_results 落库与防重纪律
（内存 running 集合 + DB 主键防并发重入；done 复用；失败 60s 冷却；无凭证快速失败）。

## 3. 契约

### brainx_supermai_scout（变更）

- 参数：`{ criteria: string(5..2000, required) }`。**移除** `sources`
  （linkedin/bonjour/paper/github 枚举属于错误对象的旧契约）与 `limit`
  （人数由提示词约定 6-10，与 job 模式一致）。
- 调用模式：与 brainx_openmai_search 相同的「触发/读取」两段式——
  首次调用触发任务返回 `running`；完成后再次以同参数调用读取
  `result_text` + 结构化 `candidates`（解析 BRAINX_CANDIDATES_V1 机器块）。
- 判据落库键：`project_id = supermai:<sha256(criteria) 前 12 位>`
  （合成 key 匹配不到 project_launches → enqueueOpenmaiDeliveries 的 JOIN
  天然不命中，不会触发项目群投递副作用）。
- 提示词：与 job 模式同一产物格式（BRAINX_CANDIDATES_V1 机器块），渠道
  表述为「猎聘、脉脉」。
- 事件：完成后 emit `{ type: 'supermai_result', consultant_id, project_id, status }`
  （worker-relay 透传，UI 不识别 synthetic project_id 即忽略，无害）。

### 移除

- app/sourcing web API 全部调用代码（callApi/exchangeSourcingToken/
  searchLinkedin/normalizeCandidate/mergeCandidates/getSupermaiCredentials/
  saveSupermaiCredentials/markSupermaiReauth/supermaiAuthStatus/supermaiScoutMatch）。
- `migrations/0037_supermai_credentials.sql` 产生的表保留不删（历史数据，
  无害；代码不再读写）。

### 不变

- `brainx_openmai_search`、openmai-task.js 的 job 主流程、
  tool 名称（生产 openclaw 白名单无需改动）、tool 总数（22）。

## 4. 非目标

- 不实现领英/Bonjour/论文渠道（等 TTC 明确真实承载方式再立项）。
- 不改 openmai_results 表结构；不新增迁移。
- 不在本规格内做生产部署（部署按既有四服务重启链路另行执行）。

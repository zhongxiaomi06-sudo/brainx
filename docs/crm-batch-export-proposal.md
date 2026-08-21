# CRM 批量导出接口需求（替代 job/search 高频轮询）

## 背景

York AI 应用交付中心的 9 个 worker（6 真人凭证 + 3 个 AI 助手身份）在并行调用 `POST /api/crm/v1/job/search`，以 `size=10` 的默认分页 + cursor 回溯方式拉取约 30 天的职位数据。

### 当前影响

| 指标 | 数值 |
|------|------|
| 3 小时请求数 | 3,163 次 |
| 占 CRM 该接口全部流量 | 36.7% |
| 占 CRM 公网组总流量 | 14.8% |
| 每次请求触发小麦跨云调用 | 最多 10 次 |
| 3 小时跨云 TLS 握手估算 | ~30,000 次 |
| worker 间数据去重 | 无（完全重复扫描） |

### 根因

`job/search` 是面向交互场景设计的（小页、cursor、实时查小麦），不适合批量数据同步。但目前没有替代接口，York 团队只能用最贵的路径做最简单的事：拉一个月的全量职位。

---

## 需求：新增 `POST /api/crm/v1/job/export`

### 核心设计

1. **不走小麦 N+1 路径** —— 直接从 DB 物化视图 / ES 索引读取，跳过 job/search 的逐条跨云查询
2. **支持大页** —— `size` 允许 200~500，一个月数据 2~5 次请求拉完
3. **支持时间范围增量** —— `updated_after` / `updated_before` 过滤，避免全量回扫
4. **返回 total_count** —— 调用方可判断是否已拉完，无需盲目翻页

### 请求格式

```json
POST /api/crm/v1/job/export
Authorization: Bearer <jwt>

{
  "updated_after": "2026-07-23T00:00:00Z",
  "updated_before": "2026-08-21T00:00:00Z",
  "size": 500,
  "cursor": "",
  "fields": ["unique_id", "name", "company_name", "company_unique_id",
             "cities", "head_count", "status", "status_tags", "update_time",
             "pipeline_info", "managers", "group_chat", "participants",
             "cooperation", "need_blur", "company_name_for_c"]
}
```

### 响应格式

```json
{
  "total_count": 847,
  "has_more": true,
  "cursor": "eyJ...",
  "jobs": [
    {
      "unique_id": "...",
      "name": "...",
      "company_name": "...",
      "update_time": "1721692800000",
      "..."
    }
  ]
}
```

### 权限模型

与 `job/search` 相同：JWT 持有者的权限视图。`has_permission=false` 的职位不返回。

### 字段裁剪（可选）

`fields` 参数允许调用方只取需要的字段，减少响应体大小。缺省返回全量字段（与 job/search 一致）。

---

## 对比收益

| | 当前 (job/search) | 改后 (job/export) |
|---|---|---|
| 拉 1000 条所需请求 | 100 次 | 2 次 |
| 跨云小麦调用 | ~1000 次 | 0 次 |
| 9 worker 并行场景 | 9x100 = 900 次 | 9x2 = 18 次（或加 response cache 后 = 2 次） |
| 3 小时总请求（York） | 3,163 | ~36（每 5 分钟一次增量） |

---

## 过渡期建议

在 export 接口上线前，建议网关层对 `job/search` 加两条规则：

1. **Rate limit**: 每用户 60 次/分钟（当前 Felix 峰值 ~3 次/秒，远超合理交互频率）
2. **Response cache**: 相同 `(user_id, request_body_hash)` 的响应缓存 5 分钟（9 worker 同参数请求实际只穿透 1 次）

---

## 临时替代方案（已实现）

BrainX 已新增 `GET /api/v1/jobs/snapshot` 接口，返回 bridge 每 3 分钟同步并去重后的全量职位快照。York 团队可改为读此接口，零跨云开销。

**接入方式：**

```bash
curl -H "Authorization: Bearer $BRAINX_SNAPSHOT_API_KEY" \
  "https://<brainx-host>/api/v1/jobs/snapshot?updated_after=2026-07-23T00:00:00Z"
```

**响应字段：** `project_id, company, role, city, pipeline, hc, active_state, priority, company_type, source_url, captured_at, owner_name`，外加 `total_count`（匹配过滤条件的全量条数——`limit` 只截返回不截计数，调用方据此判断是否拉完）。

**字段映射（York 需要的 CRM 字段 → 快照字段）：**

| CRM 字段 | 快照字段 | 说明 |
|---|---|---|
| `unique_id` | `project_id` | 同一值（ATS project_id） |
| `name` | `role` | |
| `company_name` | `company` | `need_blur=1` 时已用 `company_name_for_c` 脱敏 |
| `cities` | `city` | 顿号拼接 |
| `head_count` | `hc` | |
| `status` | `active_state` | 1→OPEN / 0→COOLING / 其余→UNKNOWN |
| `update_time` | `captured_at` | 事实最后变化时间（ISO，见 sync.js upsert 语义） |
| `pipeline_info` | `pipeline` | 摘要如 "Sourcing×1 二面×2" |
| `managers` | `owner_name` | 仅首个 manager 姓名 |
| `status_tags` / `participants` / `cooperation` | —（暂不含） | York 若需要可再加列 |

**刷新频率：** 每 3 分钟（bridge interval），数据已合并去重（多人 JWT union Map 按 unique_id 去重）。

**验证状态：** 已实现并通过 6 个接口测试（tests/snapshot.test.mjs：无 key 401 / 错 key 401 / 无 session 仅 API Key 200 / 时间过滤 / limit 与 total_count / status 过滤），全量测试套件 235 通过。GET /api/v1/jobs/snapshot 已加入免登录路由（API Key 在 handler 内自校验，未配置 BRAINX_SNAPSHOT_API_KEY 时 fail-closed 全拒）。

---

## 行动项

| 序号 | 负责方 | 事项 | 优先级 |
|------|--------|------|--------|
| 1 | 基础设施 | 网关层对 job/search 加 rate limit + response cache | P0（止血） |
| 2 | CRM 团队 | 评估 job/export 接口排期 | P1（治本） |
| 3 | York 团队 | 短期切换到 BrainX snapshot 接口 | P0（配合止血） |
| 4 | York 团队 | export 上线后迁移调用方 | P2 |

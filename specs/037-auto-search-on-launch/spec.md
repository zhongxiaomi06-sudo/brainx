# Spec 037：建群后按 JD 自动第一轮找人 + 持续招人

> 日期：2026-10-15 20:30 CST
> 触发：咪指令「建群之后按照 JD 就开始第一轮的找人 不要用户说开始找人 后续能一直长期招人」
> 关联：outputs/2026-10-15-product-defect-audit.md（产品视角缺陷验证 P0 #4 绑群后 56% 从不找人）
> 上一规格：specs/036-sourcing-recall（recall 扩展召回）/ specs/019-hub-event-backbone（事件账本）

## 一、问题陈述

**当前产品门槛**（accept-launch.js#postAcceptSideEffects 第 11 行注释明示）：
> 标记为等待顾问明确选择 OpenMai 或 SuperMai，**不暗中触发付费找人**

**生产数据实证（产品漏斗失血）**：
- project_launches 45 READY，但 search_status NULL 25 个（**56% 绑群后从未找人**）
- 这 25 个项目群绑了职位+建了群+就绪，但卡在「等待用户主动触发找人」这一步
- 咪的 sm_22d9ca0b 验证也实证：必须手动 lark-cli post @ 才能触发，普通用户做不到

**核心改造目标**：
1. **建群+READY 后立即按 JD 自动触发第一轮找人**（不再等用户主动）
2. **去掉「用户说开始找人」门槛**（passive trigger，不依赖用户主动行为）
3. **后续持续招人**（建立多轮机制，不是一次性）

## 二、用户旅程对比

### 当前路径（高流失）

```
[接单 ACCEPTED]
    ↓ (launchProject 建群)
[project_launches READY]
    ↓ (search_status = awaiting_method —— 等用户)
[用户在群里点找人按钮 / @bot 找人]   ← 56% 用户卡死在这步
    ↓
[startSupermaiScoutTask search_round=1]
    ↓
[候选人卡回群]
```

### 新路径（自动触发 + 持续）

```
[接单 ACCEPTED]
    ↓ (launchProject 建群)
[project_launches READY]
    ↓ (新增 autoSearchOnLaunch —— 自动触发)
[校验 TTC JWT 有效 → buildAutoSearchCriteria(job)]
    ↓
[startSupermaiScoutTask search_round=1, criteria=auto-generated]
    ↓
[即时反馈卡「正在按 JD 找人，通常 3-5 分钟」]
    ↓ (165s)
[候选人卡回群 + 持续招人开关已开]
    ↓ (B1 用户主动「继续找人」按钮 / B2 定时 7 天一轮)
[search_round=2...N，排除上轮 PL 编号]
    ↓
[持续候选人流，直到 HC 满足 / 用户关闭 auto_search_enabled]
```

## 三、设计原则

1. **被动触发，不增加用户主动负担**：READY 后立即自动触发，不等用户说「开始找人」
2. **凭证前置 fail-fast**：TTC JWT 失效不阻塞接单返回，但跳过自动触发 + 群里发提示卡
3. **重复付费防护**：search_round 自增 + excluded_candidate_refs_json 复用 + 幂等键兜底
4. **多级 kill switch**：env 全局开关 + project_launches.auto_search_enabled 项目级开关 + 凭证级校验
5. **JD 文本来源 fallback**：job_facts 结构化字段（必选）+ lark_messages.text JD 原文（可选增强）
6. **agent 不轮询**：自动触发后群里发即时卡 + agent 不在原地等待，turn 正常结束

## 四、详细规格

### 4.1 自动触发第一轮（A 阶段 P0）

**触发点**：`accept-launch.js#postAcceptSideEffects` 在 `launchProject` 成功返回后追加自动找人副作用

**新增函数** `autoSearchOnLaunch(db, bus, deps, consultantId, projectId, projectLaunch)`：

```js
export async function autoSearchOnLaunch(db, bus, deps, consultantId, projectId, projectLaunch) {
  // 1. 全局开关
  if (process.env.BRAINX_AUTO_SEARCH_ENABLED === '0') {
    return { status: 'disabled_global', reason: 'BRAINX_AUTO_SEARCH_ENABLED=0' };
  }

  // 2. 项目级开关（首次 READY 默认 true）
  const enabled = db.prepare('SELECT auto_search_enabled FROM project_launches WHERE launch_id=?')
    .get(projectLaunch.launch_id)?.auto_search_enabled;
  if (enabled === 0) {
    return { status: 'disabled_project', reason: 'auto_search_enabled=0' };
  }

  // 3. 凭证校验 fail-fast
  const jwt = getAuthorizedTtcJwt(db, consultantId, 'OPENMAI');
  if (!jwt) {
    // 凭证失效不阻塞接单返回（咪拍板）：agent 私聊主动提醒 + 直接给工作台 URL（§4.4.1）
    await notifyCredentialExpired(db, consultantId, [projectId]);
    return { status: 'no_jwt', reason: 'TTC 凭证失效，已私聊提醒顾问更新凭证' };
  }

  // 4. 判据生成
  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(projectId);
  const criteria = buildAutoSearchCriteria(job);
  if (!criteria) {
    return { status: 'no_criteria', reason: 'job_facts 缺字段无法生成判据' };
  }

  // 5. 幂等触发（防多服务并发重复触发）
  const idemKey = `auto:round1:${projectId}:${consultantId}`;
  const existing = db.prepare('SELECT task_id, status FROM openmai_results WHERE project_id=? AND consultant_id=? AND search_round=1')
    .get(projectId, consultantId);
  if (existing?.status === 'done') {
    return { status: 'already_done', task_id: existing.task_id };
  }

  // 6. 触发 SuperMai 找人（fire-and-forget OK：常驻 brainx 服务进程内 IIFE 不死）
  const out = startSupermaiScoutTask(db, bus, consultantId, criteria, {
    projectId, autoSearch: true, round: 1,
  });

  // 7. 即时反馈卡（候选结果由 openmai-delivery worker 投递回群）
  if (out.status === 'triggered') {
    await sendInteractiveCard({
      target: projectLaunch.chat_id,
      card: buildSearchStartCard({ consultantId, projectId, task_id: out.task_id, criteria }),
    });
  }

  return out;
}
```

**改 accept-launch.js#postAcceptSideEffects**：

```js
export async function postAcceptSideEffects(db, bus, deps, consultantId, projectId, input, out) {
  if (!(out.ok && out.state === 'ACCEPTED' && input?.action === 'ACCEPT')) return out;

  // 项目群建群（幂等）
  try {
    out.project_launch = await launchProject(db, consultantId, projectId,
      { idempotency_key: `web-accept-launch:${consultantId}:${projectId}` },
      { ...(deps.projectLaunch || {}) });
  } catch (e) {
    out.project_launch = { ok: false, code: e.code || 'PROJECT_LAUNCH_FAILED',
      message: String(e.message).slice(0, 200) };
    return out;  // 建群失败直接返回，不触发自动找人
  }

  // 建群成功 → 自动触发第一轮找人（specs/037）
  if (out.project_launch?.ok !== false && out.project_launch?.chat_id) {
    try {
      out.auto_search = await autoSearchOnLaunch(db, bus, deps, consultantId, projectId, out.project_launch);
    } catch (e) {
      out.auto_search = { ok: false, code: e.code || 'AUTO_SEARCH_FAILED',
        message: String(e.message).slice(0, 200) };
      // 自动触发失败不阻塞接单返回，错误随 out 透出
    }
  }

  return out;
}
```

### 4.2 判据生成（buildAutoSearchCriteria）

**输入**：job_facts 行（company/role/city/pipeline/hc/notes/raw_json）+ 可选 JD 原文

**输出**：自然语言判据字符串，形如「{role} · {city} · {hc}人 · {company}背景，主要做{pipeline 阶段}」

**实现**：

```js
export function buildAutoSearchCriteria(job, jdText = null) {
  if (!job || (!job.role && !job.company)) return null;

  const parts = [];
  if (job.role) parts.push(job.role);
  if (job.city) parts.push(job.city);
  if (job.hc) parts.push(`${job.hc}人`);
  if (job.company) parts.push(`${job.company}背景`);
  if (job.pipeline) parts.push(`主要做${job.pipeline}`);

  // JD 原文 fallback：从 lark_messages.text 取最近一条 JD（specs/005 草稿流程）
  if (jdText) {
    // 截取关键技能段（最多 200 字）
    const skills = jdText.substring(0, 200).replace(/\s+/g, ' ');
    parts.push(`技能要求：${skills}`);
  }

  // 默认 3-5 年经验范围（咪 2026-10-15 拍板：固定不按职位层级调整）
  parts.push('3-5 年工作经验');

  return parts.join('，');
}
```

**判据质量评估**：
- 完整判据（role+city+hc+company+pipeline+skills+years）：引擎返回高质量候选人
- 最小判据（仅 role+city）：引擎返回通用候选人，质量偏低但不报错
- 无判据（job_facts 缺字段）：返回 null，autoSearchOnLaunch 跳过 + 写入 project_launches.error_code='AUTO_CRITERIA_INSUFFICIENT'

### 4.3 持续招人机制（B 阶段 P1）

#### B1. 用户主动「继续找人」（已有，无需改）

- 候选人卡片末尾「继续找人」按钮（已有，prompt.js 已说明）
- 触发 `brainx_supermai_scout` 或 `brainx_openmai_search` 传 `continue_search=true`
- search_round = max(round) + 1，excluded_candidate_refs_json 自动带出历史所有 PL 编号

#### B2. 自动定时触发（新增 worker 任务）

**新增 src/auto-search-worker.js**：

```js
/** auto-search-worker.js — 定时自动找人轮转（specs/037 B2）。
 * 每 7 天对每个项目群检查：上次 finished_at > 7 天前 + auto_search_enabled=1
 * + active_state=OPEN + 凭证有效 → 自动触发新一轮 search_round+1 */
const AUTO_SEARCH_INTERVAL_MS = 24 * 60 * 60 * 1000; // worker 每天跑一次扫描
const ROUND_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;    // 项目每 7 天一轮

export function startAutoSearchWorker(db, dependencies = {}) {
  const timer = setInterval(async () => {
    if (process.env.BRAINX_AUTO_SEARCH_ENABLED === '0') return;

    // 查所有可触发项目：READY + auto_search_enabled + active_state=OPEN + 上轮 finished > 7 天前
    const candidates = db.prepare(`
      SELECT pl.launch_id, pl.project_id, pl.chat_id, pl.search_status,
             pl.search_task_id, pl.updated_at, jf.company, jf.role, jf.city,
             jf.hc, jf.active_state, c.consultant_id
      FROM project_launches pl
      JOIN job_facts jf ON jf.project_id=pl.project_id
      JOIN consultants c ON c.active=1
      WHERE pl.status='READY' AND pl.auto_search_enabled=1
        AND jf.active_state='OPEN'
        AND (pl.search_status IS NULL
             OR (pl.search_status IN ('DONE','FAILED')
                 AND pl.updated_at < datetime('now', '-7 days')))
    `).all();

    for (const row of candidates) {
      try {
        await triggerAutoSearchRound(db, dependencies.bus, row);
      } catch (e) {
        console.error(`[auto-search-worker] ${row.project_id}: ${e.message}`);
      }
    }
  }, dependencies.intervalMs || AUTO_SEARCH_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

async function triggerAutoSearchRound(db, bus, row) {
  // 凭证校验
  const jwt = getAuthorizedTtcJwt(db, row.consultant_id, 'OPENMAI');
  if (!jwt) {
    // 凭证失效：群里发提示卡，不触发
    await sendInteractiveCard({ target: row.chat_id, card: buildCredentialExpiredCard(row) });
    return;
  }

  // 当前最大 round + 1
  const maxRound = db.prepare('SELECT MAX(search_round) max FROM openmai_results WHERE project_id=? AND consultant_id=?')
    .get(row.project_id, row.consultant_id)?.max || 0;
  const newRound = maxRound + 1;

  // 排除名单：所有历史 PL 编号
  const exclusions = db.prepare(`
    SELECT DISTINCT json_extract(value, '$.candidate_ref') AS ref
    FROM openmai_results, json_each(excluded_candidate_refs_json)
    WHERE project_id=? AND consultant_id=?`)
    .all(row.project_id, row.consultant_id).map(r => r.ref).filter(Boolean);

  // 触发新一轮
  const job = { company: row.company, role: row.role, city: row.city, hc: row.hc, pipeline: null };
  const criteria = buildAutoSearchCriteria(job);
  startSupermaiScoutTask(db, bus, row.consultant_id, criteria, {
    projectId: row.project_id, excludeCandidateRefs: exclusions, round: newRound,
  });

  // 即时反馈卡
  await sendInteractiveCard({
    target: row.chat_id,
    card: buildSearchStartCard({ consultantId: row.consultant_id, projectId: row.project_id, round: newRound, criteria }),
  });
}
```

### 4.4 多级 kill switch

| 级别 | 字段 | 默认 | 关闭后效果 |
|------|------|------|-----------|
| 全局 | `BRAINX_AUTO_SEARCH_ENABLED=0` | 1（开） | worker 跳过所有自动触发；accept-launch 也跳过 |
| 项目 | `project_launches.auto_search_enabled` | 1（开） | 该项目不触发自动找人 |
| 凭证 | `ttc_tokens.needs_reauth=1` | 0 | 该顾问不触发，**agent 私聊主动提醒 + 直接给工作台 URL**（见 §4.4.1） |
| 状态 | `job_facts.active_state!='OPEN'` | OPEN | 职位关闭后不触发 |

**咪 2026-10-15 20:33 拍板（三个细节）**：
1. **判据默认年限固定 3-5 年**——不按职位层级自动调整（简化设计，保持可预测性）
2. **凭证失效必须 agent 私聊主动提醒 + 直接给连接**——不只是群里发卡（详见 §4.4.1）
3. **不设单项目每月上限**——暂时只靠 kill switch 软控，待后续观察成本趋势再决定

#### 4.4.1 凭证失效 agent 私聊主动提醒（咪拍板）

**触发条件**：autoSearchOnLaunch 或 auto-search-worker 检测到 `ttc_tokens.needs_reauth=1` 或 `expires_at < now` 时跳过自动触发，同时**主动给顾问发私聊消息**（非项目群，避免污染群消息）。

**消息内容（含连接）**：

```
你的 TTC 凭证已失效，无法自动触发项目找人。

请打开 BrainTex 工作台更新凭证：
{productionBaseUrl}

路径：登录工作台 → 设置中心 → 「TTC 职位系统」→ 点「更新凭证」按钮粘贴新的 TTC JWT。

凭证更新后，下次自动找人会自动恢复（无需手动触发）。
当前受影响项目：{project_id 列表}
```

**实现**：新增 `notifyCredentialExpired(db, consultantId, affectedProjects)` 函数：
- 通过飞书 IM 直接发私聊消息到顾问的 `consultants.open_id`（已有字段）
- 用 `sendInteractiveCard` 发卡片，卡片含「打开工作台」按钮（multi_url = productionBaseUrl，PC/移动端通用）
- 幂等键 `notify:cred-expired:<consultant_id>:<YYYY-MM-DD>`（同一天不重复提醒，避免 spam）
- 卡片设计：blue header「BrainTex 凭证提醒」+ 文字引导路径 + 「打开工作台」按钮

**deep link 扩展（P2 优化，非 P0 必须）**：
- 当前 `buildBrainxDeepLink` 只支持 `opportunity`/`replay` 两种 objectType（brainx-deep-links.js 第 1 行 OBJECT_TYPES 集合）
- 建议后续扩展支持 `settings:ttc-credential` 类型，让 agent 给的 URL 直接打开设置中心的 TTC 凭证区域
- P0 阶段用 base URL + 文字引导路径即可，咪的「直接给连接」要求已满足

**与现有路径对比**：
- 当前 `supermai-sourcing.js` 第 86 行只把错误写入 `openmai_results.error`，agent 不主动提醒
- 当前 `candidate-private-contact.js` 第 39 行只返回错误信封给调用方，不主动推送
- 当前 `openmai-task.js` 第 99/163 行 401/403 时只抛错让上层 catch，不主动通知顾问
- **新（咪拍板）**：agent 私聊主动提醒 + 直接给工作台 URL——把「等用户发现凭证失效」改成「主动告知 + 给连接」

#### 4.4.2 不设单项目每月上限（咪拍板）

**决策**：暂时不设硬上限（如单项目每月最多 N 轮），只靠多级 kill switch 软控。

**理由**：
- 当前生产数据：122 找人 / 104 done / 18 failed / 1 abandoned，平均每项目 2-3 轮，远未到失控
- 自动触发后单项目每 7 天一轮 = 每月最多 4-5 轮，可控
- 设硬上限可能误伤高 HC 项目（hc=10 一个月 4 轮可能不够）
- 待 P1 上线后观察 1-2 个月成本趋势，再决定是否需要硬上限

**兜底机制**：
- 全局 kill switch `BRAINX_AUTO_SEARCH_ENABLED=0` 可瞬间关闭整个系统
- 项目级 `auto_search_enabled=0` 可关闭特定项目
- 凭证失效自动跳过
- worker 异常时可手动 stop worker timer

### 4.5 数据库迁移

**migration 0062：project_launches 加 auto_search_enabled 字段**

```sql
ALTER TABLE project_launches ADD COLUMN auto_search_enabled INTEGER DEFAULT 1;
-- 存量项目默认开启（咪的指令「后续能一直长期招人」）
```

**migration 0063（可选）：openmai_results 加 auto_triggered 字段**

```sql
ALTER TABLE openmai_results ADD COLUMN auto_triggered INTEGER DEFAULT 0;
-- 标记是否自动触发（vs 用户主动触发 vs 按钮触发）
-- 用于审计：统计自动触发占比 + 成本归因
```

### 4.6 事件审计

**新增事件类型 `sourcing.auto_triggered`**（specs/019 hub event backbone 扩展）：

```js
emitEvent(db, {
  event_type: 'sourcing.auto_triggered',
  idem_key: `auto.triggered:${projectId}:${consultantId}:r${round}`,
  actor: 'system:auto-search-worker',  // 或 'system:accept-launch' 第一轮
  payload: { project_id: projectId, consultant_id: consultantId, round, criteria_hash, reason: 'on_launch' | 'scheduled' },
  evidence_refs: [{ table: 'openmai_results', id: `${projectId}|${consultantId}` }],
});
```

用于审计：
- 自动触发 vs 用户主动触发占比
- 成本归因：自动触发产生的 TTC 引擎调用费用
- 死群检测：自动触发后群里无任何用户响应的群

## 五、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| TTC 引擎成本失控（每项目每 7 天一轮） | 中 | 高（token 费用爆炸） | ①BRAINX_AUTO_SEARCH_ENABLED 全局开关 ②project_launches.auto_search_enabled 项目级 ③凭证失效跳过（**咪拍板：暂不设单项目每月上限**，待 P1 上线后观察 1-2 月成本趋势再决定） |
| 凭证滚动频繁（60 天）导致自动触发总失败 | 高 | 中 | **①凭证失效自动跳过 + agent 私聊主动提醒 + 直接给工作台 URL（咪拍板 §4.4.1）** ②worker 每天扫描时检测凭证状态 ③咪每月让到期顾问重贴 |
| JD 文本不完整（job_facts 只有 role+city，无 skills） | 中 | 中 | ①buildAutoSearchCriteria fallback 用 lark_messages.text 取 JD 原文 ②判据质量差的群在 candidate-decision-groups 转化率会低，可监测后改判据 |
| 多服务并发触发（brainx + worker 都跑 accept-launch） | 低 | 中 | ①幂等键 `auto:round1:<project_id>:<consultant_id>` 兜底 ②idx_wel_idem 唯一索引去重 |
| 死群自动触发浪费（项目长期不活跃） | 中 | 低 | ①active_state!=OPEN 跳过 ②chat_msgs_7d=0 跳过 ③auto_search_enabled 可手动关 |
| fire-and-forget + 短命进程坑（如果 accept-launch 在 web server 进程跑） | 低 | 高 | ①accept-launch 在 brainx.service 主进程跑（常驻），IIFE 不死 ②worker 跑自动触发也在 brainx-worker 常驻进程 ③都不在短命进程跑 |

## 六、实施计划

### P0（本周完成，让漏斗不再失血）

1. **改 accept-launch.js#postAcceptSideEffects**：建群成功后调 autoSearchOnLaunch
2. **新增 src/auto-search.js#autoSearchOnLaunch + buildAutoSearchCriteria**（判据固定 3-5 年，咪拍板）
3. **新增 buildSearchStartCard + notifyCredentialExpired**（即时反馈卡 + 凭证失效 agent 私聊主动提醒 + 直接给工作台 URL，咪拍板 §4.4.1）
4. **migration 0062**：project_launches 加 auto_search_enabled 字段
5. **测试**：accept-launch.test.mjs 加「建群后自动触发找人」+「凭证失效主动提醒」回归用例
6. **部署**：scp 改的 src 文件 + 跑 migration 0062 + 重启 brainx 服务
7. **验证**：在测试项目群接单，观察是否自动触发第一轮 + 卡片投递回群；让凭证失效观察是否私聊提醒

### P1（下周完成，持续招人机制）

8. **新增 src/auto-search-worker.js**：定时 7 天一轮
9. **改 brainx-worker.service EnvironmentFile**：加 BRAINX_AUTO_SEARCH_ENABLED=1
10. **migration 0063**：openmai_results 加 auto_triggered 字段（审计标记）
11. **新增事件类型 sourcing.auto_triggered**：workflow_event_log 落表
12. **测试**：auto-search-worker.test.mjs 加「7 天到期触发新一轮」回归用例
13. **部署**：scp + worker.env + 重启 brainx-worker

### P2（后续，闭环）

14. **候选人状态跟踪**：candidate_outcomes 表 + Offer/拒绝/入职工具
15. **状态触发新一轮**：候选人 < 阈值自动触发（替代纯定时）

## 七、与现有规格的关系

| 现有规格 | 关系 |
|---------|------|
| specs/019-hub-event-backbone | 复用 emitEvent + idx_wel_idem 幂等；新增 sourcing.auto_triggered 事件 |
| specs/005-private-jd-job-draft | buildAutoSearchCriteria fallback 从 lark_messages.text 取 JD 原文 |
| specs/015-group-intake | 群绑定完成后 project_launches READY，可挂 auto_search_enabled |
| specs/036-sourcing-recall | 自动触发后引擎可能扩展召回（严格判据无解时） |
| outputs/2026-10-15-product-defect-audit.md | 直接修复缺陷 #4 绑群后 56% 从不找人 |

## 八、待咪拍板

1. ~~**判据默认年限**：方案默认「3-5 年」——是否要根据职位层级自动调整？~~ **咪 2026-10-15 20:33 拍板：不能**，固定 3-5 年简化设计。
2. **自动触发间隔**：方案默认 7 天一轮——是否要根据 HC 大小调整（hc=5 一周一轮、hc=1 三天一轮）？（咪未拍板，保持默认 7 天）
3. **死群判定**：方案用 chat_msgs_7d=0 跳过——是否需要更严格（如 chat_msgs_30d < 阈值）？（咪未拍板，保持默认）
4. ~~**凭证失效兜底**：是否要 agent 在私聊主动提醒顾问「TTC 凭证快到期」？~~ **咪 2026-10-15 20:33 拍板：要提醒，并且把连接直接给出**（详见 §4.4.1）。
5. ~~**成本上限**：是否需要单项目每月最多 N 轮硬上限？~~ **咪 2026-10-15 20:33 拍板：暂时不给上限**，只靠 kill switch 软控，待观察成本趋势再决定（详见 §4.4.2）。

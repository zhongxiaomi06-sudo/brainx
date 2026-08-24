# Brain X · 职位决策工作台 PRD（v2.0）

## 1. 产品定位

**一句话**：猎头团队的「今天该做哪个职位」决策系统——多源职位数据自动同步，确定性评分给每位顾问出每日 Top 推荐，顾问在工作台/飞书卡片上承接、关注、关闭，全流程事件溯源可回放。

**解决什么问题**：
- 团队 ~900 个在招职位，顾问靠群里刷消息和个人记忆选单，优质职位被埋没、撞单、接单后没人跟进结果；
- 管理者看不到「谁在做什么单、卡在哪一步」；
- 推荐策略没有数据闭环，好坏无法度量、无法迭代。

**不做什么**（边界）：
- 不做候选人侧 ATS（人才库仅只读旁路，刻意不进评分）；
- 不做 LLM 自由生成推荐理由（评分确定性、可复现，LLM 仅用于脏数据分类与对话流）；
- 不替代 TTC CRM——TTC 是职位权威源，BrainX 是决策层。

---

## 2. 用户与角色

| 角色 | 人数 | 核心诉求 |
|---|---|---|
| 顾问（felix/mia/york/wendy/linda/shanon/otto） | 7 | 每天看到「我最该做的 Top 职位」，一键接单/关注/不感兴趣，接单后自动找人 |
| 管理者（Felix 兼） | 1 | 团队承接全景、待办积压、数据健康 |
| 算法负责人（mia 初版 → hanyu 优化） | 2 | 反馈标签采集、权重迭代、POLICY_VERSION 晋升 |
| 工程/架构（曾老师） | 1 | 云端运维、数据质量门仲裁 |
| 外部消费方（York AI 交付中心 9 worker） | — | 只读职位快照，替代对 CRM 的高频轮询 |

---

## 3. 数据架构

### 3.1 三源数据输入

| 源 | 角色 | 通道 | 现状 |
|---|---|---|---|
| **TTC CRM API** | 职位权威源（真 project_id / HC / Pipeline） | `ttcsdk/`，按人托管 JWT，bridge 每 180s 拉取 | ✅ 已通（902 岗入库，98 机密岗跳过） |
| 飞书 Bitable/业务群 | 团队池 + 群活跃度 | 按人飞书令牌（AES-256-GCM 存储 + refresh 轮换） | ✅ 已通 |
| CSV（公司岗位情况 + Felix 项目池） | 市场源 + 驾驶舱源 | LLM 适配器（OpenAI 兼容协议，无 Key 走关键词回退） | ✅ 已通 |

### 3.2 存储（两套库并存，互不干扰）

**A. SQLite 决策库**（`data/brainx.db`，WAL，零依赖 `node:sqlite`）——核心表：

| 表 | 职责 |
|---|---|
| `sync_runs` | 同步批次；**complete=0 的快照不得用于推荐**（硬闸门） |
| `job_facts` | 职位事实，project_id 唯一，UPSERT；`captured_at` 只在事实真变时前进 |
| `job_memberships` | 顾问×职位关系（当前关系 = valid_to IS NULL） |
| `cockpit_facts` / `job_classifications` / `job_occupancy` | 1.2 三表：驾驶舱事实 / LLM 方向分类 / HC 占用状态机 |
| `decision_runs` + `recommendations` | 每轮推荐**冻结**（回放只读冻结行，永不重算、永不改写） |
| `decision_events` | 事件账本，只追加，idempotency_key 去重；`current_engagement` 由账本推导（无状态表） |
| `job_outcomes` | 职位级结果（面试/Offer/入职/人工标注） |
| `push_log` | 推送幂等（consultant+kind+run_id 唯一） |
| `recommendation_feedback` | 不感兴趣反馈（触发排序降权） |
| `openmai_results` | 接单找人结果 |
| `manual_fact_overrides` | 人工事实覆盖层（6 字段人工值优先于同步值） |

**B. 阿里云 RDS MySQL 人才库**（`brainx_talent`，7 表）：候选人 upsert/匹配/简历/CSV 同步；**只读旁路，不进评分**。

---

## 4. 核心功能（已实现，真机验证通过）

### 4.1 推荐引擎（baseline-1.0）
- **六维确定性评分**：`FinalScore = ProcessScore×60% + ExplorationScore×25% + PersonalScore×15%`，同批输入同排序，禁随机数；UNKNOWN 关系硬阻断；FILLED/CLOSED/EXCLUDE 出榜。
- **快照闸门**：同步不完整 → 推荐 blocked 不落库，前端出「数据不完整」提示。
- **推荐分页**：精选盘 pick tray + 下一批 + 不感兴趣反馈（含撤销/补充原因）。
- **冻结回放**：任何一轮推荐可完整回放（decision_id），同一快照 + 同一 policy_version → 同一 Top20。
- 规模实证：984 职位 / 680 轮 / 612,595 条冻结推荐 / 7 顾问。

### 4.2 承接状态机
`VIEW → WATCH → ACCEPT → COMPLETE / DISMISS / RELEASE`，事件账本推导当前状态；幂等键 + 冷却期 + 关注上限；DISMISS 须填原因码（7 枚举）。

### 4.3 TTC 闭环：接单自动找人
`ACCEPT → startOpenmaiTask`（异步：TTC JWT → CRM 职位详情 → OpenMai SSE → 落库 → SSE 回传前端）。P-FIX 占位自动解析真身（P-FIX→J 真 project_id）。

### 4.4 飞书推送
- **定时推送**：每日 07:00 / 19:00 CST，每人 Top3 卡片，私聊（绝不推群），push_log 幂等（窗口重入不重复发）。
- **重大变化推送**：Top1 易主 / ACCEPT 档新进 Top3（autopush，默认关）。
- **卡片 = 快照摘要，UI = 实时渲染**：卡片按钮一律 URL 深链，操作发生在工作台。
- **一键反馈（F2，新增未部署）**：卡片按钮带 HMAC 签名直写「👀关注 / ✕不感兴趣」，无需登录工作台；当日/次日双窗口校验，未配密钥 fail-closed。

### 4.5 工作台前端（btex-frontend，唯一前端）
React 19 + Vinext；`brainx-api.ts` 适配层（connected 模式调真实 `/api/v1`，401 回退演示）；SSE 定向投递实时刷新；showcase 演示面显式标记。

### 4.6 MCP 服务器（11+ 工具）
与 HTTP 同一套领域函数与可见性（fail-closed）；consultant_id 必填 + roster 校验；raw_json 不出网。供 AI 助手直接操作决策系统。

### 4.7 职位快照接口（York 止血）
`GET /api/v1/jobs/snapshot`：bridge 去重后的全量职位快照，API Key 鉴权，支持 `updated_after` 增量 + `total_count`。替代 York 9 worker 对 CRM `job/search` 的高频轮询（3h 3,163 次 → ~36 次）。

### 4.8 运维装置
- **Guard**：请求带宽/调用量预测告警（`BRAINX_GUARD_WEBHOOK`）。
- **每日健康简报**：09:00 只读自动生成（数据增量/同步状态/待办/服务存活/日志异常）。
- **诊断脚本**：`npm run diagnose`（天花板效应/维度缺失/相关性检测，只读）。

---

## 5. 反馈闭环与算法迭代纪律（当前迭代主线，F1–F4）

**问题**：recommendations 61 万行，但反馈标签几乎为零（similarity 维缺失 96.7%、outcomes 维缺失 97.2%、coverage 均值仅 0.53），算法无标签可学。

**F1–F4 修复包**（本地已交付，253 测试全绿，未部署）：
- F1：owner 回种 memberships → similarity 维断供修复
- F2：推送卡片一键反馈（签名直写，见 4.4）
- F3：MCP `brainx_feedback` 工具（AI 会话内直接表态）
- F4：outcome 导入 CLI（`brainx-outcome-import`）

**标签体系**（training-requirements v1）：
ACCEPTED(+2) / WATCHED·VIEWED(+1) / 7 天静默(-1) / DISMISSED·NOT_INTERESTED(-2) / 人工标注(+2/+1/-2/0) / rating 1-5（终局质量乘数）。冲突裁决：人工标注 > 行为事件 > 反馈 ×。

**量级门槛**：~150 标签 → 网格搜索粗调；≥300 正样本 → logistic 回归；未达门槛**不得晋升 POLICY_VERSION**。

**首批打标**（labeling-standard-v1）：7 顾问 × Top20 = 140 对，独立标注、10% 交叉重复题（一致率 <70% 整批重标）、3 个工作日回收、标注只写 `job_outcomes` stage='人工标注'（**绝不进 recommendation_feedback**）。

**晋升纪律**：新权重 dry_run 影子对比 → replay 历史指标全胜 → POLICY_VERSION bump → 旧版本冻结永不改写。

---

## 6. 部署形态

| 环境 | 形态 | 入口 | 状态 |
|---|---|---|---|
| 云端生产 | docker 容器 `brainx`（47.110.93.137，3101/4322，bind /opt/brainx/data） | https://base.yorkteam.cn | ⚠️ 运行中但镜像落后（见 §8 P0）；**推送唯一出口** |
| 本地（Ashley Mac） | launchd 常驻 3100，**纯开发定位**（bridge/scheduler 已关停，2026-08-24 决议） | http://127.0.0.1:3100 | ✅ 存活 |
| 本地开发 | `node src/server.js`（自动拉起 vinext 并反代） | http://127.0.0.1:3000 | ✅ |
| 规划中 | 独立 ECS 迁移（与 reloop 共享机分离） | 待定 | ⏸ 用户暂停 |

---

## 7. 非功能性要求

1. **可复现**：评分确定性；推荐冻结；同一快照+policy → 同一结果。
2. **幂等**：所有写操作带 idempotency_key；推送/同步/反馈/导入重入安全。
3. **fail-closed**：鉴权、可见性、签名、快照 Key——配置缺失一律拒绝，绝不默认放行。
4. **数据不出网**：raw_json、open_id 不出 API/MCP；飞书令牌 AES-256-GCM；session HMAC 密钥 0600。
5. **零依赖后端**：`node:sqlite` + `node:http`，唯一 npm 依赖 mysql2（可选）。
6. **可观测**：健康简报 / guard 告警 / SSE / push_log / sync_runs 全链路留痕。

---

## 8. 已知问题与技术债（按优先级）

### P0 — 阻断业务
| # | 问题 | 根因 | 处置 |
|---|---|---|---|
| 1 | **定时推送 100% 失败**（8/20 起，本地 36 条 FAILED；云端容器内 `spawnSync lark-cli ENOENT`） | 云端：容器未挂 lark-cli；本地：飞书侧报错被截断 | 容器补三挂载（长效：lark-cli 进 Dockerfile）；本地修 push.js 错误截断后重放定位 |
| 2 | **云端镜像落后**（容器跑 9c6d400，git 已 5194e9a；F1–F4 未部署） | 部署断档 | 重建镜像 + `.env` 补 `BRAINX_FEEDBACK_SECRET` |
| 3 | **本地数据同步停滞**（8/21 起 sync_runs 零增长，`accounts.feishu.cn` DNS 解析失败 43 次） | 本机 DNS/网络出口 | ⚠️ 部分消解：本地已决议关停 bridge（§11-2），DNS 不再阻断业务；健康简报数据源需切到云端 |

### P1 — 数据与待办
- **待办积压 13 项**：7 个 ACCEPTED 无 outcome（felix 1 个停滞 16 天）+ 6 个 WATCHED 超 7 天 → 人工补录/推进；
- **DB 膨胀**：bridge 每 180s 全量冻结候选池，recommendations 164 万行（3.4G 主因）→ 立项：input_hash 未变不冻结 + retention 策略；
- **健康简报端口误报**：文档仍探测旧端口 3100 → 全部改 3101 / base.yorkteam.cn。

### P2 — 代码隐患（非阻断）
- push.js 错误截断 300 字符（诊断盲区）；
- C2：P-FIX 与 TTC 双源残留（纯 Bitable 源 3 个真身缺失占位行）；
- E1：server.js 路由纯字符串前缀匹配；E2：bridge `execFileSync` 阻塞事件循环；
- eazo 构建产物回推仓库（生产侧需配 exclude）；
- ~~otto active 但不在定时推送对象~~（2026-08-24 决议：有意排除，见 §11-3）。

---

## 9. 路线图

### 近期（本周，云端恢复专项 — cloud-recovery-checklist）
1. 修推送：容器挂 lark-cli（或进 Dockerfile）→ 验证下个推送窗口 push_log；
2. 部署 F1–F4：重建镜像 + 配 `BRAINX_FEEDBACK_SECRET`；
3. `npm run data:pull` 拉生产库 → 复跑诊断确认基线；
4. 文档端口统一 3101/base.yorkteam.cn。

### 中期（2–4 周，算法迭代）
5. 首批打标 140 对（label:export → 回收 → 幂等导入 → audit ≥140）；
6. 网格搜索粗调权重 → dry_run 影子对比 → **baseline-1.1** 提案（重点：活跃度连续衰减治天花板效应、+25 优先级加成复核）；
7. F1 生效两轮后复测 direction×similarity 相关性；
8. 周度评估报表（Top20 承接率/忽略率/DISMISS 率）。

### 远期（待定）
9. 独立 ECS 迁移（两 IP 分离，用户拍板规格/地域）；
10. TTC 抓取阶段 2/3（company/pipeline 抓包、驾驶舱群名自动发现、群消息 DRY_RUN）；
11. CRM `job/export` 治本（外部依赖 CRM 团队排期）；
12. DB 膨胀治理专项。

---

## 10. 验收指标（DoD）

| 维度 | 指标 |
|---|---|
| 推送 | 连续 3 个推送窗口 push_log SENT=6/6，FAILED=0 |
| 同步 | sync_runs 每日增长，各顾问最近同步 <24h |
| 反馈 | 一键反馈周点击 ≥30 次；打标 ≥140 且 conflicts=0 |
| 算法 | coverage 均值 0.53 → ≥0.7（F1/F4 生效后）；Top20 分数 ≥90 占比 <50% |
| 健康 | 每日简报无 🔴 告警；诊断无 high verdict |
| 测试 | `npm test` 全绿（当前 253/253） |

---

## 11. 开放问题 → 决议（2026-08-24 Ashley 拍板）

| # | 问题 | 决议 | 执行状态 |
|---|---|---|---|
| 1 | 推送唯一出口 | **推送只留云端容器一处；本地 launchd 不再发送任何推送** | ✅ 已执行：plist 设 `BRAINX_PUSH_SCHEDULE=0` 并重载 |
| 2 | 本地 launchd 定位 | **降级为纯开发：关停 bridge + scheduler**，不再承担数据同步与推送 | ✅ 已执行：plist 设 `BRAINX_BRIDGE_OFF=1`（仓库模板同步更新） |
| 3 | otto 推送 | **有意排除**，维持现状（active 但不进定时推送对象） | 无需改动 |
| 4 | ECS 迁移 | **待定**，不启动、不建云资源 | 挂起 |
| 5 | DB retention | 待定（随 ECS 议题一并决策） | 挂起 |
| 6 | 服务器遗留物 | **删除** | ✅ 已删 7 个 `diag_*.mjs`；备份目录与 `.bak` 早前已清，无残留 |

> 决议 1+2 的系统影响：本地 launchd 实例此后只做前端/接口开发调试；数据同步、定时推送、打标数据源一律以云端容器为准。本地 DB 不再更新属预期行为，健康简报的数据停滞告警应改为只监控云端。

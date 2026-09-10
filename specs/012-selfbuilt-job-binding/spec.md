# 012 — 自建岗找人绑定与降级（pj_* 接单 → OpenMai 连通）

状态：Implemented（2026-09-10）
上游：2026-09-10 第二批对话检验——felix 17:48-17:54 在工作台/bot 自建岗（pj_*，长角鹿科技×2 岗）上触发 OpenMai 找人 4 连败，error=「职位不存在，或当前顾问无权查看该职位」。用户指令「把工作台接单绑定到 TTC job，绑定进行修正，这个要可以连起来」。

## 1. 根因

`startOpenmaiTask` 解析 TTC 真身只有一条路：`job_facts.source_url` 带 `ttc://job/<unique_id>`（P-FIX 占位岗）或 project_id 本身即 TTC unique_id（J* 直查命中）。**bot 按判据自建的岗（pj_*，feishu 建岗逻辑）job_facts 行存在但 source_url 为 NULL** → 拿 pj_uuid 查 CRM → 查无 → 必然失败。

## 2. 修法（三级递进，不破坏既有成功路径）

CRM `jobs/detail` 查无时（错误标记 `JOB_NOT_FOUND`，与 401/403/HTTP 错区分——凭证/网络错误绝不降级）：

| 顺序 | 条件 | 动作 |
|---|---|---|
| ① 显式映射 | source_url 带 ttc://job/ | 照旧 job 模式（不变） |
| ② 自动绑定 | 本行无映射，但**同 company+role** 的其他 job_facts 行有 ttc://job/ 真身 | 采纳真身查 CRM，并**回写本行 source_url**（绑定落库，此后走 ①） |
| ③ 判据降级 | 自建岗且无同名真身（job_facts 行存在） | 不带 `job_id` 走判据找人：company/role/city/pipeline/hc 拼伪 job 走 `buildPrompt`，追加「自建岗无 ATS 编号」说明；结果照常落 openmai_results 同一 (project_id, consultant_id) |
| ④ 保持报错 | 连 job_facts 行都没有（真异常） | 原报错语义不变 |

York 的成功路径（JLI0YHW 直查命中）与 P-FIX 映射路径完全不变；只影响今天 felix 撞到的「查无→死」分支。

## 3. 边界

- 绑定只在 company+role 完全一致时发生（误绑风险最低）；绑定写入 `job_facts.source_url`（复用既有通道，无 migration）。
- 判据降级仍走会话隔离前言、污染检测重试、排除名单、search_round 幂等——全部复用现有机制。
- needs_input / done 判定、投递（openmai-delivery）不变。

## 4. 验收

- 单测：①映射路径不变；②自建岗命中同名真身 → job 模式 + source_url 回写；③自建岗无真身 → completions 请求**不带 job_id** 且 prompt 含公司/岗位/画像/自建岗说明；④无 job_facts 行 → 原报错；⑤CRM 401 不降级。
- full 门禁；生产部署后观察 felix 的长角鹿岗重试。

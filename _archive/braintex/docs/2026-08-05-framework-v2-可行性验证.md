# Braintex v2 框架可行性验证报告

> 2026-08-05 · 针对《2026-08-05-braintex-开发文档-v2.md》定稿的框架设计。
> 结论：**框架可行**。文档的全部关键技术假设经实证成立；发现 3 个实现层问题（已修复）、
> 1 个真实设计约束（已固化组合方式）、5 个 S1–S5 实施注意事项。

---

## 1. 验证方法

| 层面 | 动作 | 结果 |
|---|---|---|
| 代码假设 | 逐条核对文档 §2「现状资产」与现有代码 | 8/8 资产真实存在且可用 |
| RDS 实证 | 用 `.env` 凭据直连 `ttc_talent`，核对既有表/列/数据量 | 发现 v1 三表缺失（已迁移补齐） |
| MySQL 8 语法 | v1 schema 真实执行；v2 DDL 以 TEMPORARY TABLE 会话级执行（不落盘） | 5 张新表 DDL 全部通过 |
| 新机制规则自洽 | 纯 Python 参考实现 + 28 项验收测试（tests/test_framework_v2_feasibility.py） | 全部通过 |
| 端到端冒烟 | 真实 RDS 数据跑日推 dry-run + 729 名真实候选人试单打分 | 通过（行为与文档一致） |
| 回归 | 既有 13 项测试 | 全绿（41 passed / 1 skipped 总计） |

## 2. 文档假设逐条核对（§2 现状资产）

| 假设 | 实证 | 结论 |
|---|---|---|
| `score_signal(..., now=)` clock 注入 | signal_scorer.py:56，`now` 参数化，回放测试证明改 now 结果必变 | ✅ |
| 5 维信号打分含 reason | DIMENSION_REGISTRY 5 维 + 每维 reason | ✅ |
| 试单 Top3（PASS_SCORE=55） | 真实 729 候选人池：7 人达标、Top3 正常产出 | ✅ |
| 日推生成器 | dry-run 跑通；唯一 job_signals 行 job_title=NULL 被硬约束正确 EXCLUDE（§5.2） | ✅ |
| 权重版本（weight_config + current_weights） | 逻辑可用；**表在 RDS 不存在** → 已迁移 | ✅（修复后） |
| 响应回写 adoption_events | 代码在；**表在 RDS 不存在** → 已迁移 | ✅（修复后） |
| HMAC token / 飞书卡片 / 工作台 | security.py / push_card.py / static/apps/brianx/ 均在 | ✅ |
| 数据源表 | job_signals（1 行）、cloud_candidates（804 行，729 行文本>100 字符）列与 recommend.py SELECT 完全匹配 | ✅ |

## 3. 发现并已修复的问题

1. **`scripts/migrate_decision_schema.py` 路径 bug（拆分遗留）**：指向
   `<root>/ttc_daemon/decision/schema.sql`（jiands 旧布局，本仓库不存在）→ 日推表永远无法迁移。
   已修正为 `<root>/decision/schema.sql` 并加存在性检查。**已用修复后的脚本在 RDS 真实执行，
   recommendations / weight_config / adoption_events 三表已创建。**
2. **`cloud_sync/config.py` .env 发现路径错误**：`parent.parent.parent` 解析到仓库外的
   `~/Downloads/.env`，braintex 根目录的 `.env` 永远读不到。已改为自仓库根向上查找。
3. **v2 DDL 未落文件**：文档 §9 的 5 张新表 DDL 只存在于文档中。已固化为
   `decision/schema_v2.sql`（加 IF NOT EXISTS，与 v1 风格一致）+ `scripts/migrate_decision_v2.py`，
   并在 RDS 用 TEMPORARY TABLE 验证 MySQL 8 语法全部通过（decision_events 14 列 /
   engagements 8 列 / outcome_observations 11 列 / policy_versions 11 列 / sync_runs 11 列）。
   **未真实建表**——那是 S1 的显式动作，届时跑 `PYTHONPATH=. python3 scripts/migrate_decision_v2.py`。

## 4. 真实设计约束（已固化组合方式）

**`score_signal` 强制 5 维权重齐全**（缺维/权重和≠1 直接 ValueError），因此文档 §5.3
「缺失维度不静默当 0、只对有证据维度求加权平均」**不能靠给 scorer 传权重子集实现**。
可行组合方式（已在参考实现 `gated_score` 固化并被测试锁定）：
全维权重先过 `score_signal` 取每维 score/reason → 按可用维度重算加权平均
（分母=可用权重和，cooling ×0.5 语义保留）。S2 实施时照此接线即可，无需改现有 scorer。

## 5. 新机制验收测试清单（28 项，全部通过）

- **状态机（8 项）**：全合法链路 NEW→…→COMPLETED；7 类非法转移被拒；
  DISMISSED/RELEASED 强制 reason_code；ACCEPTED 365 天不静默退回；
  WATCHED 89 天不过期/90 天过期；冷却 29 天阻断/31 天放行；关注位上限 10 超限拒绝；
  旧 adopted→ACCEPTED / ignored→DISMISSED 映射。
- **事件账本（3 项）**：幂等键重复提交返回原结果不产生重复事件；
  CORRECTION 只追加不改历史；投影重建 == 实时状态且顾问间隔离。
- **coverage 分档（6 项）**：全证据 coverage=1.0 可建议接单（HIGH）；
  缺 3 维 coverage=0.45 强制 OBSERVE；0.5–0.7 区间封顶 RECOMMEND_WATCH（LOW）；
  供给 0 + 低 coverage 强制 OBSERVE；tie-breaker 固定序逐字节稳定；
  固定 clock 回放逐字节一致、clock 前移结果必变。
- **双轨调权（7 项）**：<20 事件 / <5 结果观察不学习且返回原策略；
  达标后新策略 status=shadow（不接管）且通过 bounds/归一化校验；
  优先级 manual_override > auto_active > baseline（未解锁手工不生效）；
  连续 2 轮不满意解锁；穿插满意清零；release 归因「推荐不准/人选不对」计数、其他归因不计；
  跨日窗口有效；A 顾问事件不影响 B 顾问。
- **证据契约（2 项）**：schema_version=evidence-1.0 形状精确匹配文档 §8；
  phone/email 不出证据接口；hits 与 trial_picker 语义一致、Top ≤3。
- **MySQL 避坑守护（1 项）**：v2 DDL 可执行语句无 ILIKE / NULLS LAST /
  ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。

## 6. S1–S5 实施注意事项（不阻塞，按序处理）

1. **信号供给是真实瓶颈**：RDS 仅 1 行 job_signals 且 job_title=NULL，日推空跑是
   文档硬约束的正确行为。S2 演示前需要 ≥1 条字段完整的信号。
2. **状态机缺口**：文档未定义 WATCHED→DISMISSED（关注后决定暂不考虑）与
   DISMISSED 冷却期内的重新激活路径，S1 落地前需在文档补两条转移或明确不做。
3. **tie-breaker 的 freshness 方向**：文档写 `freshness desc`，实现语义=最新鲜优先
   （距今天数升序）。参考实现已按此固化，S2 保持一致。
4. **上游姓名解析噪声**：真实试单 Top3 中出现「加入名单」「核心优势」等噪声姓名
   （cloud_candidates 上游 parser 问题，对应 ttc 审计 P2）。试单卡片直接展示候选人名，
   S3 建议加姓名可信度兜底（疑似噪声显示 fingerprint 尾号）。
5. **集成测试口径**：RDS 真实读写测试需 `RUN_DECISION_INTEGRATION=1` 显式开启
   （tests/test_decision_db.py 既有约定），CI 默认只跑纯单元测试。

## 7. 变更清单（本仓库）

- 修复：`scripts/migrate_decision_schema.py`（schema 路径）、`cloud_sync/config.py`（.env 发现）
- 新增：`decision/schema_v2.sql`、`scripts/migrate_decision_v2.py`、
  `tests/test_framework_v2_feasibility.py`（28 项）、本文档
- RDS 副作用：`ttc_talent` 新增 recommendations / weight_config / adoption_events 三张 v1 空表
  （CREATE TABLE IF NOT EXISTS，幂等，可 DROP 回退）

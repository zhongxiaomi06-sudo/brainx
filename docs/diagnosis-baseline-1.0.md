# 六维打分框架诊断报告（baseline-1.0 基线）

- 生成：2026-08-24，`scripts/diagnose-policy.mjs --db data/brainx.db`（只读）
- 数据：本机库 612,595 行冻结推荐（680 轮 / 7 顾问 / 984 职位）。**注意：云端为生产库，恢复后需对 brainx-cloud.db 复跑确认结论。**

## 核心发现

### 1. direction × similarity 不冗余（r=0.46，n=20,019）
此前「两维是同一信号、合并释放 15% 权重」的假设被数据**否定**——相关仅 0.46。但注意样本结构：similarity 维度 96.7% 行缺失（见下），相关性只在那 3.3% 有历史文本的行上计算。F1（owner 回种 memberships）生效、similarity 覆盖率上来后**必须复测**，届时若 r>0.8 再议合并。

### 2. 维度缺失全景（冷启动是主路径）
| 维度 | missing 占比 | 解读 |
|---|---|---|
| similarity | **96.7%** | job_memberships=0 的直接后果（historical_texts 断供）→ F1 修复目标 |
| outcomes | **97.2%** | job_outcomes 全表 1 行 → F4 补录 + 一键反馈修源头 |
| direction | 68.7% | 多数顾问画像为空且无历史文本兜底 |
| activity | 3.2% | 健康（仅非 OPEN 职位缺失，符合设计） |
| capacity / exploration | 0% | 恒有值 |

### 3. 天花板效应确认（CEILING_EFFECT）
Top20 中 **57.4%** 分数 ≥90（阈值 50% 触发）。头部职位挤在 90-100 区间，排序失去区分度。建议（待打标数据验证后执行）：活跃度阶梯分档改连续指数衰减；优先级加成 +25 过高，与群活跃基底叠加后轻易触顶。

### 4. coverage 均值 0.53
刚过 OBSERVE 硬线（0.5），大量推荐处于「证据刚够」状态。F1/F4 修复后 similarity/outcomes 两维接入，均值应显著上移——这是修复成效的量化验收指标。

## 未触发但需关注

- **STALE_TOP20 未触发**：周维度 Top20 独立职位轮换正常（>5 个/顾问/周），探索位在轮换，此前「榜单固化」的担心不成立。
- REDUNDANT_DIRECTION_SIMILARITY 未触发（见 §1）。

## 行动项（优先级序）

1. ✅ F1-F4 反馈回写修复（本次已交付）——直接决定 §2 三行数字
2. 云端恢复后对 brainx-cloud.db 复跑本诊断，对比差异
3. 首批打标完成（≥140 标签）后：验证天花板效应是否影响实际承接，若是 → 活跃度连续衰减改造提入 POLICY baseline-1.1 提案
4. F1 生效两轮同步后复测 direction×similarity 相关性

## 复跑命令

```bash
npm run diagnose -- --db data/brainx-cloud.db   # 云端副本（恢复后）
npm run diagnose -- --db data/brainx.db          # 本机库
```

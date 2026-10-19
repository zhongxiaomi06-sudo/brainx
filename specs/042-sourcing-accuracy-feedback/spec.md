# specs/042-sourcing-accuracy-feedback — 「推得准」反馈环 + 原生入口对比验证

> 状态：待咪评审（2026-10-19 19:53 咪拍板方向收束）
> 建档：2026-10-19（零一）
> 咪原话锚点：「推的准问题没有充分的反馈。我就解决推的准的问题，当前的产品的成功与否对比是和 supermai 的入口还有 openmai 的使用入口进行对比。」
> 优先级：P0（在「只解决推得准」的聚焦下，反馈环是缺的第一块基础设施）

## 1. 问题：推得准，但没有充分的反馈

- felix 三次投诉全是四个字的模糊信号（「base 地点不对」「不算特合适」「不准点」），且不走系统通道。
- spec 040 的 62 个用例是**工程验收**（判据生成逻辑对不对），不是**用户验收**（推的人准不准）。
- JWZSVXQ 对照组（98% 质量）是单点证据，无法外推。
- 没有反馈数据 → 无法迭代判据、无法证明 BrainX 比顾问自己搜强、felix 说「不准」我们无法用数据回应。

## 2. 方案总览

```
                   ┌─ 反馈环（§3，新）：结果卡一键「这批准/不准」
推得准 = ──────────┤
                   └─ 对比验证（§4，零开发起步）：三组对照 + 原生入口基线
                        G1 旧判据自动路径（历史数据）  vs
                        G2 新判据自动路径（spec 040 上线后）  vs
                        G3 顾问原生判据（agent 路径 ≈ 顾问在原生入口会输入的东西）
```

## 3. 反馈环：卡片一键反馈（本轮唯一新代码）

### 3.1 卡片改动（`src/sourcing-result-card.js`）

`buildOpenmaiDeliveryCard` 候选人行之后、继续找人按钮之前，加一组反馈按钮（项目卡与 freeform 卡同函数顺带支持）：

```
[👍 这批准]  [👎 这批不准]
```

- 按钮沿用既有指令模式（`value: { text: command }`），与「继续找人」按钮同一交互范式。
- command 形如：`[BRAINTEX_BATCH_FEEDBACK] 项目 J3ZJYBB 第 1 轮 task=sm_fab9e96b 反馈=准确。这个按钮就是我的明确反馈：现在调用 brainx_sourcing_feedback，传入 job_id=J3ZJYBB、task_id=sm_fab9e96b、verdict=accurate。成功后回复「已记录」。`

### 3.2 新 gateway 工具 `brainx_sourcing_feedback`

- 参数：`{ job_id, task_id, verdict: 'accurate'|'inaccurate', reason?: string(≤60字) }`，purpose `candidate_review`。
- 落账：`workflow_event_log`，event_type=`sourcing.batch_feedback`，idem_key=`feedback:batch:<task_id>:<verdict>`（同批次同判定幂等；accurate 与 inaccurate 各可记一次，统计取最新 occurred_at——允许改判）。
- payload：`{ project_id, task_id, verdict, reason, round }`；actor=触发顾问。
- **三处同步**（项目铁律）：tool-registry.js、插件声明（openclaw.plugin.json + runtime.js）、生产 openclaw.json 的 tools.allow + 插件副本（`/var/lib/brainx/.openclaw/extensions/brainx-openclaw/`）。
- 👎 点击后 agent 追问一次原因（方向不对 / 背景不符 / 地点不对 / 年限不对 / 其他，自由文本 ≤60 字），reason 入账。

### 3.3 周聚合

`brainx-feedback-rollup.timer`（每日 05:11 已有）扩一节「昨日批次准确率」：`sourcing.batch_feedback` 按 verdict 聚合 + 按 reason 分类计数，推给 mia。

### 3.4 边界用例

| # | 场景 | 期望 |
|---|---|---|
| F1 | 点「这批准」 | 事件落账 verdict=accurate；agent 回复已记录 |
| F2 | 点「这批不准」+输入原因 | 事件落账 verdict=inaccurate + reason |
| F3 | 同批次重复点同判定 | 幂等不重复入账 |
| F4 | 同批次先不准后准（改判） | 两行都在，统计取最新 |
| F5 | freeform 批次反馈 | task_id 前缀识别，同样落账（project_id 为合成键） |
| F6 | needs_input / failed 卡 | 无反馈按钮（只反馈有候选人的批次） |
| F7 | 无 job_id 的异常调用 | 工具报参数错误，不落脏数据 |
| F8 | reason 超长 | 截 60 字 |
| F9 | S3 校验 warn 沉底的批次点「准」 | 照常落账（反馈与校验独立，交叉分析素材） |
| F10 | 生产 tools.allow 未加工具 | 按钮指令 agent 无工具可调 → 明确报错提示，不静默（部署清单强制项） |

## 4. 对比验证：三组对照 + 原生入口基线（零开发起步）

### 4.1 三组数据（全部已在库或随新任务自然产生）

| 组 | 数据源 | 判据来源 | 状态 |
|---|---|---|---|
| G1 旧判据自动路径 | 历史 sm_ 任务 20 个 done（search_brief + result_text 留档） | 旧 buildAutoSearchCriteria（role+city+hc+company+3-5年） | 已有 |
| G2 新判据自动路径 | spec 040 上线后的新任务 | S1（已生效）→ S1.1+B（待实施/激活） | 开始积累 |
| G3 顾问原生判据代理 | agent 路径 om_ 任务 + 人工判据案（JWZSVXQ 式） | 顾问在对话里自己组织的判据 ≈ 他在 SuperMai/OpenMai 原生入口会输入的东西 | 已有 |

**核心对照：G2 vs G3 = BrainX 判据 vs 顾问自己写判据**——同一引擎、同一人才库，唯一变量是判据由谁生成。G2 胜或平（考虑省时）则产品成立。

### 4.2 度量（反馈稀疏期用代理指标，反馈积累后用真实指标）

- **真实指标**（§3 反馈环）：G2 每批「这批准」率；G3 无法直接取（原生入口无按钮）→ 用问卷基线替代。
- **代理指标**（无反馈时可跑，复用 S3 的 LLM 判定基础设施）：城市命中 / 年限命中 / 岗位语义命中 / warn 沉底率，对 G1 vs G2 vs G3 的 result_text 批量回放。
- **一次性人工基准**：咪 + 2 位顾问盲评 10 个职位 ×（G1 判据 top10 vs G2 判据 top10），只问「哪批更能用」。
- **原生入口基线（一次性问卷，需要咪帮忙问）**：「你自己直接用 SuperMai/OpenMai 搜 10 个人，通常几个能推客户？」——预期回答 3-4 个。这个数字就是 G2 要追平/超过的**达标线**。

### 4.3 成功判据（北极星落地）

- **北极星：BrainX 推荐批次的「这批准」率**（每批 = 顾问愿意把这批人推给客户）。
- **达标线**：G2 准确率 ≥ 原生入口基线（以问卷实值为准）；同质量下 BrainX 3-5 分钟 vs 手工 30-60 分钟，时间增益即产品价值。
- **失败信号**（诚实定义）：G2 准确率持续低于基线 2 周无改善 → 判据路线（S1+S1.1+B/C）证伪，回炉。

### 4.4 里程碑

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1 | 反馈环上线，积累 ≥20 批反馈 | 本 spec 实施（约半天） |
| M2 | S1.1 画像块 + B/C 激活（LLM key） | spec 040 §9 + 咪的 key |
| M3 | G2 准确率 ≥ 原生基线 | M1+M2 |

## 5. 验收

1. §3.4 十用例全过 + 存量卡片回归（卡片基线按门禁流程更新）。
2. `npm run verify` full 通过；三处同步逐项核对（含生产插件副本 md5）。
3. 上线后首个自然日：反馈按钮在真实结果卡出现，rollup 出第一份准确率数字。
4. 咪侧配套动作（非代码）：① 问卷 5 位顾问拿原生基线；② 安排 10 职位盲评。

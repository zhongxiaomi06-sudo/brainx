# Braintex S6：agent 群体调用插件（MCP）+ 强制鉴权 + 去脱敏

> 2026-08-05 · 用户指令：「能把当前的app作为codex等agent可以群体调用的插件，可以直接操控，
> 但是在特殊的操作逻辑是一样的，按照codex等agent的阅读逻辑，进行数据反馈优化，
> 通过codex等agent完成自然语言交互；阅读中的强制鉴权等流程必须强制规定，进行测试」
> + 「数据都不要脱敏」。
>
> 结果：**29 项 S6 测试全绿（全套 138 passed / 1 skipped）**，RDS 读写冒烟通过，
> MCP 已注册 Claude Code / Codex / OpenCode 三端并握手成功。

## 一、去脱敏（commit 701b6a2）

- `decision/evidence.py`：删除 `mask_sensitive` / `_PHONE_RE` / `_EMAIL_RE` 及全部调用点；
  supply top 增加 `fingerprint` / `phone` / `email` 字段，job_signals `excerpt` 原文透传；
  `validate_supply_contract` 移除「未打码手机号/邮箱」违规项，改守契约越界字段。
- `decision/trial_picker.py`：`score_pool` 携带 phone/email。
- `decision/api.py`：`/evidence/supply` 候选人查询补 phone/email 列。
- 测试全部反转：`tests/test_evidence_s5.py` 原文透出断言（手机号/邮箱进证据、
  excerpt 不打码、validator 接受原文）。
- 开发文档 §14 追加修订注记：访问控制全部交给强制鉴权，不靠打码。
- HTTP 实证：hits=13/729，Top1「王先生」phone=13522011639 原文透出，契约校验通过。

## 二、MCP server（decision/mcp_server.py）

**三原则**：① 操作逻辑与 HTTP app **完全一致**——写工具直接调
commands/personalizer/policy 同一套领域函数，零复制；② **强制鉴权 fail-closed**；
③ **agent 阅读逻辑**——承接列表/错误响应附 `legal_commands`，自然语言可链式操作。

### 工具面（8 读 + 4 写）

| 工具 | 说明 |
|---|---|
| `decision_today` | 今日推荐（按总分降序，含分档/coverage/试单人） |
| `decision_engagements` | 承接列表（逐行附 legal_commands + 状态分布 + 关注位上限） |
| `decision_timeline` | 单机会事件时间线 + 结果观察（含 CORRECTION） |
| `decision_outcomes` | 结果观察列表（调权学习数据源） |
| `decision_policy` | 生效策略解析 + 手工调权解锁进度 |
| `decision_evidence_supply` | 供给证据 evidence-1.0（**不脱敏**，Top3 含 phone/email） |
| `decision_job_signals` | job_signals FactSource（excerpt 原文） |
| `decision_replay_check` | 只读审计：账本重建投影 vs 已存投影比对 |
| `decision_command` | 5 顾问命令（watch/accept/dismiss/release/complete）；系统命令拒绝 |
| `decision_record_outcome` | 结果反馈闭环（CORRECTION 语义；自动调权奖励信号源） |
| `decision_save_weights` | 手工调权（两轮不满意解锁门禁，与 HTTP 一致） |
| `decision_rollback` | 手工版本一键回滚 |

### 强制鉴权设计（测试锁定）

- **启动闸门**：`TTC_DECISION_MCP_TOKEN` 未配置 → 打印纪律说明并 `exit 2`（fail-closed）。
- **每次调用（含只读）**：`token` + `actor` 必填；`hmac.compare_digest` 比对；
  缺 token→`missing_token`，错→`auth_failed`，缺 actor→`missing_actor`，
  服务端未配置→`server_not_configured`。
- **顾问隔离**：actor 即 consultant_id，工具不接收 consultant 参数。
- 错误码全集被 6 个鉴权测试锁定（启动闸门、全读工具拒错 token、全写工具拒错 token
  且**零副作用**、缺 token、缺 actor、正确凭据放行）。

## 三、数据源盘点（4 个飞书源，「这个是现在的数据」）

| 源 | 结构 | 用途对应 |
|---|---|---|
| TTC驾驶舱全景图（Base `Q1y5…`） | 38 家客户公司、138 岗位条目（技术/算法/产运三列）+ 地点 + 客户文档链接 | **岗位信号供给侧**——可回填 job_signals 解演示瓶颈 |
| 职位盘点·团队项目列表（Base `RR5N…`） | 31 行 30 公司：职位方向 × 地点 × 还做吗（1重点高优 12 / 常年招 11）× 主做 | 优先级 = 信号权重/urgency 维度依据 |
| Felix 投放增长营销项目池（Sheet `SQZF…`） | 20 行：客户/职位/方向标签/优先级 P0-P2/当前状态/下一步动作 | Felix 线项目池（证据消费方的需求画像） |
| 公司岗位情况-Shanon（Sheet `KneN…`） | 40 公司 78 岗位（AI产品/运营/UIUX/研发四列） | 个人 sourcing 盘 |

三个源都是**需求侧（岗位）数据**——正是遗留事项#1「信号供给是演示瓶颈」的答案。
下一步（未做）：飞书 → job_signals 桥接脚本，把这 138+78+31 条岗位按 urgency 分级入库。

## 四、注册（群体调用入口）

三端均已注册并握手成功（`claude mcp list` ✔ Connected）：

```
command: ~/Downloads/ttc的交易系统/candidate-collector/.venv/bin/python
args:    ["-m", "decision.mcp_server"]
env:     PYTHONPATH=~/Downloads/braintex:~/Downloads/ttc的交易系统/candidate-collector
         TTC_DECISION_MCP_TOKEN=<共享令牌，已写入 ttc .env，勿提交>
```

- Claude Code：`~/.claude.json` mcpServers.braintex
- Codex：`~/.codex/config.toml` [mcp_servers.braintex]
- OpenCode：`~/.config/opencode/opencode.json` mcp.braintex

自然语言示例（对任一 agent 说）：
- 「看看我今天有什么推荐」→ `decision_today`
- 「把 xx 岗位加入关注」→ `decision_command(command="watch", …)`
- 「这个岗位供给怎么样」→ `decision_evidence_supply(fingerprint=…)`（返回 Top3 含电话）
- 「面试过了，记一下」→ `decision_record_outcome(stage="面试", …)`（喂养自动调权）

## 五、测试与验证

- `tests/test_mcp_server_s6.py`：29 项（鉴权 6 + 命令逻辑 6 + 结果反馈 2 +
  调权门禁 4 + 读工具 5 + 数据读 4 + 策略读 1 + 隔离 1）。
- 全套：venv python 138 passed / 1 skipped；系统 python 109 passed / 2 skipped
  （S6 整文件 importorskip mcp，无 mcp 包环境自动跳过）。
- RDS 冒烟（insert→verify→cleanup）：watch 补链 VIEWED+WATCHED 落账、幂等回放
  already=True、outcome 落账、timeline 完整；冒烟行已清理。
- 启动 fail-closed 实证：无 token env 跑 `python -m decision.mcp_server` → exit 2。

## 遗留

1. 飞书 → job_signals 桥接（四源入库，解信号供给瓶颈）。
2. Codex/OpenCode 端重启后自行握手（配置已写入，未在本会话内验证两端运行时）。
3. `decision_save_weights` 解锁后建议 agent 先报 weights 摘要再写（当前直接落账，
   与 HTTP 行为一致）。

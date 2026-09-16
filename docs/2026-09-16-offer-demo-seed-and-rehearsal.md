# Offer 谈判演示：三人种子数据与排练手册

> 上级入口：[文档书总目录](README.md) ｜ 相关：[候选人 Offer 决策报告](2026-09-10-candidate-offer-report.md)、[D5 端到端灰测与演示脚本](2026-09-12-d5-e2e-greytest-and-demo-script.md)、[候选人决策群审核记录](frontend-reviews/2026-09-09-candidate-decision-group.md)

## 1. 目的

为三个真实进行中的 Offer 项目（曹国鸿 × aha 后端、杨东旭 × 超衍、从容地 × UIUX）做一场「AI Native offer 群」演示：机器人建新群、发候选人上下文欢迎卡、群内 @ 对话、生成/更新 Offer 决策报告。本手册覆盖演示数据的灌入与三级排练，不改动任何生产代码链路。

## 2. 演示数据（全虚构，不得用于生产决策）

`fixtures/demo-offer-candidates.json`，每个候选人包含：

- `job_id`：本地 `job_facts` 已真实存在的职位（曹国鸿 `J69JWW1`、杨东旭 `JSV8VOH`、从容地 `JBZ1NSL`）；
- `snapshot`：写入 `project_candidate_focus.candidate_snapshot_json` 的候选人快照（姓名/现职/经验/城市/学历/匹配度/项目匹配评估），评估段内含诉求、薪酬、竞对与谈判策略，是报告「二、候选人事实」的全部素材；
- `source_messages`：来源项目群讨论（灌 `lark_messages`，决策群欢迎卡迁移摘要与报告「三、来源项目群上下文」的输入）；
- `offer_messages`：决策群建成后的「电话纪要」（报告 V2「四、本决策群新增证据」的输入）。

三人的演示戏眼：曹国鸿 = 竞对 68W+签字费 9/20 截止的倒计时（不拼现金拼主导权）；杨东旭 = 薪资已谈拢、卡期权归属与到岗时间（要确定性）；从容地 = 现金略低但核心诉求是设计话语权+远程（非现金包组合）。

## 3. 灌入工具

`scripts/demo-offer-seed.mjs`（幂等；已存在真实 launch 的项目只跳过告警，绝不覆盖）：

```bash
# ① 灌绑定/成员/READY launch/重点名单(含快照)/来源群讨论
node scripts/demo-offer-seed.mjs seed --db data/brainx.db --tenant <tenant> --account <account> \
  [--source-chat TTC-260915-CGH=oc_xxx]   # 不传则用占位 oc_demo_src_<ref>

# ② 决策群建成后，把电话纪要灌进新群（生产 OpenClaw 不落 lark_messages，必须手工灌）
node scripts/demo-offer-seed.mjs seed-offer-msg --db data/brainx.db --chat <oc_offer_...> --ref TTC-260915-CGH

# ③ 就绪检查
node scripts/demo-offer-seed.mjs status --db data/brainx.db --tenant <tenant>
```

回归测试：`node --test tests/demo-offer-seed.test.mjs`（自包含，临时库验证灌入、幂等、电话纪要）。

## 4. 排练纪律（继承 D5 灰测教训）

1. **只用新建的干净群**：老 offer 群有多行 ACTIVE scope，`authorizeGroup` 会整体失败（D5 §2.5）；演示群由机器人建，成员由种子绑定控制。
2. **对话一律 @机器人**：`requireMention` 对纯文本消息运行态未生效（D5 §2.4），按钮优先、@ 其次。
3. **「更新报告」前先灌电话纪要**：生产 `lark_messages` 为空，不灌则 V2「新增证据」恒空——这正是 `seed-offer-msg` 存在的意义。演示节拍：建群 → 生成 V1 → 群内贴电话纪要（演示动作）→ ECS 上灌 `seed-offer-msg` → 点「更新报告」出 V2。
4. **报告链接必须彩排真开一遍**：9/14 生产出现过 `ERR_INVALID_URL`（outputs/bug-triage-20260914.md §11）。

## 5. ECS 拉群执行方案（L3 彩排）

前置：ECS 上 agent-gateway(3102) 与 OpenClaw 正常运行；仓库已部署本手册对应 commit。

1. 在 ECS 库查真实 `tenant_id` / `channel_account_id`（`SELECT tenant_id, channel_account_id FROM feishu_identity_bindings LIMIT 5`），作为 `--tenant/--account`。
2. 确认三个项目的来源群：若 ECS 已有 READY launch，seed 会跳过 launch 并沿用真实来源群；否则用 `--source-chat` 指定演示来源群（机器人须在群内）。
3. 跑 `seed` → `status` 确认三人 `launch=READY / focus=FOCUSED`。
4. 在每个来源群 @机器人「为 XX 建决策群」（工具 `CREATE_DECISION_GROUP`），机器人建 `<姓名>-<岗位>-Offer决策` 群并发上下文欢迎卡（候选人概览 + 原项目群讨论迁移 + 待核实清单），群成员 = 种子绑定人员。
5. 点首卡「生成报告」出 V1；群内贴电话纪要；ECS 跑 `seed-offer-msg`（chat_id 从 `status` 取）；点「更新报告」出 V2，核对「新增证据」含纪要、文档链接可打开。
6. 彩排通过后，演示当天按 4-5 现场执行；彩排群保留作备用。

## 6. 验收边界

- 演示数据全为虚构，种子行均以 `demo-` 前缀标识（binding_id / launch_id / message_id / job_memberships.source），清理时按此前缀删除。
- 本手册不涉及报告六段结构本身的改动；如需定制报告正文版式，另行在 [候选人 Offer 决策报告](2026-09-10-candidate-offer-report.md) 链路里演进。

## 7. ECS 彩排实录（2026-09-16，实例 i-bp1dgg3rzmehc33fwpsn）

全程通过本机阿里云 CLI `RunCommand` 执行，数据库已先备份（`data/brainx.db.backup-offerdemo-20260916-114103`）。

- 灌入：`seed --tenant yorkteam --account mia` 三人全部 `launch=READY / focus=FOCUSED`；9 个真实 ACTIVE 绑定全部复用，未新建演示绑定。
- **排障（重要）**：首次建群报 `OPENCLAW_GROUP_ALLOWLIST_FAILED`，根因是 `/var/lib/brainx/.openclaw/openclaw.json` 属主被某次 root 侧操作写成 `root:root 600`，brainx 服务与 CLI 均读不了。已 `chown brainx:brainx` 修复——这同时解释了 9/14 生产 bug 分诊里的 8 条同码错误（outputs/bug-triage-20260914.md §13）。**教训：ECS 上任何 openclaw config 操作必须 `sudo -u brainx` 并带 `OPENCLAW_CONFIG_PATH=/var/lib/brainx/.openclaw/openclaw.json`。**
- 建群（真实飞书）：`曹国鸿-后端研发工程师（数据与 AI 应用方向）-Offer决策`(oc_e2c48d45…)、`杨东旭-Ai infra-Offer决策`(oc_4d7d97cf…)、`从容地-UIUX 设计师-Offer决策`(oc_c2c041de…)，三群 READY，欢迎卡（候选人概览+来源群讨论迁移+待核实清单）已发，群成员按种子绑定自动拉入（wendy/miya/frankie）。
- 报告：V1 三份（证据 0 条）→ 灌电话纪要 → V2 三份（证据 2/2/1 条），文档均生成在 `jxog8b3tny.feishu.cn` 租户下，链接格式校验通过、群内报告卡已投递。
- 收尾：`status` 三人全部 `决策群=READY / 报告=2 版`；db 文件属主保持 `www:www` 未污染；brainx / brainx-agent-gateway / openclaw-brainx 三服务全程 active。

演示当天只需：群内贴新的电话纪要（或再灌 `seed-offer-msg`）→ 点「更新报告」出 V3，即是完整的"机器人把讨论学进报告"现场版。

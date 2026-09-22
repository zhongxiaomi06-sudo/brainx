# 仓库重构阶段 00：冻结基线与首个施工单元

> 上级入口：[施工总手册](2026-09-22-refactor-agentic-ranking-manual.md) ·
> [文档书](README.md)
>
> 记录时间：2026-09-22 17:16 +08:00；状态：部分完成。

## 1. 本轮边界

本轮只启动不会写业务数据的评估正确性单元：修复 Python/JavaScript 的
NDCG 计算和 `evaluate({ runs })` 参数失效，并补手算回归夹具。Algorithm A、
数据库迁移、生产数据回填、来源切换、发布与前端接入均不在本单元内。

Algorithm A 当前没有实现、启动开关或生产读路径，因此保持关闭。后续实现必须
另行增加默认关闭且启动时校验的配置，不能把历史 `baseline-1.1` 标成 A。

## 2. Git 与协作基线

| 项目 | 冻结值 |
|---|---|
| 分支 | `codex/offer-single-report-sync` |
| 开工 commit | `66e41ad` |
| 上游关系 | 相对 `origin/codex/offer-single-report-sync` ahead 1 |
| 工作区 | 开工时干净 |
| Git 操作状态 | 无 merge/rebase/cherry-pick/index lock |
| 本地工作锁 | `logs/agent-work.lock`，任务为阶段 00/01 |

当前迁移文件范围为 `0001`–`0050`。编号 `0017` 与 `0049` 各有两个历史文件，
因此后续迁移不能按“最大编号 + 1”之外的猜测分配，也不能借本轮评估修复整理旧编号。
本单元不新增迁移。

本轮没有获准访问生产库，也没有可识别的脱敏数据库副本，因此尚未建立数据库
恢复点。所有会改写、回填、清理或切读数据的后续任务继续阻塞；本轮纯函数、只读
评估和本地内存夹具不依赖该恢复点。

## 3. 已核对的真实入口

| 用途 | 调用链 | 当前边界 |
|---|---|---|
| 正式规则推荐 | `npm run recommend` → `bin/brainx-recommend.mjs` → `recommend()` → `hardBlock()` / `scoreJob()` → `sortRecs()` | 引擎为 `baseline-1.1`，本轮不改 |
| JavaScript 离线评估 | `npm run eval:ranking` → `evaluate()` → `labelsForRun()` → `labelFor()` | 当前标签读取现态，不能作 A 晋升依据 |
| LTR 样本导出 | `bin/brainx-ltr-export.mjs` → `exportRows()` → `labelFor()` / `featuresOf()` | 未知标签被排除，历史时点尚未冻结 |
| Python 训练对照 | `scripts/train_ltr.py` → LightGBM → `ndcg()` | 仅影子对照，不改变正式顺序 |
| 影子排序评估 | `evaluate(..., shadowModel)` → `featuresOf()` → `shadowModel.score()` → 共享 NDCG | 只比较，不发布 |

## 4. 兼容表与指标定义

| 接口 | 本单元前后兼容要求 |
|---|---|
| `evaluate(db, options)` | 返回结构和字段名不变；`options.runs` 必须真实限制每位顾问的轮数 |
| `npm run eval:ranking -- --runs N` | 命令与输出形状不变，修正后的数值允许变化 |
| `train_ltr.py` | 训练参数、模型格式和命令不变；仅修正报告中的 NDCG |
| 正式推荐 API/CLI | 不改路由、存储、顺序、分数或展示 |

本单元统一采用以下 NDCG 口径：

1. DCG 由预测顺序决定折损位置，收益为 `2^label - 1`。
2. IDCG 从同一完整评估组的全部已知标签中选理想 Top K，不从预测 Top K 截片计算。
3. 未知标签不当作 0，也不通过先过滤再截断挤占名次；预测第 K 名之后的项目不能
   因前面有未知项而进入 DCG@K。
4. 没有任何已知标签，或已知标签全为 0 时返回 `null`，不伪装为 0 分。
5. 部分标注只作诊断；时间冻结、成熟窗口和覆盖率在阶段 01 后续单元完成前仍未满足
   Algorithm A 晋升口径。

## 5. 改造前完整门禁

在开工 commit 上执行 `npm run verify`，退出码 1：25 项中 18 项通过、7 项失败。
结构、安全、语法、前端 Lint/类型、前端 53 项测试、生产构建和 Storybook 静态构建
通过。失败均发生在当前受限执行环境：两项 npm audit 无网络；后端 HTTP 测试、
Storybook 交互、浏览器链路、卡片渲染和服务烟雾测试因监听端口或启动浏览器被
`EPERM` 拒绝，其中后端套件在 300 秒门禁上限超时。

这不是可上传证据。提交后的完整门禁必须在允许 npm registry、监听本机端口和启动
无头浏览器的环境重新执行，报告结论为“通过”且 Push 条件为“满足”后才可上传。

## 6. 责任与未决项

工程执行者为本轮 Codex；业务验收人、数据负责人和运维负责人仍待项目分配。本轮
不替这些角色决定主指标、成熟窗口、预算、保留期或生产默认值。

阶段 00 仍缺：脱敏数据库恢复演练、角色实名确认、后续阶段完整接口清单与上线参数。
这些缺口不阻断本轮只读评估修复，但阻断任何数据迁移、清理、灰度和发布。

## 相关文档

- [施工总手册](2026-09-22-refactor-agentic-ranking-manual.md)
- [Algorithm A 决策契约](2026-09-22-algorithm-a-contract.md)
- [数据契约与迁移手册](2026-09-22-ranking-data-migration.md)
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)
- [评估正确性规格](../specs/019-ranking-evaluation-correctness/spec.md)

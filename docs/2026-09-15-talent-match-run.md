# 人才匹配跑批（talent-match-run）：独立可插拔模块

> 上级：[文档书总目录](README.md) · 相关：[群成员权限放开与绑定自愈](2026-09-15-group-member-access-and-bind-selfheal.md)、[复用与自建边界及权限需求 PRD](prd-2026-09-01-reuse-selfbuild-boundary.md)

## 解决什么问题

`brainx_candidate_shortlist`（src/candidate-shortlist.js）只读 RDS 预计算短名单（match_runs 链路）。
此前预计算数据只有 reloop 源系统导入的两轮（reloop-position:26/31），任何普通职位查询都返回
`NO_AUTHORIZED_SHORTLIST`（2026-09-15 荆华密算群实证）。本模块把预计算能力补齐为可跑批的内部模块。

## 模块边界（用户 2026-09-15 决策：独立模块、可插拔、不影响主模块）

- 只新增三个文件：`src/talent-match-run.js`（核心）、`bin/brainx-talent-match-run.mjs`（CLI）、
  `tests/talent-match-run.test.mjs`。不改动任何现有文件；SQLite 决策库只读。
- 打分复用既有 supply-match-v1（talent-supply.js，skill 0.5 + intent 0.3 + text 0.2，阈值 0.15）。
- 写入只发生在 RDS 预计算链路与两张授权账本，全部幂等（INSERT IGNORE + 内容寻址确定性 id），可任意重跑。
- 模块自身不启动循环；接入方式二选一：CLI 手动/定时执行，或 worker 里 `await runTalentMatchRun({ db, dryRun:false })`。

## 用法

```bash
node bin/brainx-talent-match-run.mjs                 # dry-run（默认，零写入，打印报告）
node bin/brainx-talent-match-run.mjs --write         # 落 RDS（单事务，可重跑）
node bin/brainx-talent-match-run.mjs --job JHTSEQJ --write   # 单职位
```

- 活跃职位口径：OPEN 且（intake BOUND ∪ READY launch ∪ 当前 MY_JOB/TEAM_SHARED 成员）。
- 授权：人才侧 grantee_type='project'（覆盖绑定群全部成员）；职位侧按当前 job_memberships 逐顾问，
  purpose 固定 candidate_review。
- candidate_ref 规则：`talent-db:<talent.id>`（受控稳定引用）；联系方式不进事实契约（fail-closed 纪律）。

## 验证

- 测试 5/5：dry-run 零写入、write 后 candidateShortlist 全链返回（含 bundle schema 与双授权）、
  幂等重跑、阈值过滤、--job 与 grantee 并集；相关回归 34/34。
- 2026-09-15 生产首跑记录见提交日志。

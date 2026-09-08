# 008 — 三通道人才搜索（skill 打包）

状态：Implemented（2026-09-08）
上游：用户决议「三个人才搜索的通道……做成三个工具包，可以自由调用，做成调用 skill 的形式；当前的工具逻辑先完成搭建」。

## 1. 三个通道与工具（工具逻辑全部已就绪）

| 通道 | 工具 | 形态 | 载体 | 成本 |
|---|---|---|---|---|
| 内部人才库（Reloop） | `brainx_candidate_shortlist` | 按职位读预计算授权短名单 | RDS `reloop` 脊柱表（candidate-shortlist.js，fail-closed 授权查询） | 零外部成本、即时 |
| 外部找人·按职位（OpenMai） | `brainx_openmai_search` | job_id → CRM 详情 → completions | OpenMai 引擎（openmai-task.js） | 真实找人运行，数分钟+费用 |
| 外部找人·按判据（SuperMai） | `brainx_supermai_scout` | criteria 自由找人（无 job_id） | OpenMai 引擎 criteria 模式（supermai-sourcing.js，specs/007） | 同上 |

三工具均已在 tool-registry / gateway / 插件声明接线（purpose=candidate_review），
本轮不改工具逻辑，只做 agent 技能层打包。

## 2. skill 包（skills/ 约定：一目录一 SKILL.md，frontmatter 仅 name/description）

- `skills/brainx-sourcing-reloop/SKILL.md`
- `skills/brainx-sourcing-openmai/SKILL.md`
- `skills/brainx-sourcing-supermai/SKILL.md`

每个包固定内容：何时用（三通道决策树）、调用契约、两段式/分页语义、费用与防重纪律、
空结果语义与溯源话术、隐私纪律（姓名掩码、不臆造）、与其他两通道的组合策略。

## 3. 边界

- 不把新 skill 加入 openclaw 安装集（tests/agent-tools.test.mjs 的 installable 白名单
  与 allowed 工具集不变）；产品内嵌 agent 经 discoverSkills 自动发现，重启生效。
- 不改任何工具参数与处理器逻辑。

## 4. 非目标

- criteria 化的 Reloop 全库模糊搜索（需 reloop 库新查询授权与索引，另行立项）。
- 生产部署（沿用 specs/007 T8）。

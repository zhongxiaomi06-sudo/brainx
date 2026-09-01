# 参考代码本地镜像清单

> 上级入口：[文档书总目录](../README.md) · 相关：[规范驱动研发流程](SPEC_DRIVEN_WORKFLOW.md) · [复用与自建边界 PRD](../prd-2026-09-01-reuse-selfbuild-boundary.md)

2026-09-01 全网搜索并经 GitHub API 核实（[蓝图 §9.1/§9.2](../architecture-2026-09-01-full-blueprint.md)）的参考仓库，已下载源码快照到**仓库外**目录 `/Users/ashley/Downloads/brainx-refs/`——不进本仓库、不进 git、不参与门禁；仅作学习/对照用途，禁止 import 其代码（许可证与本仓库自建边界约束见各条目）。

获取方式说明：本机代理对 `github.com` 主站 git 通道不稳（CONNECT 502），改用 `https://api.github.com/repos/<owner>/<repo>/tarball` 下载源码包解压（非 git clone，无历史，重新获取即覆盖）。

| 本地路径 | 上游 | 用途（学习什么） | 许可证 |
|---|---|---|---|
| `brainx-refs/open_recruiter/` | [miao4ai/open_recruiter](https://github.com/miao4ai/open_recruiter) | 最像 BrainX 的同类实现：审批 checkpoint、简历去重、IM 收简历入口、无 Redis 的后台自动化形态 | 见仓库 LICENSE |
| `brainx-refs/Resume-Matcher/` | [srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher)（约 2.7 万星） | 简历-JD 量化打分维度与可视化口径（TTC 打分侧对照） | 见仓库 LICENSE |
| `brainx-refs/sledge/` | [torkbot/sledge](https://github.com/torkbot/sledge) | **Step 0 权威对照**：dedupeKey 幂等、事务化物化、queue lease/重试/DLQ/重启恢复 | MIT |
| `brainx-refs/reflow-ts/` | [danfry1/reflow-ts](https://github.com/danfry1/reflow-ts) | 唯一零原生依赖的 TS 持久执行引擎（node:sqlite 适配器）；9/8 前 Saga 吃力时的唯一 `npm i` 候选 | 见仓库 LICENSE |
| `brainx-refs/lark-samples/` | [larksuite/lark-samples](https://github.com/larksuite/lark-samples)（官方） | 9/3 联调前照抄：卡片 JSON、回调处理最小可跑样例 | 见仓库 LICENSE |

## 使用规则

1. 学习 = 读设计与测试写法；**代码不复制进本仓库**（零依赖与自建边界，见复用 PRD §3）；
2. 引用某仓库的设计决策时，在对应 spec/文档里标注"参照 brainx-refs/<repo> 的 <文件/模块>"；
3. 镜像为浅克隆快照，过期后重新 clone 即可；不在 AGENTS 工作锁保护范围内（仓库外目录），任何 Agent 都可读；
4. 未镜像但可"抄模型"的：Cedar（Rust 引擎不克隆，抄权限模型进 `decide()` 决策表）、Codex 规范（待入库）。

## 相关文档

- [全景架构与技术施工蓝图 §9.1/§9.2](../architecture-2026-09-01-full-blueprint.md)（选型与核实权威）
- [复用与自建边界及权限需求 PRD](../prd-2026-09-01-reuse-selfbuild-boundary.md)（自建边界与权限最小集）

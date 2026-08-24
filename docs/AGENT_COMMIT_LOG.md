# Agent Commit 记录

所有 Agent 在创建代码或文档 commit 前，都必须在本文件顶部追加一条简明中文记录，并将记录与对应改动放入同一个 commit。

## 2026-08-24｜fix(push): lark-cli 加超时 + PREVIEW 可被真实发送覆盖

- 改动：`pushCard` 的 `execFileSync('lark-cli')` 加 30s 超时 + SIGKILL（防挂死阻塞整进程）；PREVIEW 记录在本次 `send=true` 时允许覆盖发送（原会幂等跳过导致预览后永远发不出），PREVIEW→PREVIEW 仍幂等。
- 验证：新增回归测试「PREVIEW 可被 send=true 覆盖」；后端全量 187 例 186 通过（唯一失败为根目录 CSV 缺失的环境问题，非本次改动）。

## 2026-08-24｜fix(deploy): Docker 排除密钥 + 持久卷可写 + 启动脚本行尾修复

- 改动：`.dockerignore` 排除整个 `data/`（含 `data/.secret` 令牌加密密钥）；`Dockerfile` 将 `/app/data` chown 给 node 用户（修复新卷 EACCES）；部署文档/脚本补 `-v brainx-data:/app/data` 持久卷；4 个 shell 启动/部署脚本 CRLF 转 LF 并清理行尾空格（修复脚本在 Linux/macOS 不可运行）。
- 验证：`bash -n` 全部通过；`git diff --check` 对脚本无报错；未引入新依赖。

## 2026-08-24｜fix(frontend): 工作台空 actions 崩溃兜底 + 根错误边界

- 改动：`DecisionCard` 对空 `actions` 兜底（原会在 `action.id` 处抛 TypeError 白屏）；「查看上次快照」按钮对空职位数组加守卫；新增根 `ErrorBoundary`（`error-boundary.tsx`）并由 `page.tsx` 包裹。
- 验证：`vinext build` 通过；`tests/brainx-adapter.test.mjs` 17 例通过；`workbench.tsx` 保持 779 行未增长。

## 2026-08-24｜docs: 增加文件规模与审查门禁

- 改动：规定手写文件最多 500 行，将 DeepSeek 审查中已复核的问题模式转化为上传前验证规则，并新增审查提炼文档及阅读路由。
- 验证：核对超限文件、Docker 忽略项、超时、CLI、CI 和文档漂移证据；检查 Markdown 链接、Git 差异与空白错误。

## 2026-08-24｜docs: 清理验证文档尾随空白

- 改动：调整验证文档顶部引用块换行，清除 Markdown 尾随空白。
- 验证：执行 `git diff --check`，确认无空白错误。

## 2026-08-24｜docs: 建立 Agent 文档书与验证指南

- 改动：新增文档书总目录和六项上传前完整验证，更新 `AGENTS.md` 的阅读路由及非代码规则文档化要求。
- 验证：检查 Markdown 链接、文档层级、Git 差异和暂存区内容。

## 2026-08-24｜docs: 纳入仓库级 Agent 工作准则

- 改动：将受稀疏检出限制而未进入上一提交的根目录 `AGENTS.md` 正式纳入版本控制。
- 验证：执行 Markdown 差异检查、Git 暂存区检查和提交后状态检查。

## 记录格式

```text
## YYYY-MM-DD｜类型(范围): 中文摘要

- 改动：说明本次提交完成了什么。
- 验证：列出已执行的测试或检查；未执行时说明原因。
```

## 2026-08-24｜docs: 添加多 Agent 协作与提交准则

- 改动：新增仓库级 `AGENTS.md`，规定第一性原理、Ponytail 最小实现原则、共享工作区互斥等待、即时提交、中文记录及上传前检查流程；新增本提交记录文件。
- 验证：检查文件内容、Git 差异和工作区状态。

# 030 — Agent 上下文与完整用量

状态：Verified（2026-09-23）

上游：[施工总手册](../../docs/2026-09-22-refactor-agentic-ranking-manual.md)阶段 06、
[Algorithm A 决策契约](../../docs/2026-09-22-algorithm-a-contract.md)。

## 1. 目标

建立逐模型尝试用量账本、按授权读取的 Context Registry 和 Algorithm A 专用窄工具面。所有成功、失败、重试、取消、缓存命中与最后收尾调用均可查；供应商未返回的用量保持 unknown，不记为 0。

## 2. 行为要求

### S1｜逐尝试用量账本

每次模型请求在发起前建立 call/attempt，终态为 `SUCCEEDED / FAILED / CANCELLED / CACHED / UNKNOWN`。记录 run、round、provider/model、Token 子类、费用版本、时延、工具数、上下文引用和错误码；不保存密钥、完整对话或简历。

### S2｜run 聚合与预算

run 聚合所有轮次和尝试，不再只返回最后一轮。缓存输入与 reasoning Token 保留子集口径，不重复相加。强制收尾、格式修复和重试均占用预算；超额前停止新调用。

### S3｜Context Registry

上下文条目记录租户、来源与版本、授权范围哈希、摘要、大小、有效期、截断和撤权状态。每次读取重新验证租户和作用域；过期/撤权内容不可读，运行只保存引用。

### S4｜A 专用窄工具

只注册契约中五个只读工具；信任身份由服务端闭包注入，参数不接受顾问/租户切换。工具无业务写入、Shell、任意 SQL 或任意网络能力；JD/文档中的指令只是不可信数据。

### S5｜兼容

现有 Agent loop 对无 recorder 调用方保持返回契约；默认不增加重试。不新增依赖，不连接生产、发布或 push。

## 3. 验收

1. 两轮成功与一轮失败/取消分别可查，run 聚合不丢前轮。
2. 用量缺失为 unknown；缓存/reasoning 不重复计费。
3. 跨租户/作用域、过期和撤权上下文读取全部拒绝。
4. 窄工具只读且每次重校验；恶意 JD 不能触发写工具或越权。
5. 专项、快速和完整门禁通过。

## 相关文档

- [实现计划](plan.md)
- [任务清单](tasks.md)
- [上传前完整验证](../../docs/standards/PRE_PUSH_VERIFICATION.md)

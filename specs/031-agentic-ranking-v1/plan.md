# 031 Plan — Algorithm A 最小端到端链路

1. 冻结 `baseline-1.1` 正式读写、Algorithm A 契约和 029/030 版本输入。
2. 先写硬过滤、Agent 原序、伪证据/无输出、弃权、乱序 generation 与发布前失效红灯回归。
3. 以追加迁移建立独立 A run/item/generation 账本，不污染基线 `COMPLETED` 读路径。
4. 实现确定性资格过滤、多路召回和冻结上下文，将 Agent 决策器作为注入端口。
5. 实现严格校验、有界修复、弃权、失败和 generation/CAS 原子发布。
6. 专项、快速和完整门禁通过后更新施工手册。

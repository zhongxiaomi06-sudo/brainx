# 022 Plan — 排序负反馈事件回放与撤销

## 实现方案

1. 新增 0053 追加式反馈事件表；旧当前态表保持兼容，不回填历史。
2. 建立单一反馈事件服务，复用 0052 的双时间与推荐关联校验。
3. 推荐反馈和飞书卡携带准确 `decision_id`；项目级忽略允许不关联。
4. 当前投影写入、撤销与事件追加放在同一事务；重试按事件幂等键短路。
5. 时间切分标签按发生/收到时间重放极性，报告稳定原因码计数。

## 兼容与回滚

- 当前忽略、隐藏、重加和接单入口保持；新账本是评估证据，不替代权限判断。
- 回滚代码时新增表无人读取；不删除表、旧反馈或业务事实。
- 缺 `decision_id` 的旧调用继续执行业务动作，但明确保持未归因。
- 本轮不执行生产迁移、回填、训练或发布。

## 验证

- `node --test tests/ranking-feedback-replay.test.mjs tests/ranking-label-window.test.mjs tests/feedback-loop.test.mjs tests/membership.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`

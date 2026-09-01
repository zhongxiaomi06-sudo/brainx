# Quickstart: Step 0 事件账本回放验证

## 前置

- Node 22（`/Users/ashley/.workbuddy/binaries/node/versions/22.22.2-2/bin/node`）
- 无需任何外部服务；测试用内存/临时 SQLite，不碰 `data/` 生产库

## 运行回放门禁

```bash
# 全量 hub 回放（实现完成的定义：全绿）
node --test tests/hub-event-log.test.mjs tests/hub-consumer.test.mjs \
  tests/hub-case-machine.test.mjs tests/hub-entity-links.test.mjs

# 快速门禁（含全仓既有测试回归）
npm run verify:quick
```

## 手工验证四个关键语义

```bash
node -e '
const { appendEvent } = require("./src/hub/event-log.js");
// 1) 重复 idem_key 只落一行（SC-002）
for (let i = 0; i < 1000; i++) appendEvent({ idemKey: "evt-001", eventType: "demo", actor: "system:demo", payload: {} });
console.log("rows =", require("./src/db.js").db.prepare("SELECT COUNT(*) c FROM workflow_event_log").get().c); // 必须是 1
'
```

崩溃重放与并发迁移由测试内注入（`hub-consumer.test.mjs` 的中途异常用例、`hub-case-machine.test.mjs` 的双连接用例），无法用一行 shell 演示。

## 验收核对清单（Codex 交回时逐项打勾）

- [ ] SC-001 四个回放套件全绿
- [ ] SC-002 重复投递 1000 次账本恒 1 行
- [ ] SC-003 崩溃注入后业务状态一致
- [ ] SC-004 `grep -r workflow_event_log src/ migrations/` 真实命中
- [ ] SC-005 零新增依赖（package.json 仅按蓝图决议加 zod）、verify:quick 通过
- [ ] 迁移 0023-0027 均登记 schema_migrations

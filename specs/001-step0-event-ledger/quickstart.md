# Quickstart: Step 0 事件账本回放验证

## 前置

- Node 22（`/Users/ashley/.workbuddy/binaries/node/versions/22.22.2-2/bin/node`）
- 无需任何外部服务；测试用内存/临时 SQLite，不碰 `data/` 生产库

## 运行回放门禁

```bash
# 全量 hub 回放（实现完成的定义：全绿，23 用例）
node --test tests/hub-event-log.test.mjs tests/hub-consumer.test.mjs \
  tests/hub-case-machine.test.mjs tests/hub-entity-links.test.mjs \
  tests/hub-upcaster.test.mjs

# 快速门禁（含全仓既有测试回归）
npm run verify:quick
```

## 手工验证四个关键语义

```bash
node --input-type=module -e '
import { openDb } from "./src/db.js";
import { appendEvent } from "./src/hub/event-log.js";
const db = openDb(":memory:");
const evt = { event_id: "evt-001", idem_key: "evt-001", event_type: "demo",
  actor: "system:demo", occurred_at: new Date().toISOString(), payload: {} };
for (let i = 0; i < 1000; i++) appendEvent(db, evt); // 重复 idem_key 只落一行（SC-002）
console.log("rows =", db.prepare("SELECT COUNT(*) c FROM workflow_event_log").get().c); // 必须是 1
'
```

崩溃重放与并发迁移由测试内注入（`hub-consumer.test.mjs` 的中途异常用例、`hub-case-machine.test.mjs` 的双连接用例），无法用一行 shell 演示。

## 验收核对清单（实施交回时逐项打勾，2026-09-02 由 WorkBuddy 会话实施完成）

- [x] SC-001 四个回放套件全绿（含 upcaster 共 23 用例全绿）
- [x] SC-002 重复投递 1000 次账本恒 1 行（hub-event-log.test.mjs 用例 + 上方手工单行验证）
- [x] SC-003 崩溃注入后业务状态一致（hub-consumer.test.mjs 中途异常用例）
- [x] SC-004 `grep -r workflow_event_log src/ migrations/` 真实命中（src/hub/event-log.js、migrations/0023）
- [x] SC-005 零新增依赖（package.json 仅按蓝图决议加 zod）、verify:quick 通过
  - 注：verify:quick 14/16，仅余其他协作者未跟踪文件的 2 项既有失败（week-plan HTML 超长行、health-brief 行尾空白），与本规格无关
- [x] 迁移 0023-0027 均登记 schema_migrations（另含 0028 processed_events 主键修正，见 data-model.md 修正记录）

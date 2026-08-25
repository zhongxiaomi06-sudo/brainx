import assert from "node:assert/strict";
import { openDb } from "../../src/db.js";
import { createServer } from "../../src/server.js";

const db = openDb(":memory:");
const server = createServer(db, { frontendTarget: null });
const timeout = setTimeout(() => {
  console.error("烟雾测试超过 15 秒");
  server.close();
  db.close();
  process.exitCode = 1;
}, 15_000);

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const response = await fetch("http://127.0.0.1:" + address.port + "/api/v1/meta/guard", {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(typeof payload, "object");
  assert.equal(typeof payload.per_minute?.total, "number");
  console.log("烟雾测试通过：服务启动、核心健康接口响应并可解析");
} finally {
  clearTimeout(timeout);
  await new Promise((resolve) => server.close(resolve));
  db.close();
}

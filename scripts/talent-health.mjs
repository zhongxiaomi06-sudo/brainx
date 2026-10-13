#!/usr/bin/env node
/** talent-health.mjs — 人才库连接与 schema 自检（只读，不建表）。
 *
 * 用法：node scripts/talent-health.mjs   （或 npm run talent:health）
 * 作用：读 .env 的 BRAINX_MYSQL_* 凭据，尝试连阿里云 RDS，打印后端类型 + 连通性
 *       + 建表状态。凭据只回显 host/库名，绝不打印密码。
 *
 * 典型结果：MySQL 连通且迁移完整才退出 0；未配置、断连、缺表或易失内存均退出 1。
 */
import '../src/env.js';
import { talentHealth } from '../src/talent.js';

const h = await talentHealth();
console.log(JSON.stringify(h, null, 2));

if (h.backend === 'mysql' && h.ready && h.schema === 'ready') {
  console.log('\n[OK] 已连接持久化 RDS 人才库，基础表与增量迁移均已就绪。');
  process.exitCode = 0;
} else {
  console.log(`\n[FAIL] 人才库未就绪：${h.error_code || h.degraded || 'VOLATILE_BACKEND'}`);
  console.log('  - 运行服务显式设置 BRAINX_TALENT_BACKEND=mysql 并提供最小权限凭据');
  console.log('  - 临时 DDL 账号只运行 npm run init-talent；应用账号不得建表');
  console.log('  - 检查 RDS 白名单、SSL、基础表和 talent_schema_migrations');
  process.exitCode = 1;
}

// 显式收尾：MySQL 连接池的 keepAlive 定时器会让事件循环不空、进程挂起。
// 关掉连接池后主动退出，避免 `npm run talent:health` 每次都要等到超时才结束。
try {
  const db = await import('../src/db.js');
  if (typeof db.closeMysql === 'function') await db.closeMysql();
} catch { /* 未创建连接池或连接已经失效时忽略 */ }
process.exit(process.exitCode ?? 0);

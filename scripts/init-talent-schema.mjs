#!/usr/bin/env node
/** init-talent-schema.mjs - 初始化基础表并执行人才库增量迁移。
 *
 * 用法：node scripts/init-talent-schema.mjs   （或 npm run init-talent）
 * 前置：
 *   1) npm install mysql2
 *   2) .env 填 BRAINX_MYSQL_USER / BRAINX_MYSQL_PASSWORD / BRAINX_MYSQL_DATABASE
 *   3) 本机公网 IP 加进阿里云 RDS 白名单（外网地址才生效）
 * 基础 7 表由 src/db.js 初始化，增量版本由 talent-migrations/ 按文件名记账。
 */
import '../src/env.js'; // 先加载 .env（副作用：填充 process.env，db.js 读凭据靠它）

let db;
try {
  db = await import('../src/db.js');
  await db.pingMysql();
  console.log('[OK] MySQL 连通');
  const n = await db.initTalentSchema();
  console.log(`[OK] 基础 ${n} 张表与增量迁移均已就绪（幂等，可重复跑）`);
} catch (e) {
  console.error('[FAIL] 建表失败：', e.message);
  console.error('  检查：npm install mysql2 装了没 / .env 凭据填了没 / 公网 IP 加白名单没');
  process.exitCode = 1;
} finally {
  if (db) await db.closeMysql().catch(() => {});
}

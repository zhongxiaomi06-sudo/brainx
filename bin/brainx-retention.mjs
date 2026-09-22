#!/usr/bin/env node
/** 旧 retention 兼容入口：写模式永久失败关闭；其余调用转到只读盘点。 */

if (process.argv.includes('--apply')) {
  console.error('[retention] RETENTION_APPLY_DISABLED');
  process.exit(2);
}

await import('./brainx-retention-inventory.mjs');

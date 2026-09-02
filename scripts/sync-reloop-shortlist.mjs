#!/usr/bin/env node
/** Import one existing reloop recommendation batch. Defaults to read-only dry run. */
import '../src/env.js';
import { closeMysql } from '../src/db.js';
import { syncReloopShortlist } from '../src/reloop-shortlist-sync.js';

const arg = (name, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

try {
  const out = await syncReloopShortlist({
    tenantId: arg('tenant'), consultantId: arg('consultant'),
    sourceOwnerId: arg('source-owner'), expectedBoundName: arg('bound-name'),
    positionId: arg('position'), limit: arg('limit', '10'),
    dryRun: !process.argv.includes('--apply'),
  });
  console.log(JSON.stringify(out, null, 2));
  if (out.dry_run) console.error('（只读预检；确认后加 --apply 才会写入授权 shortlist）');
} finally {
  await closeMysql();
}

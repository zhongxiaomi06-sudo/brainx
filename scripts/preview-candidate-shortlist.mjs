#!/usr/bin/env node
/** Render an authorized shortlist as fixed, Feishu-safe text; never sends. */
import '../src/env.js';
import { candidateShortlist } from '../src/candidate-shortlist.js';
import { formatCandidateShortlistMessage } from '../src/candidate-shortlist-message.js';
import { closeMysql } from '../src/db.js';

const arg = (name, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

try {
  const bundle = await candidateShortlist({ tenantId: arg('tenant'),
    consultantId: arg('consultant'), jobId: arg('job'), limit: Number(arg('limit', '3')) });
  console.log(formatCandidateShortlistMessage(bundle, { jobName: arg('job-name', arg('job')) }));
} finally {
  await closeMysql();
}

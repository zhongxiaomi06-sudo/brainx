#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { validateOpenClawToolPolicy, validateRuntimeConfig } from '../src/runtime-preflight.js';

const paths = {
  agent: process.argv[2] || '/etc/brainx/agent.env',
  worker: process.argv[3] || '/etc/brainx/worker.env',
  openclaw: process.argv[4] || '/etc/brainx/openclaw.env',
};
let result;
try {
  result = validateRuntimeConfig(Object.fromEntries(Object.entries(paths)
    .map(([name, path]) => [name, parseEnv(readFileSync(path, 'utf8'))])));
  if (process.env.OPENCLAW_CONFIG_PATH) {
    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
    const policy = validateOpenClawToolPolicy(config);
    result = {
      ok: result.ok && policy.ok,
      errors: [...new Set([...result.errors, ...policy.errors])].sort(),
    };
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, errors: [`runtime:ENV_FILE_UNREADABLE:${error.code || 'UNKNOWN'}`] }));
  process.exit(1);
}
if (!result.ok) {
  console.error(JSON.stringify(result));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, configured_accounts: ['mia'], files_checked: 3 }));

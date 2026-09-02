#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runShadowEvaluation } from '../src/talent-pipeline/evaluation.js';

const source = process.argv[2];
if (!source) throw new Error('EVALUATION_SET_PATH_REQUIRED');
const root = resolve(process.env.BRAINX_EVALUATION_ROOT || 'data/evaluations');
const path = resolve(source);
if (path !== root && !path.startsWith(`${root}/`)) throw new Error('EVALUATION_SET_OUTSIDE_ROOT');
const report = runShadowEvaluation(JSON.parse(await readFile(path, 'utf8')));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

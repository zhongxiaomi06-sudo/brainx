#!/usr/bin/env node
import '../src/env.js';
import { hostname } from 'node:os';
import { openDb } from '../src/db.js';
import { createJobRepository } from '../src/integration-jobs/repository.js';
import { runWorkerOnce } from '../src/integration-jobs/worker.js';
import { createProductionHandlers } from '../src/integration-jobs/production-handlers.js';

const db = openDb();
const repository = createJobRepository(db);
const workerId = `${hostname()}:${process.pid}`;
const handlers = createProductionHandlers();
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

while (!stopping) {
  const result = await runWorkerOnce({ repository, handlers, workerId });
  if (!result) await new Promise(resolve => setTimeout(resolve, 1_000));
}
db.close();

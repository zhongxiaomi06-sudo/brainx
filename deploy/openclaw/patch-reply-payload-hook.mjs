#!/usr/bin/env node
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_PACKAGE = 'openclaw';
const SUPPORTED_VERSION = '2026.7.1-2';
const MARKER = 'BRAINX_EXTERNAL_DISPATCH_REPLY_HOOK_V1';

export function patchExternalDispatcherReplyHook(source) {
  if (source.includes(MARKER)) return source;
  const before = `async function dispatchReplyFromConfig(params) {
\tconst { ctx, cfg, dispatcher } = params;`;
  const after = `async function dispatchReplyFromConfig(params) {
\tconst { ctx, cfg, dispatcher } = params;
\tinstallReplyPayloadSendingBeforeDeliver(dispatcher, ctx, { runId: params.replyOptions?.runId }); // ${MARKER}`;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error('dispatchReplyFromConfig: expected exactly one compatible source block');
  }
  return source.replace(before, after);
}

function findDispatchRuntime(openclawRoot) {
  const dist = join(openclawRoot, 'dist');
  const matches = readdirSync(dist)
    .filter((name) => /^dispatch-[A-Za-z0-9_-]+\.js$/.test(name) && !name.startsWith('dispatch-acp-'))
    .filter((name) => readFileSync(join(dist, name), 'utf8').includes('async function dispatchReplyFromConfig'));
  if (matches.length !== 1) throw new Error(`dispatch runtime: expected one file, found ${matches.length}`);
  return join(dist, matches[0]);
}

function atomicWrite(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.brainx-tmp`);
  const mode = statSync(path).mode;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

export function patchOpenClaw(openclawRoot, { write = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(openclawRoot, 'package.json'), 'utf8'));
  if (manifest.name !== SUPPORTED_PACKAGE || manifest.version !== SUPPORTED_VERSION) {
    throw new Error(`requires ${SUPPORTED_PACKAGE}@${SUPPORTED_VERSION}; found ${manifest.name}@${manifest.version}`);
  }
  const path = findDispatchRuntime(openclawRoot);
  const source = readFileSync(path, 'utf8');
  const patched = patchExternalDispatcherReplyHook(source);
  if (!patched.includes(MARKER)) throw new Error(`${basename(path)}: patch marker missing`);
  if (write && patched !== source) atomicWrite(path, patched);
  return { path, changed: patched !== source };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const root = process.argv[3];
  if (!['--apply', '--check'].includes(mode) || !root) {
    console.error('usage: node patch-reply-payload-hook.mjs --apply|--check <openclaw-package-root>');
    process.exit(64);
  }
  try {
    const result = patchOpenClaw(root, { write: mode === '--apply' });
    if (mode === '--check' && result.changed) throw new Error('BrainX reply payload hook bridge is not applied');
    console.log(`${MARKER}: ${mode === '--apply' ? 'ready' : 'verified'}`);
  } catch (error) {
    console.error(`BrainX OpenClaw reply hook bridge failed: ${error.message}`);
    process.exit(65);
  }
}

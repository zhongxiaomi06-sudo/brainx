#!/usr/bin/env node
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_PACKAGE = '@openclaw/feishu';
const SUPPORTED_VERSION = '2026.7.1';
const LEGACY_MARKER = 'BRAINX_FORM_VALUE_BRIDGE_V1';
const MARKER = 'BRAINX_FORM_VALUE_BRIDGE_V2';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one compatible source block`);
  }
  return source.replace(before, after);
}

export function patchCardActionParser(source) {
  if (source.includes(MARKER)) return source;
  if (source.includes(LEGACY_MARKER)) return source.replaceAll(LEGACY_MARKER, MARKER);
  let next = replaceOnce(source,
    'const actionValue = action.value;\n\tconst openMessageId =',
    `const actionValue = action.value;\n\tconst actionFormValue = action.form_value; // ${MARKER}\n\tconst openMessageId =`,
    'card action parser');
  next = replaceOnce(next,
    '\t\taction: {\n\t\t\tvalue: actionValue,\n\t\t\ttag\n\t\t},',
    '\t\taction: {\n\t\t\tvalue: actionValue,\n\t\t\ttag,\n\t\t\t...isRecord$1(actionFormValue) ? { form_value: actionFormValue } : {}\n\t\t},',
    'card action shape');
  return next;
}

export function patchCardActionFallback(source) {
  if (source.includes(MARKER)) return source;
  if (source.includes(LEGACY_MARKER)) {
    const legacy = `\t\tconst criteria = typeof formValue.criteria === "string" ? formValue.criteria.trim().slice(0, 2e3) : "";
\t\tif (!criteria) return text;
\t\treturn \`\${text}\\n\\n[BRAINTEX_CARD_FORM] \${JSON.stringify({ criteria })}\`; // ${LEGACY_MARKER}`;
    return replaceOnce(source, legacy, formProjectionSource(), 'legacy form bridge');
  }
  const before = `function buildFeishuCardActionTextFallback(event) {
\tconst actionValue = event.action.value;
\tif (isRecord$1(actionValue)) {
\t\tif (typeof actionValue.text === "string") return actionValue.text;
\t\tif (typeof actionValue.command === "string") return actionValue.command;
\t\treturn JSON.stringify(actionValue);
\t}
\treturn String(actionValue);
}`;
  const after = `function buildFeishuCardActionTextFallback(event) {
\tconst actionValue = event.action.value;
\tconst appendBrainxFormValue = (text) => {
\t\tif (!isRecord$1(actionValue) || actionValue.brainx_form !== true) return text;
\t\tconst formValue = event.action.form_value;
\t\tif (!isRecord$1(formValue)) return text;
${formProjectionSource()}
\t};
\tif (isRecord$1(actionValue)) {
\t\tif (typeof actionValue.text === "string") return appendBrainxFormValue(actionValue.text);
\t\tif (typeof actionValue.command === "string") return appendBrainxFormValue(actionValue.command);
\t\treturn JSON.stringify(actionValue);
\t}
\treturn String(actionValue);
}`;
  return replaceOnce(source, before, after, 'card action fallback');
}

function formProjectionSource() {
  return `\t\tconst submitted = {};
\t\tconst criteria = typeof formValue.criteria === "string" ? formValue.criteria.trim().slice(0, 2e3) : "";
\t\tconst jobId = typeof formValue.job_id === "string" ? formValue.job_id.trim().slice(0, 128) : "";
\t\tif (criteria) submitted.criteria = criteria;
\t\tif (jobId) submitted.job_id = jobId;
\t\tif (Object.keys(submitted).length === 0) return text;
\t\treturn \`\${text}\\n\\n[BRAINTEX_CARD_FORM] \${JSON.stringify(submitted)}\`; // ${MARKER}`;
}

function distFile(pluginRoot, prefix) {
  const matches = readdirSync(join(pluginRoot, 'dist'))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.js'));
  if (matches.length !== 1) throw new Error(`${prefix}: expected one dist file, found ${matches.length}`);
  return join(pluginRoot, 'dist', matches[0]);
}

function atomicWrite(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.brainx-tmp`);
  const mode = statSync(path).mode;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

export function patchFeishuPlugin(pluginRoot, { write = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
  if (manifest.name !== SUPPORTED_PACKAGE || manifest.version !== SUPPORTED_VERSION) {
    throw new Error(`requires ${SUPPORTED_PACKAGE}@${SUPPORTED_VERSION}; found ${manifest.name}@${manifest.version}`);
  }
  const targets = [
    [distFile(pluginRoot, 'monitor.account-'), patchCardActionParser],
    [distFile(pluginRoot, 'send-result-'), patchCardActionFallback],
  ];
  const results = targets.map(([path, patch]) => {
    const source = readFileSync(path, 'utf8');
    const patched = patch(source);
    if (!patched.includes(MARKER)) throw new Error(`${basename(path)}: patch marker missing`);
    if (write && patched !== source) atomicWrite(path, patched);
    return { path, changed: patched !== source };
  });
  return results;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const root = process.argv[3];
  if (!['--apply', '--check'].includes(mode) || !root) {
    console.error('usage: node patch-feishu-form.mjs --apply|--check <feishu-plugin-root>');
    process.exit(64);
  }
  try {
    const results = patchFeishuPlugin(root, { write: mode === '--apply' });
    if (mode === '--check' && results.some((entry) => entry.changed)) {
      throw new Error('BrainX form bridge is not applied');
    }
    console.log(`${MARKER}: ${mode === '--apply' ? 'ready' : 'verified'}`);
  } catch (error) {
    console.error(`BrainX Feishu form bridge failed: ${error.message}`);
    process.exit(65);
  }
}

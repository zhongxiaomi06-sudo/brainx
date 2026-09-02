import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);
const INJECTION = /(ignore\s+(all\s+)?previous|system\s+prompt|忽略.{0,8}(指令|规则)|你现在是)/i;

export function classifyExtraction({ sourceFormat, text, parserVersion }) {
  if (!['pdf', 'docx'].includes(sourceFormat)) throw new Error('DOCUMENT_FORMAT_UNSUPPORTED');
  const normalized = String(text || '').trim();
  if (!normalized) return { status: 'OCR_REQUIRED', text: '', parser_version: parserVersion, warnings: [] };
  return {
    status: 'EXTRACTED', text: normalized, parser_version: parserVersion,
    warnings: INJECTION.test(normalized) ? ['PROMPT_INJECTION_SUSPECTED'] : [],
  };
}

export async function extractDocument(input, options = {}) {
  const root = resolve(options.stagingRoot || process.env.BRAINX_DOCUMENT_STAGING_ROOT || 'data/document-staging');
  const path = resolve(root, input.documentRef);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('DOCUMENT_REF_INVALID');
  const run = options.run || execFileAsync;
  const parser = options.parserPath || resolve('parser/parse_document.py');
  const { stdout } = await run(options.python || 'python3',
    [parser, '--input', path, '--root', root], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  return classifyExtraction({ sourceFormat: input.sourceFormat, text: parsed.text, parserVersion: parsed.parser_version });
}

export async function processCandidateDocument(input, options = {}) {
  const extraction = await extractDocument(input, options);
  if (extraction.status !== 'EXTRACTED') return extraction;
  const fact = await options.structure({
    schema_version: 'candidate_fact_v1',
    trust: 'UNTRUSTED_DOCUMENT_DATA',
    untrusted_text: extraction.text,
  });
  if (!fact || fact.schema_version !== 'candidate_fact_v1' || !fact.fact_version_id || !Array.isArray(fact.evidence)) {
    return { ...extraction, status: 'NEEDS_REVIEW', error_code: 'FACT_SCHEMA_INVALID' };
  }
  return { status: 'READY', parser_version: extraction.parser_version, warnings: extraction.warnings, fact };
}

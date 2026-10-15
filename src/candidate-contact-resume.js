/** 本人 TTC 简历联系方式：只读一次附件列表，最多解析三份 PDF，文件始终在内存。 */
import { spawn } from 'node:child_process';
import { listTtcResumeAttachments, downloadTtcResumePdf } from './ttcsdk/resume.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d{9})(?!\d)/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function extractResumeContact(text) {
  const body = String(text || '').slice(0, 2_000_000);
  return { phone: body.match(PHONE)?.[1] || null, email: body.match(EMAIL)?.[0] || null };
}

// 异步子进程版：execFileSync 最长会同步阻塞事件循环 12s×3 份，整个网关期间无响应（PR#78 审查追认项）。
export function pdfTextInMemory(bytes, { timeoutMs = 12_000, maxChars = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let reason = 'PDFTOTEXT_TIMEOUT';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (fn, value) => { clearTimeout(timer); fn(value); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > maxChars) { reason = 'PDFTOTEXT_OVERFLOW'; child.kill('SIGKILL'); }
    });
    child.stderr.resume(); // 排空 stderr，避免背压挂起；内容不进任何日志。
    child.on('error', (error) => finish(reject, error)); // 例如 ENOENT：生产缺 pdftotext。
    child.on('close', (code, signal) => {
      if (signal) return finish(reject, new Error(reason === 'PDFTOTEXT_OVERFLOW' ? reason : 'PDFTOTEXT_KILLED'));
      if (code !== 0) return finish(reject, new Error(`PDFTOTEXT_EXIT_${code}`));
      finish(resolve, out);
    });
    child.stdin.on('error', () => {}); // 子进程早退导致 EPIPE 时由 close 统一裁决。
    child.stdin.end(bytes);
  });
}

export async function readTtcResumeContact(candidateRef, jwt, deps = {}) {
  const list = deps.listResumeFn || listTtcResumeAttachments;
  const download = deps.downloadResumeFn || downloadTtcResumePdf;
  const pdfText = deps.pdfTextFn || pdfTextInMemory;
  const attachments = await list(candidateRef, jwt);
  if (!attachments.length) return { status: 'no_resume' };
  const pdfs = attachments.filter((item) => /\.pdf(?:$|[?#])/i.test(item.name || item.url));
  if (!pdfs.length) return { status: 'no_contact' }; // 图片附件不能当作没有简历。
  let failed = false;
  for (const attachment of pdfs.slice(0, 3)) {
    try {
      const bytes = await download(attachment.url, jwt);
      const found = extractResumeContact(await pdfText(bytes));
      if (found.phone || found.email) return { status: 'found', ...found,
        source: 'ttc_resume', attachmentId: attachment.attachmentId || null };
    } catch (error) {
      if (error?.authInvalid || error?.status === 401 || error?.status === 403) throw error;
      failed = true;
    }
  }
  // TTC 列表只返回前十份；超过预算或有下载失败时不能宣称“全部没有”。
  return { status: failed || pdfs.length > 3 || attachments.length >= 10 ? 'fetch_failed' : 'no_contact' };
}

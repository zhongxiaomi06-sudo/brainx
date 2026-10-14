/** 本人 TTC 简历联系方式：只读一次附件列表，最多解析三份 PDF，文件始终在内存。 */
import { execFileSync } from 'node:child_process';
import { listTtcResumeAttachments, downloadTtcResumePdf } from './ttcsdk/resume.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d{9})(?!\d)/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function extractResumeContact(text) {
  const body = String(text || '').slice(0, 2_000_000);
  return { phone: body.match(PHONE)?.[1] || null, email: body.match(EMAIL)?.[0] || null };
}

export function pdfTextInMemory(bytes) {
  return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], {
    input: bytes, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 12_000,
    stdio: ['pipe', 'pipe', 'pipe'],
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

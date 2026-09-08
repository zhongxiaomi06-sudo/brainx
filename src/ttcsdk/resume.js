/** TTC 人才库简历附件：只在用户明确点击后读取，并把凭据限制在 TTC API 首跳。 */
import { ttcRequest } from './http.js';

const MAX_RESUME_BYTES = 12 * 1024 * 1024;
const CANDIDATE_REF = /^[A-Za-z0-9:_-]{1,100}$/;
const TTC_API_HOSTS = new Set(['api.ttcadvisory.com']);
const TTC_FILE_HOSTS = new Set(['res.ttcadvisory.com']);

export async function listTtcResumeAttachments(candidateRef, jwt, fetchImpl = globalThis.fetch) {
  if (!CANDIDATE_REF.test(String(candidateRef || ''))) throw new Error('RESUME_CANDIDATE_REF_INVALID');
  const data = await ttcRequest(jwt, 'POST',
    '/api/talent_store/v1/person_leads/resume/attachment/list',
    { person_leads_id: candidateRef }, fetchImpl);
  const items = data?.attachment_items || data?.data?.attachment_items || [];
  if (!Array.isArray(items)) return [];
  return items.slice(0, 10).map((item) => ({
    attachmentId: String(item?.attachment_id || '').slice(0, 100),
    name: String(item?.name || '候选人简历.pdf').slice(0, 180),
    url: typeof item?.preview_url === 'string' && item.preview_url
      ? item.preview_url : typeof item?.link === 'string' ? item.link : '',
  })).filter((item) => item.url);
}

function parseTrustedUrl(value, hosts, errorCode) {
  let target;
  try { target = new URL(value); } catch { throw new Error(errorCode); }
  if (target.protocol !== 'https:' || !hosts.has(target.hostname.toLowerCase())) {
    throw new Error(errorCode);
  }
  return target;
}

async function checkedPdf(response) {
  if (!response.ok) throw new Error('RESUME_DOWNLOAD_FAILED');
  const announced = Number(response.headers?.get?.('content-length') || 0);
  if (announced > MAX_RESUME_BYTES) throw new Error('RESUME_PDF_TOO_LARGE');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESUME_BYTES) throw new Error('RESUME_PDF_TOO_LARGE');
  if (!bytes.subarray(0, Math.min(1024, bytes.length)).includes(Buffer.from('%PDF-'))) {
    throw new Error('RESUME_PDF_INVALID');
  }
  return bytes;
}

/** TTC preview_url 会 302 到独立文件域；第二跳绝不携带 TTC Bearer。 */
export async function downloadTtcResumePdf(url, jwt, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let initial;
  try { initial = new URL(url); } catch { throw new Error('RESUME_URL_NOT_TRUSTED'); }
  if (initial.protocol === 'https:' && TTC_FILE_HOSTS.has(initial.hostname.toLowerCase())) {
    return checkedPdf(await fetchImpl(initial, {
      headers: { Accept: 'application/pdf' },
      signal: AbortSignal.timeout(options.timeoutMs || 30_000), redirect: 'error',
    }));
  }
  const apiUrl = parseTrustedUrl(url, TTC_API_HOSTS, 'RESUME_URL_NOT_TRUSTED');
  const first = await fetchImpl(apiUrl, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/pdf' },
    signal: AbortSignal.timeout(options.timeoutMs || 30_000), redirect: 'manual',
  });
  if (first.ok) return checkedPdf(first);
  if (first.status < 300 || first.status >= 400) throw new Error('RESUME_DOWNLOAD_FAILED');
  const location = first.headers?.get?.('location');
  const fileUrl = parseTrustedUrl(location, TTC_FILE_HOSTS, 'RESUME_REDIRECT_NOT_TRUSTED');
  const second = await fetchImpl(fileUrl, {
    headers: { Accept: 'application/pdf' },
    signal: AbortSignal.timeout(options.timeoutMs || 30_000), redirect: 'error',
  });
  return checkedPdf(second);
}

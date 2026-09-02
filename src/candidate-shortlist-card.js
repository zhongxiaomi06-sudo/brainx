/** Render reviewed Agent analysis inside a fixed, privacy-safe Feishu card. */

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function safeText(value, max, errorCode) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(errorCode);
  if (PHONE.test(text) || EMAIL.test(text)) throw new Error('SENSITIVE_DATA');
  return text;
}

function safeWebUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid');
    return url.href;
  } catch {
    throw new Error('WEB_URL_INVALID');
  }
}

export function buildCandidateShortlistCard({
  jobName,
  analysisMarkdown,
  webUrl,
  sourceLabel = '授权后的结构化事实 · Agent 分析',
}) {
  const name = safeText(jobName, 120, 'JOB_NAME_INVALID');
  const content = safeText(analysisMarkdown, 8_000, 'ANALYSIS_INVALID');
  const source = safeText(sourceLabel, 200, 'SOURCE_LABEL_INVALID');
  const target = safeWebUrl(webUrl);
  const multiUrl = { url: target, pc_url: target, android_url: target, ios_url: target };
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `Brain X · ${name}` } },
    elements: [
      { tag: 'markdown', content },
      { tag: 'action', actions: [{
        tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '打开 BrainX 查询' },
        multi_url: multiUrl,
      }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `${source} · 不含联系方式与简历原文` }] },
    ],
  };
}

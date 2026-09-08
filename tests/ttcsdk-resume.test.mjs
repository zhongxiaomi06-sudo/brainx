import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadTtcResumePdf, listTtcResumeAttachments } from '../src/ttcsdk/resume.js';

test('TTC 简历列表使用人才编号并规范化附件', async () => {
  let request;
  const attachments = await listTtcResumeAttachments('PL123', 'secret-jwt', async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ code: 0, data: { attachment_items: [
      { attachment_id: 'A1', name: '候选人.pdf', preview_url: 'https://api.ttcadvisory.com/preview/1' },
      { attachment_id: 'A2', name: '空链接' },
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.match(request.url, /resume\/attachment\/list$/);
  assert.equal(request.options.headers.Authorization, 'Bearer secret-jwt');
  assert.deepEqual(JSON.parse(request.options.body), { person_leads_id: 'PL123' });
  assert.deepEqual(attachments, [{ attachmentId: 'A1', name: '候选人.pdf',
    url: 'https://api.ttcadvisory.com/preview/1' }]);
});

test('TTC 简历下载只在 API 首跳携带凭据，并校验 PDF', async () => {
  const calls = [];
  const bytes = await downloadTtcResumePdf('https://api.ttcadvisory.com/preview/1', 'secret-jwt', {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return new Response(null, { status: 302,
        headers: { location: 'https://res.ttcadvisory.com/files/candidate.pdf' } });
      return new Response(Buffer.from('%PDF-1.7 real resume'), {
        status: 200, headers: { 'content-type': 'application/pdf' },
      });
    },
  });
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-jwt');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.redirect, 'error');
});

test('TTC 已给出官方文件域直链时不携带 Bearer', async () => {
  let request;
  const bytes = await downloadTtcResumePdf('https://res.ttcadvisory.com/files/direct.pdf', 'secret-jwt', {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(Buffer.from('%PDF-1.7 direct'), { status: 200 });
    },
  });
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(request.options.headers.Authorization, undefined);
});

test('TTC 简历下载拒绝非官方入口、非官方跳转和伪 PDF', async () => {
  await assert.rejects(downloadTtcResumePdf('https://evil.example/preview', 'jwt'),
    /RESUME_URL_NOT_TRUSTED/);
  await assert.rejects(downloadTtcResumePdf('https://api.ttcadvisory.com/preview', 'jwt', {
    fetchImpl: async () => new Response(null, { status: 302,
      headers: { location: 'https://evil.example/file.pdf' } }),
  }), /RESUME_REDIRECT_NOT_TRUSTED/);
  await assert.rejects(downloadTtcResumePdf('https://api.ttcadvisory.com/preview', 'jwt', {
    fetchImpl: async () => new Response('not-a-pdf', { status: 200 }),
  }), /RESUME_PDF_INVALID/);
});

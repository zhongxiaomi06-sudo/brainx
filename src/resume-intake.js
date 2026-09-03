/** resume-intake.js — 飞书简历文件入口（2026-09-03，PDF/DOCX 入口 + 解析 worker）。
 *
 * 链路：群/私聊里的文件消息（im file/media）→ lark 下载（消息发送者本人的用户令牌，
 * 与 bridge 消息通道同一授权边界——只能读该顾问所在群的附件）→ 转文本
 * （pdf=pdftotext、docx=python zipfile 零依赖、doc=antiword）→ resume.js 解析 →
 * talent.ingestResume 入库 → 事件留痕（不入账决策，只写 resume_intake_log 台账）。
 *
 * 游标复用 bridge_cursor（source=resume_intake@{chat_id}），每次从上次位置增量扫。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now } from './db.js';
import { getValidAccessToken, feishuGet } from './feishu.js';
import { ingestResume } from './talent.js';
import { listConsultants } from './roster.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SUPPORTED = { '.pdf': 'pdf', '.docx': 'docx', '.doc': 'doc' };

function ensureLogTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS resume_intake_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    sender_open_id TEXT,
    file_name TEXT NOT NULL,
    talent_id INTEGER,
    status TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_resume_intake_msg ON resume_intake_log(message_id, file_name)`);
}

/** 文件 → 纯文本（零依赖优先；转换器不可用时明确报 UNSUPPORTED_CONVERTER）。 */
export function fileToText(filePath, kind) {
  if (kind === 'pdf') return execFileSync('pdftotext', ['-enc', 'UTF-8', filePath, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
  if (kind === 'doc') return execFileSync('antiword', ['-m', 'UTF-8', filePath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
  if (kind === 'docx') {
    // docx=zip：document.xml 去标签即正文（python 标准库零依赖）
    const script = `import zipfile,re,sys
with zipfile.ZipFile(sys.argv[1]) as z:
    xml=z.read('word/document.xml').decode('utf-8','ignore')
xml=re.sub(r'</w:p>','\\n',xml)
xml=re.sub(r'<[^>]+>','',xml)
import html
print(html.unescape(xml))`;
    return execFileSync('python3', ['-c', script, filePath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
  }
  throw new Error(`UNSUPPORTED_CONVERTER:${kind}`);
}

async function downloadResource({ messageId, fileKey, type, token, fetchImpl }) {
  const path = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`;
  const base = 'https://open.feishu.cn/open-apis';
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/open-apis') ? path.slice('/open-apis'.length) : path}`;
  const resp = await fetchImpl(`${base}${path.slice('/open-apis'.length)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/** 扫一位顾问可见群的新文件消息并入库。chat_ids 为空时扫其全部在册群。 */
export async function intakeRecentFiles(db, consultantId, { chatIds = null, limit = 50, fetchImpl = fetch, reply = null } = {}) {
  ensureLogTable(db);
  const token = await getValidAccessToken(db, consultantId, fetchImpl);
  if (!token) return { consultant_id: consultantId, skipped: 'no_token', ingested: 0 };
  const chats = chatIds || db.prepare(`SELECT chat_id FROM consultant_chats WHERE consultant_id=?`).all(consultantId).map((r) => r.chat_id);
  const out = { consultant_id: consultantId, chats: chats.length, ingested: 0, files: [] };
  for (const chatId of chats) {
    const key = `resume_intake@${chatId}`;
    const cur = db.prepare('SELECT checkpoint FROM bridge_cursor WHERE source=?').get(key);
    const d = await feishuGet(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/messages?page_size=${Math.min(limit, 50)}&sort_type=ByCreateTimeDesc`, token, fetchImpl).catch(() => null);
    const msgs = d?.items || [];
    let maxTs = cur?.checkpoint || '';
    for (const m of msgs) {
      const ts = m.create_time ? new Date(Number(m.create_time)).toISOString() : '';
      if (cur && ts && ts <= cur.checkpoint) continue;
      if (ts && ts > maxTs) maxTs = ts;
      const body = (() => { try { return JSON.parse(m.body?.content || '{}'); } catch { return {}; } })();
      const fileKey = body.file_key || body.file?.file_key;
      const fileName = body.file_name || body.file?.file_name || 'resume.bin';
      const ext = `.${String(fileName).split('.').pop().toLowerCase()}`;
      if (!fileKey || !SUPPORTED[ext]) continue;
      const type = m.msg_type === 'media' ? 'image' : 'file';
      const logIns = db.prepare(`INSERT OR IGNORE INTO resume_intake_log
        (message_id, chat_id, sender_open_id, file_name, status, created_at) VALUES (?,?,?,?,?,?)`);
      const logged = logIns.run(m.message_id, chatId, m.sender?.id || null, fileName, 'SEEN', now());
      if (logged.changes === 0) continue; // 已处理过
      const dir = mkdtempSync(join(tmpdir(), 'resume-'));
      try {
        const buf = await downloadResource({ messageId: m.message_id, fileKey, type, token, fetchImpl });
        if (buf.length > MAX_FILE_BYTES) throw new Error('文件超过 20MB 上限');
        const fp = join(dir, fileName);
        writeFileSync(fp, buf);
        const text = fileToText(fp, SUPPORTED[ext]);
        if (!text || text.trim().length < 50) throw new Error('转换后文本过短（疑扫描件，需 OCR——暂不支持）');
        const ing = await ingestResume(text, { fileName, createdBy: `feishu:${consultantId}` });
        db.prepare(`UPDATE resume_intake_log SET status=?, talent_id=?, detail=? WHERE message_id=? AND file_name=?`)
          .run('INGESTED', ing.talentId || ing.id || null, null, m.message_id, fileName);
        out.ingested += 1;
        out.files.push({ file_name: fileName, talent_id: ing.talentId || ing.id, chat_id: chatId });
        reply?.({ chatId, text: `已解析简历「${fileName}」并入库（人才 #${ing.talentId || ing.id}）` });
      } catch (e) {
        db.prepare(`UPDATE resume_intake_log SET status=?, detail=? WHERE message_id=? AND file_name=?`)
          .run('FAILED', String(e.message || e).slice(0, 300), m.message_id, fileName);
        out.files.push({ file_name: fileName, error: String(e.message || e).slice(0, 120) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    db.prepare(`INSERT INTO bridge_cursor (source, checkpoint, updated_at) VALUES (?,?,?)
      ON CONFLICT(source) DO UPDATE SET checkpoint=excluded.checkpoint, updated_at=excluded.updated_at`)
      .run(key, maxTs || now(), now());
  }
  return out;
}

/** 全顾问一轮（worker 周期调用）。 */
export async function intakeAllConsultants(db, opts = {}) {
  const results = [];
  for (const c of listConsultants(db)) {
    try { results.push(await intakeRecentFiles(db, c.consultant_id, opts)); }
    catch (e) { results.push({ consultant_id: c.consultant_id, error: String(e.message || e).slice(0, 120) }); }
  }
  return { at: now(), results, ingested: results.reduce((s, r) => s + (r.ingested || 0), 0) };
}

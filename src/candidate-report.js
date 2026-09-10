/** 候选人 Offer 决策报告：从候选事实、来源摘要和当前决策群消息生成可追溯飞书文档。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { listProjectCandidateFocus } from './candidate-focus.js';
import { createFeishuDocument } from './feishu-document.js';
import { sendInteractiveCard } from './feishu-bot.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function safe(value, max = 1200) {
  const text = String(value || '').replace(PHONE, '[联系方式已隐藏]').replace(EMAIL, '[联系方式已隐藏]')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function groupMessages(db, chatId) {
  return db.prepare(`SELECT text,create_time FROM lark_messages
    WHERE chat_id=? AND text IS NOT NULL ORDER BY create_time DESC LIMIT 60`).all(chatId)
    .reverse().map((row) => ({ text: safe(row.text, 600), create_time: row.create_time })).filter((row) => row.text);
}

function sectionsFor(job, candidate, decisionGroup, messages, version) {
  const evidence = messages.length
    ? messages.map((row) => `${safe(row.create_time, 40)}｜${row.text}`)
    : ['当前决策群尚无已记录的新讨论。'];
  return [
    { title: '一、决策摘要', paragraphs: [
      `候选人：${safe(candidate.name || candidate.candidate_ref, 100)}；目标岗位：${safe(job.role, 160)}；项目：${safe(job.company, 120)}（${safe(job.project_id, 80)}）。`,
      `当前结论：待团队结合以下证据决定继续评估、进入面试、准备 Offer 或不推进。报告版本：V${version}。`,
    ] },
    { title: '二、候选人事实', paragraphs: [
      `当前岗位：${safe(candidate.role || '待核实', 160)}。经验 / 城市 / 学历：${safe([candidate.experience, candidate.city, candidate.education].filter(Boolean).join(' / ') || '待核实', 240)}。`,
      `原轮次匹配度：${safe(candidate.score || '待核实', 40)}。项目匹配评估：${safe(candidate.evaluation || '待核实', 900)}。`,
    ] },
    { title: '三、来源项目群上下文', paragraphs: [safe(decisionGroup.context_summary, 1800)] },
    { title: '四、本决策群新增证据', paragraphs: evidence },
    { title: '五、Offer 决策检查', paragraphs: [
      '能力与项目证据：以候选事实和群内讨论为准，缺口继续核实。',
      '求职动机、薪酬预期、到岗时间、竞对 Offer、稳定性与背调风险：未在证据中明确的项目一律标记为待确认。',
      '建议下一步：明确负责人、验证关键风险，并在获得新材料或电话纪要后使用 /report 更新本报告。',
    ] },
    { title: '六、证据边界', paragraphs: [
      '本报告只汇总 BrainX 已授权并已记录的候选事实与群消息；不会将缺失信息推断成事实。联系方式与邮箱已隐藏，简历原文不写入报告。',
    ] },
  ];
}

function readyCard(candidate, report) {
  const url = new URL(report.document_url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.feishu.cn')) fail('FEISHU_DOC_URL_INVALID');
  return { config: { wide_screen_mode: true },
    header: { template: 'purple', title: { tag: 'plain_text', content: `BrainTex · Offer 决策报告 V${report.version}` } },
    elements: [
      { tag: 'markdown', content: `**${safe(candidate.name || candidate.candidate_ref, 100)}**\n已汇总候选事实、来源项目群上下文和本群最新讨论。` },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '打开飞书报告' },
        multi_url: { url: url.toString(), pc_url: url.toString(), android_url: url.toString(), ios_url: url.toString() } }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '后续有新讨论或电话纪要时，发送 /report 即可生成新版本。' }] },
    ] };
}

export function createCandidateReportToolHandlers({ db, createDocumentFn = createFeishuDocument,
  sendInteractiveCardFn = sendInteractiveCard } = {}) {
  return { brainx_candidate_report: async (args, context) => {
    if (args.confirm !== true || context.principal.chatType !== 'group') fail('INVALID_ARGUMENT');
    const group = db.prepare(`SELECT * FROM candidate_decision_groups
      WHERE tenant_id=? AND target_chat_id=? AND status='READY' LIMIT 2`)
      .all(context.principal.tenantId, context.principal.chatId);
    if (group.length !== 1) fail('NOT_FOUND_OR_FORBIDDEN');
    const decisionGroup = group[0];
    const candidate = listProjectCandidateFocus(db, context.principal.tenantId, decisionGroup.position_id)
      .find((item) => item.candidate_ref === decisionGroup.candidate_ref);
    const job = db.prepare('SELECT project_id,company,role FROM job_facts WHERE project_id=?')
      .get(decisionGroup.position_id);
    if (!candidate || !job) fail('NOT_FOUND_OR_FORBIDDEN');
    const version = (db.prepare('SELECT MAX(version) version FROM candidate_reports WHERE decision_group_id=?')
      .get(decisionGroup.decision_group_id).version || 0) + 1;
    const reportId = randomUUID();
    const at = now();
    const messages = groupMessages(db, decisionGroup.target_chat_id);
    db.prepare(`INSERT INTO candidate_reports
      (report_id,decision_group_id,tenant_id,position_id,candidate_ref,version,source_message_count,
       status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'CREATING',?,?,?)`)
      .run(reportId, decisionGroup.decision_group_id, context.principal.tenantId,
        decisionGroup.position_id, decisionGroup.candidate_ref, version, messages.length,
        context.principal.consultantId, at, at);
    try {
      const document = await createDocumentFn({
        title: `${candidate.name || candidate.candidate_ref} × ${job.role} Offer 决策报告 V${version}`,
        sections: sectionsFor(job, candidate, decisionGroup, messages, version),
      });
      db.prepare(`UPDATE candidate_reports SET status='READY',document_id=?,document_url=?,updated_at=?
        WHERE report_id=?`).run(document.document_id, document.document_url, now(), reportId);
      const report = { ...document, version };
      await sendInteractiveCardFn({ target: context.principal.chatId, card: readyCard(candidate, report),
        idempotencyKey: `candidate-report-${reportId}` });
      return { data: { report_id: reportId, version, document_url: document.document_url,
        source_message_count: messages.length }, facts: [{ candidate_ref: candidate.candidate_ref,
        report_version: version }], inferences: [], recommendations: [], unknowns: [],
      evidence_refs: [`candidate_report:${reportId}`], next_allowed_actions: ['brainx_candidate_report'] };
    } catch (error) {
      db.prepare(`UPDATE candidate_reports SET status='FAILED',error_code=?,error_message=?,updated_at=?
        WHERE report_id=?`).run(error.code || 'CANDIDATE_REPORT_FAILED', safe(error.message, 240), now(), reportId);
      throw error;
    }
  } };
}

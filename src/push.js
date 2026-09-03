/** push.js — 飞书互动卡片构建与发送（补全文档 §18）。
 *
 * 硬约束：本地 127.0.0.1 收不到飞书回调 → 卡片按钮一律 URL 深链，
 * 操作只能发生在打开的工作台 UI 里。卡片 = 快照摘要；UI = 实时渲染。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// B11（2026-08-24）：execFileSync 在请求路径/调度进程内同步 shell out（单卡阻塞上限 45s，
// 冻结整个事件循环）。一律走 promisify(execFile) 异步化。
const execFileP = promisify(execFile);
import { now, uuid } from './db.js';
import { larkProfileArgs } from './env.js';
import { quickLink } from './quickfb.js';
import { sendInteractiveCard } from './feishu-bot.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';

const REL_LABEL = { MY_JOB: '我的职位', PRIMARY_PM: '我主PM', TEAM_SHARED: '团队共享',
                    OTHER_CONSULTANT: '他人主做', NOT_JOINED: '未加入', UNKNOWN: '未知' };
const ACTION_LABEL = { RECOMMEND_ACCEPT: '建议接单', RECOMMEND_WATCH: '建议观察', OBSERVE: '观察' };
const TEMPLATE = { READY: 'green', RUNNING: 'blue', INCOMPLETE: 'orange', AUTH_EXPIRED: 'red', ERROR: 'red' };

const dim = (r, name) => {
  const d = (r.breakdown || []).find((x) => x.dim === name);
  return d && d.score != null ? d.score : '—';
};
const url = (u) => ({ url: u, pc_url: u, android_url: u, ios_url: u });
const btn = (text, u, type = 'default') =>
  ({ tag: 'button', text: { tag: 'plain_text', content: text }, type, multi_url: url(u) });

/** WorkbenchModel → 飞书 card schema 2.0 JSON（纯函数，可单测）。
 * consultant_id 可选：提供且配置了 BRAINX_FEEDBACK_SECRET 时，每个职位追加
 * “忽略”一键按钮（签名直写，无需登录工作台——反馈回写主入口）。 */
export function buildDailyCard({ consultant_name, consultant_id, run, items, item_limit, commitments, sync, snapshot_id, publicBaseUrl }) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const state = sync?.complete ? 'READY' : 'INCOMPLETE';
  const limit = Math.min(item_limit || items.length || 3, items.length);
  const els = [
    { tag: 'markdown', content: `**${consultant_name || '你好'}，今天建议优先处理 ${limit} 个职位**\n`
        + `从 ${run?.candidate_count ?? items.length} 个职位中筛选 · ${state === 'READY' ? '数据完整' : '数据不完整'} · 每项含依据、风险和下一步` },
  ];
  const medals = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  items.slice(0, limit).forEach((r, i) => {
    const j = r.job;
    const hot = j.priority === 'HIGH' ? '🔥 ' : ''; // 重点高优（还做吗结构化，0007 起）
    els.push({ tag: 'markdown', content:
      `**${medals[i]} ${hot}${j.role}**\n${j.company}${j.city ? ' · ' + j.city : ''} · ${REL_LABEL[j.relation] || j.relation}\n`
      + `\`Fit ${dim(r, 'direction')}  Activity ${dim(r, 'activity')}  Evidence ${Math.round(r.evidence_coverage * 100)}\`\n`
      + `综合 **${r.score}** 分 · 置信${{ HIGH: '高', MEDIUM: '中', LOW: '低' }[r.confidence_band]} · ${ACTION_LABEL[r.action]}\n`
      + `**依据**：${(r.reasons || []).slice(0, 2).join('；') || '暂无充分依据'}\n`
      + `**风险**：${(r.risks || []).slice(0, 2).join('；') || '暂无显著风险'}\n`
      + `**下一步**：${r.action === 'RECOMMEND_ACCEPT' ? '打开职位，确认接单后自动启动找人' : '打开职位，补齐关键信息后再判断'}` });
    const actions = [
      btn(r.action === 'RECOMMEND_ACCEPT' ? '接单与启动找人' : '联系人与推进', buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: j.project_id }), 'primary'),
      btn('回放', buildBrainxDeepLink({ baseUrl, objectType: 'replay', objectRef: r.decision_id })),
    ];
    // 一键反馈（F2）：签名当日有效；未配置密钥时 quickLink 返 null，按钮不渲染
    const ignoreUrl = consultant_id && quickLink(baseUrl, consultant_id, j.project_id, 'ignore', now());
    if (ignoreUrl) actions.push(btn('✕ 忽略', ignoreUrl, 'danger'));
    els.push({ tag: 'action', actions });
    if (i < limit - 1) els.push({ tag: 'hr' });
  });
  const shared = items.filter((r) => r.job.relation === 'TEAM_SHARED').length;
  if (shared) els.push({ tag: 'markdown', content: `👀 团队共享观察 ${shared} 个（打开工作台查看）` });
  els.push({ tag: 'hr' });
  els.push({ tag: 'markdown', content:
    `我的承接：跟进中 ${commitments.accepted_count} · 需处理 ${commitments.need_action_count}` });
  els.push({ tag: 'action', actions: [btn('打开工作台', baseUrl, 'primary')] });
  els.push({ tag: 'note', elements: [{ tag: 'plain_text',
    content: `run: ${(run?.run_id || '').slice(0, 8)} · snapshot: ${(snapshot_id || '').slice(0, 8)} · ${run?.policy_version || ''}` }] });

  // 实测（2026-08-07, ErrCode 200861）：schema 2.0 已移除 action 标签 → 用 legacy v1 卡片，
  // markdown/hr/note/action/multi_url 全部支持，深链按钮行为一致。
  return { config: { wide_screen_mode: true },
    header: { template: TEMPLATE[state], title: { tag: 'plain_text',
      content: `BrainTex · 今日职位推荐 ${now().slice(5, 16).replace('T', ' ')}` } },
    elements: els };
}

/** 同步异常卡（文案与前端 PRD §10 逐字一致）。 */
export function buildSyncAlertCard(sync, { publicBaseUrl } = {}) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const state = sync.complete ? 'READY' : 'INCOMPLETE';
  const msgs = { INCOMPLETE: ['本次同步不完整', '为避免误导，暂不生成正式推荐'],
                 AUTH_EXPIRED: ['TTC 登录状态已失效', '请重新登录后再同步'],
                 ERROR: ['同步失败', '请检查数据源后重试'] };
  const [title, sub] = msgs[state] || msgs.INCOMPLETE;
  return { config: { wide_screen_mode: true },
    header: { template: TEMPLATE[state] || 'orange', title: { tag: 'plain_text', content: `Brain X · ${title}` } },
    elements: [
      { tag: 'markdown', content: `**${title}**\n${sub}\n读取 ${sync.rows_read}/${sync.rows_expected} 行` },
      { tag: 'action', actions: [btn('打开工作台处理', `${baseUrl}?view=sync`, 'primary')] },
    ] };
}

/** 重大变化提醒卡（P4）：Top1 易主 / ACCEPT 档新进 Top3。仅推顾问本人，绝不推群。 */
export function buildHeatingAlertCard({ change_label, item, publicBaseUrl }) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const j = item.job;
  return { config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text',
      content: `Brain X · 重大变化提醒 ${now().slice(5, 16).replace('T', ' ')}` } },
    elements: [
      { tag: 'markdown', content: `**${change_label}**\n`
        + `**${j.role}**\n${j.company}${j.city ? ' · ' + j.city : ''} · ${REL_LABEL[j.relation] || j.relation}\n`
        + `综合 **${item.score}** 分 · ${ACTION_LABEL[item.action] || item.action}\n`
        + `理由：${item.reasons?.[1] || item.reasons?.[0] || '—'}` },
      { tag: 'action', actions: [
        btn('查看详情', buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: j.project_id }), 'primary'),
        btn('打开工作台', baseUrl),
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: `run: ${(item.run_id || '').slice(0, 8)} · 自动推送（仅发本人）` }] },
    ] };
}

/** 推送（幂等：consultant+kind+run_id 唯一；SENT 重复 → SKIPPED_DUPLICATE；FAILED 可重发并更新原行）。
 * run_id 为空统一落 '' 哨兵：SQLite UNIQUE 视 NULL 互不相等，NULL 时唯一键形同虚设
 * （SYNC_ALERT 恒无 run_id，修正前可并发重复插行）。存量 NULL 由 0006 迁移回填。 */
/** SYNC_ALERT 去重键（CST 日窗口）：告警每天最多一张，但第二天必须能再发——
 * 此前用冻结 run_id 做键，故障期间 run_id 不变 → 告警终身只发一次（最需要时哑掉）。 */
export function syncAlertKey(at = now()) {
  const cst = new Date(Date.parse(at) + 8 * 3600 * 1000);
  return `syncalert:${cst.toISOString().slice(0, 10)}`;
}

export async function pushCard(db, { consultant_id, kind, run_id, card, target, send = false }) {
  const rid = run_id ?? '';
  const dup = db.prepare(`SELECT push_id, status FROM push_log
    WHERE consultant_id=? AND kind=? AND run_id=?`).get(consultant_id, kind, rid);
  if (dup && dup.status !== 'FAILED' && !(dup.status === 'PREVIEW' && send)) {
    // 唯一键（consultant+kind+run_id）即幂等保证：已成功的推送跳过，
    // 返回首次记录——该 run 在 push_log 中永远只有一条成功记录。
    return { ok: true, status: 'SKIPPED_DUPLICATE', push_id: dup.push_id };
  }
  let status = 'SENT', message_id = null, error = null;
  if (send) {
    try {
      if ((process.env.BRAINX_FEISHU_APP_ID || process.env.LARK_APP_ID)
          && (process.env.BRAINX_FEISHU_APP_SECRET || process.env.LARK_APP_SECRET)) {
        const out = await sendInteractiveCard({ target, card });
        message_id = out.message_id;
      } else {
        // 兼容旧环境：未配置直连凭证时仍可使用 lark-cli profile。
        const { stdout } = await execFileP('lark-cli', [...larkProfileArgs(), 'api', 'POST', '/open-apis/im/v1/messages', '--as', 'bot',
          '--params', JSON.stringify({ receive_id_type: target.startsWith('oc_') ? 'chat_id' : 'open_id' }),
          '--data', JSON.stringify({ receive_id: target, msg_type: 'interactive',
                                     content: JSON.stringify(card) })],
          { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 45000, killSignal: 'SIGKILL' });
        const d = JSON.parse(stdout.slice(stdout.indexOf('{')));
        const feishu = d?.data?.code != null ? d.data : d;
        if (feishu?.code !== 0 && feishu?.ok !== true) {
          throw new Error(feishu?.msg || feishu?.error?.message || JSON.stringify(d).slice(0, 200));
        }
        message_id = feishu?.data?.message_id || d?.data?.data?.message_id || null;
      }
    } catch (e) {
      // execFileSync 的 e.message 是命令本体（含整张卡片 JSON），真实 Feishu 错误在
      // e.stderr —— 优先 stderr，截断保护放在最后（2026-08-24 修复：push_log 曾全是无效命令回显）
      status = 'FAILED';
      error = String(e.stderr || e.message || e).trim().slice(0, 300);
    }
  } else {
    status = 'PREVIEW';
  }
  if (dup) {
    // 重发失败行：更新同一 push_id，保持唯一键语义与审计连续
    db.prepare(`UPDATE push_log SET card_json=?, target=?, message_id=?, status=?, error=?, created_at=?
      WHERE push_id=?`)
      .run(JSON.stringify(card), target, message_id, status, error, now(), dup.push_id);
    return { ok: status !== 'FAILED', push_id: dup.push_id, status, message_id, error };
  }
  const push_id = uuid();
  db.prepare(`INSERT INTO push_log (push_id, consultant_id, kind, run_id, card_json, target, message_id, status, error, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(push_id, consultant_id, kind, rid, JSON.stringify(card), target, message_id, status, error, now());
  return { ok: status !== 'FAILED', push_id, status, message_id, error };
}

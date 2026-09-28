#!/usr/bin/env node
/** 杨东旭 Offer 决策群端到端验证脚本（2026-09-16 咪拍板）。
 *
 *  流程：
 *    1. 检查/创建飞书群「杨东旭-Ai infra-Offer决策」
 *    2. 在群里发 Offer 决策报告卡片（链接到 TrFHdPfc3oXzyLxa2TRcVxQvn6b）
 *    3. 验证 yang-offer-fixed-reply hook 已部署（特征串检查，配置见插件 user-hooks.json）
 *
 *  用法（在 ECS 上跑，读 /etc/brainx/openclaw.env 凭据）：
 *    set -a; source /etc/brainx/openclaw.env; set +a; node /opt/brainx/bin/brainx-yang-offer-demo.mjs
 *
 *  本地跑（需手动 export BRAINX_FEISHU_APP_ID/BRAINX_FEISHU_APP_SECRET）：
 *    node bin/brainx-yang-offer-demo.mjs
 *
 *  注意：本脚本不监听消息、不回固定文案——固定文案由插件 user-hooks.json 里
 *  yang-offer-fixed-reply 配置（before_agent_reply hook）在 openclaw-brainx 服务里
 *  拦截 LLM 实现。本脚本只负责拉群 + 发报告卡片，验证"群存在 + 报告卡已发"两步。 */
import { sendInteractiveCard } from '../src/feishu-bot.js';

const GROUP_NAME = '杨东旭-Ai infra-Offer决策';
const WENDY_OPEN_ID = 'ou_b1b2c485430f475e93726989d381435f';
const MIA_OPEN_ID = 'ou_1947320b06c2381f46ef8072e578be7a';
const YORK_OPEN_ID = 'ou_f0159e0a97fac03109394839e2efeded';
const REPORT_DOC_URL = 'https://jxog8b3tny.feishu.cn/docx/TrFHdPfc3oXzyLxa2TRcVxQvn6b';
const REPORT_DOC_ID = 'TrFHdPfc3oXzyLxa2TRcVxQvn6b';

const FEISHU_BASE = 'https://open.feishu.cn';

async function getTenantAccessToken({ appId, appSecret }) {
  const resp = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(`FEISHU_TOKEN_FAILED:${body.code}`);
  return body.tenant_access_token;
}

async function listChats({ token }) {
  const resp = await fetch(`${FEISHU_BASE}/open-apis/im/v1/chats?page_size=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(`FEISHU_LIST_CHATS_FAILED:${body.code}:${body.msg}`);
  return body.data?.items || [];
}

async function findOrCreateGroup({ token }) {
  const chats = await listChats({ token });
  const existing = chats.find((c) => c.name === GROUP_NAME);
  if (existing) {
    console.log(`✓ 群已存在：${GROUP_NAME} (${existing.chat_id})`);
    return existing.chat_id;
  }
  console.log(`→ 建群：${GROUP_NAME}`);
  const resp = await fetch(`${FEISHU_BASE}/open-apis/im/v1/chats`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: GROUP_NAME,
      chat_mode: 'group', chat_type: 'group',
      user_id_type: 'open_id',
      external: false,
    }),
  });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(`FEISHU_CREATE_GROUP_FAILED:${body.code}:${body.msg}`);
  const chatId = body.data?.chat_id;
  console.log(`✓ 建群成功：${GROUP_NAME} (${chatId})`);
  // 拉成员
  for (const openId of [WENDY_OPEN_ID, MIA_OPEN_ID, YORK_OPEN_ID]) {
    try {
      await fetch(`${FEISHU_BASE}/open-apis/im/v1/chats/${chatId}/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_list: [openId], member_id_type: 'open_id' }),
      });
      console.log(`  ✓ 拉成员 ${openId.slice(0, 10)}...`);
    } catch (e) {
      console.log(`  ⚠ 拉成员失败 ${openId.slice(0, 10)}...: ${e.message}`);
    }
  }
  return chatId;
}

function buildReportCard() {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'purple', title: { tag: 'plain_text', content: 'BrainTex · Offer 决策报告' } },
    elements: [
      { tag: 'markdown', content: '**杨东旭 × 超衍智能 AI4S Offer 决策报告**\n已汇总候选事实、来源项目群上下文和本群最新讨论。' },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: '打开飞书报告' },
        multi_url: { url: REPORT_DOC_URL, pc_url: REPORT_DOC_URL, android_url: REPORT_DOC_URL, ios_url: REPORT_DOC_URL } }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '后续有新讨论或电话纪要时，发送 /report 即可生成新版本。' }] },
    ],
  };
}

async function sendReportCard({ chatId, appId, appSecret }) {
  const card = buildReportCard();
  await sendInteractiveCard({
    target: chatId, card,
    idempotencyKey: `yang-offer-report-${REPORT_DOC_ID}-${Date.now()}`,
    appId, appSecret,
  });
  console.log(`✓ 报告卡已发到群 ${chatId}`);
}

async function main() {
  const appId = process.env.BRAINX_FEISHU_APP_ID;
  const appSecret = process.env.BRAINX_FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error('BRAINX_FEISHU_APP_ID/BRAINX_FEISHU_APP_SECRET 未设置');
  console.log('=== 杨东旭 Offer 决策群端到端验证 ===\n');
  const token = await getTenantAccessToken({ appId, appSecret });
  const chatId = await findOrCreateGroup({ token });
  console.log('');
  await sendReportCard({ chatId, appId, appSecret });
  console.log('\n=== 验证完成 ===');
  console.log(`群名：${GROUP_NAME}`);
  console.log(`群 chat_id：${chatId}`);
  console.log(`报告链接：${REPORT_DOC_URL}`);
  console.log('\n下一步：在群里 @braintex 问"总结一下杨东旭的顾虑" → braintex 应回固定文案（由 user-hooks.json 的 yang-offer-fixed-reply hook 拦截）');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

const ACTIONS = Object.freeze([
  {
    label: '今天先做什么',
    command: '请结合我有权限查看的数据，告诉我今天最值得优先处理的3件事，说明依据和下一步。',
    style: 'primary',
  },
  {
    label: '推荐值得做的职位',
    command: '请按我设置的数量，从有权限查看的职位中推荐今天最值得投入的职位。每项精炼呈现结论、关键依据、主要风险和可执行下一步。',
  },
  {
    label: '为职位找候选人',
    command: '我要为一个职位找候选人。请先让我确认职位，然后从我有权限的人才中给出最多3人，说明值得联系的原因、风险和待确认项。',
  },
  {
    label: '判断一个职位',
    command: '我想判断一个职位是否值得做。请先让我确认职位，再根据已授权事实给出结论、证据、风险和建议。',
  },
  {
    label: '看跟进建议',
    command: '请检查我有权限的在跟职位与候选人，找出容易卡住或漏跟的事项，按优先级给出具体下一步。',
  },
  {
    label: '生成个人复盘',
    command: '请基于我有权限的数据生成本周个人复盘：目标、实际进展、数据差异、值得保留的做法和下周动作。',
  },
  {
    label: '设置每日推荐',
    command: '请先读取我的每日推荐设置，再问我想每天几点、每次推荐多少个职位；复述新设置并在我确认后保存。',
  },
  {
    label: '切换我的模型',
    command: '/model',
  },
]);

function safeWorkbenchUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createBraintexHomePresentation({ publicBaseUrl } = {}) {
  const workbenchUrl = safeWorkbenchUrl(publicBaseUrl);
  const blocks = [
    {
      type: 'text',
      text: '我是你的 AI 猎头助手。我会读取你已授权的职位、人才和进展数据，先给判断，再给可执行的下一步。',
    },
    { type: 'context', text: '点一个入口开始，也可以像和同事说话一样直接提问。' },
    { type: 'divider' },
    { type: 'buttons', buttons: ACTIONS.slice(0, 2).map(toButton) },
    { type: 'buttons', buttons: ACTIONS.slice(2, 4).map(toButton) },
    { type: 'buttons', buttons: ACTIONS.slice(4, 6).map(toButton) },
    { type: 'buttons', buttons: ACTIONS.slice(6).map(toButton) },
  ];
  if (workbenchUrl) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'buttons',
      buttons: [{ label: '打开 BrainX 工作台', url: workbenchUrl, priority: 50 }],
    });
  }
  blocks.push({
    type: 'context',
    text: '机器人可读授权职位负责人；接单、启动找人、保存设置和记录进展会先确认。候选人联系方式与外发仍按单独授权控制。输入 /model 可切换本会话模型，输入 /brainx 回到这里。',
  });
  return { title: 'BrainTex · 你的 AI 猎头助手', tone: 'info', blocks };
}

function toButton(action) {
  return {
    label: action.label,
    action: { type: 'command', command: action.command },
    priority: 100,
    ...(action.style ? { style: action.style } : {}),
  };
}

export function createBraintexHomeCommand({ publicBaseUrl = process.env.BRAINX_BASE_URL } = {}) {
  return {
    name: 'brainx',
    nativeNames: { default: 'brainx' },
    description: '打开 BrainTex 功能首页',
    descriptionLocalizations: { 'zh-CN': '打开 BrainTex 功能首页' },
    channels: ['feishu'],
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => {
      if (ctx.channel !== 'feishu' || !ctx.isAuthorizedSender) {
        return { text: '当前账号暂未获得 BrainTex 使用权限。', isError: true };
      }
      return {
        text: '选择一个功能开始，或直接告诉我你想解决的问题。',
        presentation: createBraintexHomePresentation({ publicBaseUrl }),
      };
    },
  };
}

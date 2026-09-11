const TTC_TALENT_ORIGIN = 'https://app.ttcadvisory.com';
const TTC_TALENT_PATH = '/app/talent/';

function decodeDisplayText(value) {
  return String(value || '')
    .replace(/\\\r?\n/g, '\n')
    .replace(/\\([\\`*{}\[\]()#+\-.!_|>])/g, '$1')
    .replace(/&#x20;|&#32;|&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '');
}

function plainText(value) {
  return decodeDisplayText(value)
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/[`*_~]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

function isDividerRow(cells) {
  return cells?.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function firstIndex(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function safeTtcTalentUrl(value) {
  for (const match of String(value || '').matchAll(/https:\/\/[^\s)>]+/g)) {
    try {
      const url = new URL(match[0].replace(/&amp;/g, '&'));
      if (url.origin === TTC_TALENT_ORIGIN && url.pathname.startsWith(TTC_TALENT_PATH)
          && candidateRefFromUrl(url.toString())) {
        return url.toString();
      }
      const candidateRef = url.searchParams.get('candidate');
      if (candidateRef && /^[A-Za-z0-9:_-]{1,100}$/.test(candidateRef)) {
        return `${TTC_TALENT_ORIGIN}${TTC_TALENT_PATH}${encodeURIComponent(candidateRef)}`;
      }
    } catch { /* 忽略模型生成的无效链接。 */ }
  }
  return null;
}

function candidateRefFromUrl(value) {
  try {
    const url = new URL(value);
    const ref = decodeURIComponent(url.pathname.slice(TTC_TALENT_PATH.length)).split('/')[0];
    return /^[A-Za-z0-9:_-]{1,100}$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

function callbackButton(label, command) {
  return { tag: 'button', type: 'default', text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value: {
      oc: 'ocf1', k: 'quick', a: 'feishu.payload.button', q: command,
    } }] };
}

function screeningCommand(candidateRef) {
  return `[BRAINTEX_CANDIDATE_SCREEN] 将当前项目群候选人 ${candidateRef} 初筛通过。`
    + '这个按钮就是本次明确确认：先根据当前项目群定位唯一职位，然后立即调用 '
    + `brainx_candidate_workflow，传入 candidate_ref=${candidateRef}、action=KEEP_FOR_REVIEW、confirm=true。`
    + '成功后回复“☑ 初筛通过”；BrainX 会把 TTC 人才链接发到本群并由飞书展开，不要重复发送。';
}

function demoFavoriteCommand(candidateRef) {
  return `[BRAINTEX_DEMO_FAVORITE] 候选人 ${candidateRef}：只回复“已收藏”，`
    + '不要调用任何工具，不要写入、修改或假装已经写入任何数据。';
}

function candidateRow(candidate) {
  const candidateRef = candidateRefFromUrl(candidate.url);
  const actions = candidate.url ? [
    { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看人才' },
      behaviors: [{ type: 'open_url', default_url: candidate.url }] },
    callbackButton('初筛通过', screeningCommand(candidateRef)),
    callbackButton('收藏', demoFavoriteCommand(candidateRef)),
  ] : [];
  const facts = [
    `**${candidate.name}｜${candidate.role}**`,
    [candidate.experience, candidate.city, candidate.education].filter(Boolean).join(' · ')
      || '基础信息待核实',
    `匹配点：${candidate.match || '待核实'}${candidate.score ? ` · 匹配度 ${candidate.score}` : ''}`,
  ];
  return [
    { tag: 'markdown', content: facts.join('\n') },
    ...(actions.length ? actions : [{ tag: 'markdown', content: '链接待核实' }]),
  ];
}

export function parseCandidateTableReply(value) {
  const text = decodeDisplayText(value);
  const lines = text.split('\n');
  let tableStart = -1;
  let headers;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const row = splitTableRow(lines[index]);
    const divider = splitTableRow(lines[index + 1]);
    if (row && isDividerRow(divider) && row.some((cell) => /姓名|候选人/.test(cell))) {
      tableStart = index;
      headers = row.map(plainText);
      break;
    }
  }
  if (tableStart < 0) return null;
  const indexOf = {
    name: firstIndex(headers, [/姓名/, /候选人/]), role: firstIndex(headers, [/公司/, /职位/]),
    experience: firstIndex(headers, [/经验/, /年限/]), city: firstIndex(headers, [/城市/, /地点/]),
    education: firstIndex(headers, [/学历/, /院校/]), match: firstIndex(headers, [/匹配点/, /判断/, /推荐理由/]),
    score: firstIndex(headers, [/匹配度/, /评分/, /分数/]),
  };
  const candidates = [];
  for (let index = tableStart + 2; index < lines.length && candidates.length < 10; index += 1) {
    const cells = splitTableRow(lines[index]);
    if (!cells) break;
    const read = (key) => indexOf[key] >= 0 ? plainText(cells[indexOf[key]]) : '';
    const name = read('name').replace(/^\d+[.)、]\s*/, '');
    if (!name) continue;
    candidates.push({
      name, role: read('role') || '当前岗位待核实', experience: read('experience'),
      city: read('city'), education: read('education'), match: read('match'), score: read('score'),
      url: safeTtcTalentUrl(cells.join(' ')),
    });
  }
  if (!candidates.length) return null;
  const titleIndex = lines.slice(0, tableStart).findIndex((line) => plainText(line));
  const rawTitle = titleIndex >= 0 ? lines[titleIndex] : 'TTC 候选人搜索结果';
  const title = plainText(rawTitle).slice(0, 80);
  const intro = plainText(lines.slice(0, tableStart)
    .filter((line, index) => index !== titleIndex && !/推荐候选人/.test(line)).join('\n')).slice(0, 1800);
  const card = {
    schema: '2.0', config: { width_mode: 'fill' },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    body: { elements: [
      ...(intro ? [{ tag: 'div', text: { tag: 'plain_text', content: intro } }] : []),
      ...candidates.flatMap((candidate, index) => [
        ...(index ? [{ tag: 'hr' }] : []), ...candidateRow(candidate),
      ]),
      { tag: 'div', text: { tag: 'plain_text', content: '“初筛通过”会发送 TTC 人才链接并由飞书展开；“收藏”仅显示确认，不写入人才库。' } },
    ] },
  };
  const fallback = [title, intro, ...candidates.map((candidate, index) =>
    `${index + 1}. ${candidate.name}｜${candidate.role}｜${candidate.score || '待核实'}${candidate.url ? `\n${candidate.url}` : ''}`)]
    .filter(Boolean).join('\n\n');
  return { card, fallback, candidates };
}

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
      if (url.origin === TTC_TALENT_ORIGIN && url.pathname.startsWith(TTC_TALENT_PATH)) {
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

function cell(content, weight = 1, elements) {
  return {
    tag: 'column', width: 'weighted', weight, vertical_align: 'center',
    elements: elements || [{ tag: 'div', text: { tag: 'plain_text', content } }],
  };
}

function tableHeader() {
  return {
    tag: 'column_set', flex_mode: 'none', background_style: 'grey', columns: [
      cell('候选人 / 当前岗位', 3), cell('经验 / 城市', 2), cell('学历', 2),
      cell('核心匹配点', 5), cell('匹配度', 1), cell('操作', 2),
    ],
  };
}

function candidateRow(candidate) {
  const action = candidate.url
    ? [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看人才' },
      behaviors: [{ type: 'open_url', default_url: candidate.url }] }]
    : [{ tag: 'div', text: { tag: 'plain_text', content: '链接待核实' } }];
  return {
    tag: 'column_set', flex_mode: 'none', background_style: 'default', columns: [
      cell(`${candidate.name}\n${candidate.role}`, 3),
      cell([candidate.experience, candidate.city].filter(Boolean).join(' · ') || '待核实', 2),
      cell(candidate.education || '待核实', 2), cell(candidate.match || '待核实', 5),
      cell(candidate.score || '—', 1), cell('', 2, action),
    ],
  };
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
      tableHeader(), ...candidates.map(candidateRow),
      { tag: 'div', text: { tag: 'plain_text', content: '点击“查看人才”将打开 TTC 人才库详情页；不发送简历附件。' } },
    ] },
  };
  const fallback = [title, intro, ...candidates.map((candidate, index) =>
    `${index + 1}. ${candidate.name}｜${candidate.role}｜${candidate.score || '待核实'}${candidate.url ? `\n${candidate.url}` : ''}`)]
    .filter(Boolean).join('\n\n');
  return { card, fallback, candidates };
}

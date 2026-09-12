/**
 * renderer.mjs — 飞书 legacy v1 互动卡片 JSON → HTML。
 *
 * 为什么需要它：仓库里 13 张群卡片由 src/*.js 的纯函数产出 JSON，飞书负责渲染，
 * 本地没有任何东西能看到「这张卡片长什么样」。截图回归门禁必须先把 JSON 变成
 * 可渲染的 DOM，才能把排版问题变成可比对、可阻断的证据。
 *
 * 覆盖范围只针对仓库实际用到的元素：markdown / hr / action / note / input /
 * column_set / column / div。不实现卡片 2.0、表单、图片等未使用能力；
 * 遇到未知元素抛错而不是静默跳过 —— 静默跳过会让新卡片的排版问题逃过门禁。
 */

const TEMPLATE_BG = {
  blue: '#3370ff', wathet: '#d6e4ff', turquoise: '#00c2a8', green: '#34c724',
  yellow: '#ffc60a', orange: '#ff8800', red: '#f54a45', carmine: '#dd4a68',
  violet: '#7f3bf5', purple: '#7f3bf5', indigo: '#4e5fd8', grey: '#8f959e',
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

/** 飞书 markdown 的极小子集：加粗、行内代码、斜体、换行。够用且不引依赖。 */
export function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s（(])_([^_\n]+)_(?=[\s）)。，,、]|$)/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
}

export function renderMarkdownBlock(content) {
  return `<div class="el el-md">${inlineMarkdown(content)}</div>`;
}

function renderButton(action) {
  const type = action.type === 'primary' ? 'primary'
    : action.type === 'danger' ? 'danger' : 'default';
  const label = escapeHtml(action.text?.content ?? '');
  // multi_url = 纯跳转；value.text = 回调命令。两者在飞书里外观一致，
  // 但评审时需要一眼看出差别，因此落成 data-kind 供排版门禁做结构断言。
  const kind = action.multi_url ? 'url' : 'callback';
  return `<button type="button" class="btn btn-${type}" data-kind="${kind}">${label}</button>`;
}

function renderActionBlock(element) {
  const buttons = (element.actions || []).map(renderButton).join('');
  return `<div class="el el-actions" data-count="${(element.actions || []).length}">${buttons}</div>`;
}

function renderNote(element) {
  const text = (element.elements || []).map((item) => inlineMarkdown(item.content ?? '')).join('');
  return `<div class="el el-note">${text}</div>`;
}

function renderInput(element) {
  const placeholder = escapeHtml(element.placeholder?.content ?? '');
  return `<div class="el el-input"><span class="input-placeholder">${placeholder}</span></div>`;
}

function renderColumn(column) {
  const weight = Number(column.weight) > 0 ? Number(column.weight) : 1;
  const inner = renderElements(column.elements || []);
  return `<div class="col" style="flex:${weight} 1 0" data-weight="${weight}">${inner}</div>`;
}

function renderColumnSet(element) {
  const style = element.background_style === 'grey' ? 'is-grey' : 'is-plain';
  const columns = (element.columns || []).map(renderColumn).join('');
  return `<div class="el el-columns ${style}">${columns}</div>`;
}

function renderDiv(element) {
  return `<div class="el el-div">${inlineMarkdown(element.text?.content ?? '')}</div>`;
}

// 列内的裸 button：不是 action 块的子项，而是列元素本身。
// 用途：右对齐收口的孤行动作 —— src/card-layout.js#alignSoloAction 把单按钮
// 放进 column_set 的右列，按钮就成了列元素。
function renderLoneButton(element) {
  return `<div class="el el-actions" data-count="1">${renderButton(element)}</div>`;
}

const RENDERERS = {
  markdown: (element) => renderMarkdownBlock(element.content),
  hr: () => '<div class="el el-hr"></div>',
  action: renderActionBlock,
  note: renderNote,
  input: renderInput,
  div: renderDiv,
  button: renderLoneButton,
  column_set: renderColumnSet,
};

export function renderElements(elements) {
  return (elements || []).map((element) => {
    const render = RENDERERS[element.tag];
    if (!render) {
      throw new Error(`卡片渲染器未覆盖的元素类型：${element.tag}`);
    }
    return render(element);
  }).join('');
}

export function renderCard(card, { cardId = 'card' } = {}) {
  const background = TEMPLATE_BG[card.header?.template] || TEMPLATE_BG.grey;
  const title = escapeHtml(card.header?.title?.content ?? '');
  return `<div class="feishu-card" data-card="${escapeHtml(cardId)}">`
    + `<div class="card-head" style="background:${background}"><span>${title}</span></div>`
    + `<div class="card-body">${renderElements(card.elements)}</div>`
    + '</div>';
}

/** 渲染产物转成可独立打开的 HTML 文档（供截图与人工复核）。 */
export function renderCardDocument(card, options = {}) {
  const css = options.css ?? '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<title>${escapeHtml(options.title ?? 'BrainTex 卡片')}</title><style>${css}</style></head>`
    + `<body class="card-stage">${renderCard(card, options)}</body></html>`;
}

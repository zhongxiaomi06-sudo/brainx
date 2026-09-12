/**
 * typography.mjs — 飞书群卡片「文字排版」的硬规则（纯函数，可单测）。
 *
 * 为什么单独一层：截图回归只能证明「和上一版长得一样」，无法证明「这一版是有章法的」。
 * 卡片文案由 src/*.js 直接拼字符串，没有模板约束，很容易写出「一坨加粗 + 一堆冒号」
 * 的密集文字墙。这里把「章法」拆成 5 条可以在 JSON 层判定的规则，让排版纪律
 * 和按钮截断一样能阻断 push。
 *
 * 层级约定（详见 docs/standards/CARD_TYPOGRAPHY.md）：
 *   标题行  **职位名**          一义一行，必须是块的第 1 个非空行
 *   元信息  公司 · 城市 · 关系   统一用「 · 」分隔，不加粗
 *   指标行  `Fit 82 · Activity …` 行内代码，术语固定顺序
 *   标签行  **依据**：值         最多连续 3 行，一律全角冒号
 *   说明行  短句，不加粗
 *
 * 规则故意做得保守：只拦「一眼看出没章法」的事实，不表达审美偏好。
 */

/** 单个 markdown 块的正文行上限：超过即视为文字墙，应拆块。 */
export const MAX_BLOCK_LINES = 8;
/** 单个 markdown 块的总行上限（含列表与引用）：列表可扫读，但不是无限长。 */
export const MAX_BLOCK_LINES_TOTAL = 16;
/** 连续标签行上限：超过应插入分组（空行、元信息行或 hr）。 */
export const MAX_LABEL_RUN = 3;
/** 单个 action 块的按钮上限：超过 3 个，420px 卡片下按钮文字必被省略号截断。 */
export const MAX_ACTION_BUTTONS = 3;

/** 标签行：整行以加粗标签开头，紧跟冒号。 */
const LABEL_LINE = /^\s*\*\*([^*]+)\*\*\s*[：:]/;
/** 视觉标题行：以加粗开头且不是「**标签**：值」形式（标签行另有归属）。
 *  允许标题后有行尾强调（如 🔥），所以只判定前缀而不要求整行都是加粗。 */
const HEADING_LINE = /^\s*\*\*[^*]+\*\*/;
/** 列表项与引用行：可扫读，不计入正文行数，只受总行数约束。 */
const LIST_LINE = /^\s*(?:[-*•]\s+|\d+\.\s+|>\s*)/;
const isLabelLine = (line) => LABEL_LINE.test(line);
const isHalfwidthLabel = (line) => /^\s*\*\*[^*]+\*\*\s*:/.test(line);
const isHeadingLine = (line) => HEADING_LINE.test(line) && !isLabelLine(line);

/** 深度优先遍历所有元素，columns / 嵌套 elements 都算，保证列内文案同样受约束。 */
export function walkElements(elements, path = '$') {
  const found = [];
  for (const [index, element] of (elements || []).entries()) {
    if (!element || typeof element !== 'object') continue;
    const here = `${path}.${element.tag || 'unknown'}[${index}]`;
    found.push({ element, path: here });
    if (Array.isArray(element.elements)) found.push(...walkElements(element.elements, here));
    for (const [columnIndex, column] of (element.columns || []).entries()) {
      found.push(...walkElements(column?.elements, `${here}.col[${columnIndex}]`));
    }
  }
  return found;
}

/**
 * 校验单张卡片的文字排版。
 * @returns {{rule: string, detail: string}[]} 阻断原因，空数组表示合规。
 */
export function checkTypography(card) {
  const issues = [];
  for (const { element, path } of walkElements(card?.elements)) {
    if (element.tag === 'markdown') {
      issues.push(...checkMarkdownBlock(element.content, path));
    } else if (element.tag === 'action') {
      const count = (element.actions || []).length;
      if (count > MAX_ACTION_BUTTONS) {
        issues.push({ rule: 'action-row-too-many-buttons',
          detail: `${path} 一个动作块放了 ${count} 个按钮，超过 ${MAX_ACTION_BUTTONS} 个`
            + '（420px 卡片下按钮文字会被省略号截断），必须拆成多个动作块' });
      }
    }
  }
  return issues;
}

function checkMarkdownBlock(content, path) {
  const issues = [];
  const lines = String(content ?? '').split('\n');
  const filled = lines.filter((line) => line.trim() !== '');
  const prose = filled.filter((line) => !LIST_LINE.test(line));

  if (prose.length > MAX_BLOCK_LINES) {
    issues.push({ rule: 'markdown-block-too-long',
      detail: `${path} 单块正文 ${prose.length} 行，超过 ${MAX_BLOCK_LINES} 行文字墙上限，应拆成多个块` });
  }
  if (filled.length > MAX_BLOCK_LINES_TOTAL) {
    issues.push({ rule: 'markdown-block-overflow',
      detail: `${path} 单块 ${filled.length} 行（含列表），超过 ${MAX_BLOCK_LINES_TOTAL} 行总上限` });
  }

  // 标题行必须在块首：块中间再出现整行加粗，读者无法判断哪一行是标题。
  const firstHeading = filled.findIndex(isHeadingLine);
  if (firstHeading > 0) {
    issues.push({ rule: 'heading-not-first',
      detail: `${path} 整行加粗标题出现在第 ${firstHeading + 1} 个非空行，标题必须位于块首` });
  }

  let run = 0;
  let runStart = 0;
  for (const [index, line] of filled.entries()) {
    if (isLabelLine(line)) {
      if (run === 0) runStart = index + 1;
      run += 1;
      if (run === MAX_LABEL_RUN + 1) {
        issues.push({ rule: 'label-run-too-long',
          detail: `${path} 第 ${runStart} 行起连续 ${run} 行以上「**标签**：值」，`
            + `超过 ${MAX_LABEL_RUN} 行上限，应插入分组` });
      }
    } else {
      run = 0;
    }
  }

  const halfwidth = filled.findIndex(isHalfwidthLabel);
  if (halfwidth >= 0) {
    issues.push({ rule: 'label-colon-halfwidth',
      detail: `${path} 第 ${halfwidth + 1} 个非空行的标签用了半角冒号，标签行一律全角「：」` });
  }

  return issues;
}

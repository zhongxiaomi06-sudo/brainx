/** card-layout.js — 飞书 legacy v1 卡片的共用排版手段。
 *
 * 为什么需要（F4，见 docs/frontend-reviews/2026-09-12-feishu-card-buttons-audit.md）：
 * 一个 action 块里只有 1 个按钮时，飞书按「自然宽度 + 左对齐」渲染，整行右侧大片留白，
 * 按钮看起来像孤儿。本地渲染门禁此前把按钮 flex 拉伸到整行宽，截图里看不到这个缺陷
 * （门禁盲区，见 docs/2026-09-12-feishu-card-render-gate.md §4）。
 *
 * 处理：把孤行动作改写成 column_set —— 左列留空、右列放按钮，按钮在行末收口。
 * 这里放的是「裸 button 进列」的写法，与 openmai-delivery 候选表原来的「操作」列同源，
 * 是飞书 v1 已实证支持的列内元素。
 *
 * 多按钮行不处理：按钮本身就会铺满整行，不存在单侧留白。
 */

// 占位列与动作列各占一半：动作列太窄会把长按钮文案压到省略号
// （门禁 button-truncated 实测拦下过「打开职位 · 启动找人」），太宽又失去收口效果。
const SPACER_COLUMN = {
  tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
  elements: [{ tag: 'div', text: { tag: 'plain_text', content: ' ' } }],
};

function rightColumn(button) {
  return { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [button] };
}

/** 单按钮 action 块 → 右对齐的 column_set；多按钮或非 action 元素原样返回。 */
export function alignSoloAction(element) {
  if (!element || element.tag !== 'action') return element;
  const actions = element.actions || [];
  if (actions.length !== 1) return element;
  return { tag: 'column_set', flex_mode: 'none', background_style: 'default',
    columns: [SPACER_COLUMN, rightColumn(actions[0])] };
}

/** 批量处理 elements 数组里的孤行动作。 */
export function alignSoloActions(elements) {
  return (elements || []).map(alignSoloAction);
}

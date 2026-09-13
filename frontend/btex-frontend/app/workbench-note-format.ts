// 备注字段展示格式化（2026-09-13）：小麦/TTC 同步进来的 notes 是原始 markdown
// （**标签**：值、# 标题、- 列表、<!-- xiaomai-sync --> 注释），直接塞进判断面板
// 会糊成一坨右对齐长文。本模块把它解析成结构化段，供 NoteValue 组件渲染。
// 抽成无 JSX 的纯模块，便于在 node 测试中直接验证。

export type NoteSegment =
  | { kind: "caption"; text: string }
  | { kind: "pair"; label: string; text: string }
  | { kind: "item"; text: string }
  | { kind: "text"; text: string };

const PAIR_LOOKBEHIND = /(?=\*\*[^*]+\*\*\s*[：:])/;
const PAIR_MATCH = /^\*\*(.+?)\*\*\s*[：:]\s*([\s\S]*)$/;
const HEADING_MATCH = /^#{1,6}\s+(.+)$/;
const BULLET_MATCH = /^[-•]\s+(.+)$/;

export function formatNoteSegments(raw: string): NoteSegment[] {
  if (!raw) return [];
  // HTML 注释（如 xiaomai-sync-begin/end 标记）是内部噪音，整段剥离。
  const cleaned = raw.replace(/<!--[\s\S]*?-->/g, "\n").replace(/[ \t]+/g, " ");
  const segments: NoteSegment[] = [];
  const appendToLast = (extra: string) => {
    const last = segments[segments.length - 1];
    if (last && (last.kind === "pair" || last.kind === "text")) last.text = `${last.text} ${extra}`.trim();
    else segments.push({ kind: "text", text: extra });
  };
  // 同步备注常把 # 标题与 - 列表内联在同一行（例："# 小麦同步画像 ## 必备经验和能力 - A - B"），
  // 先在标题行里把内联列表拆成独立行，再按 # 切块，否则整行会被当成一个标题。
  for (const raw of cleaned.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const lines = (line.includes("#") ? line.replace(/\s+[-•]\s+/g, "\n- ") : line).split("\n");
    for (const piece of lines.map((piece) => piece.trim()).filter(Boolean)) {
      const chunks = /#{1,6}\s/.test(piece) ? piece.split(/(?=\s#{1,6}\s)/).map((chunk) => chunk.trim()).filter(Boolean) : [piece];
      for (const chunk of chunks) {
        pushLine(chunk);
      }
    }
  }
  return segments;

  function pushLine(line: string): void {
    const heading = line.match(HEADING_MATCH);
    if (heading) {
      segments.push({ kind: "caption", text: heading[1].trim() });
      return;
    }
    const bullet = line.match(BULLET_MATCH);
    if (bullet) {
      segments.push({ kind: "item", text: bullet[1].trim() });
      return;
    }
    if (!PAIR_LOOKBEHIND.test(line)) {
      appendToLast(line);
      return;
    }
    for (const part of line.split(PAIR_LOOKBEHIND).map((piece) => piece.trim()).filter(Boolean)) {
      const pair = part.match(PAIR_MATCH);
      if (pair) segments.push({ kind: "pair", label: pair[1].trim(), text: pair[2].trim() });
      else appendToLast(part);
    }
  }
  return segments;
}

// 田字格宫格组装（2026-09-13 三轮）：备注块按「横两个、竖两个」的 2×2 宫格排布。
// 每个「标签 + 内容」占一格；过长的标签块跨两列；标题与其下的列表打包成一个整块格子，
// 一起收放，不再零散地散落在宫格里。
export type NoteCell =
  | { kind: "field"; label: string; text: string; wide: boolean }
  | { kind: "group"; title: string; items: string[] }
  | { kind: "note"; text: string };

// 超过这个字数的标签块单独占满一行，避免宫格里塞进一整段长文。
const WIDE_FIELD_CHARS = 70;

export function noteCells(segments: NoteSegment[]): NoteCell[] {
  const cells: NoteCell[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.kind === "pair") {
      cells.push({ kind: "field", label: segment.label, text: segment.text, wide: segment.text.length > WIDE_FIELD_CHARS });
      continue;
    }
    if (segment.kind === "caption") {
      // 标题连同后续所有列表项/文本收成一个整块，一起收放。
      const items: string[] = [];
      let cursor = index + 1;
      while (cursor < segments.length && segments[cursor].kind !== "caption" && segments[cursor].kind !== "pair") {
        items.push(segments[cursor].text);
        cursor += 1;
      }
      cells.push({ kind: "group", title: segment.text, items });
      index = cursor - 1;
      continue;
    }
    cells.push({ kind: "note", text: segment.text });
  }
  // 收尾大格：最后一个标签块恒跨两列，避免宫格末行只剩半格、边上留空洞。
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index].kind === "field") {
      (cells[index] as Extract<NoteCell, { kind: "field" }>).wide = true;
      break;
    }
  }
  return cells;
}

export function noteSegmentChars(segment: NoteSegment): number {
  return segment.text.length + (segment.kind === "pair" ? segment.label.length + 1 : 0);
}

// 折叠展示：按字符预算截取前缀段；最后一个放不下的段就地截断，避免整段消失。
export function clipNoteSegments(segments: NoteSegment[], budget: number): { shown: NoteSegment[]; clipped: boolean } {
  let used = 0;
  const shown: NoteSegment[] = [];
  for (const segment of segments) {
    const cost = noteSegmentChars(segment);
    if (used + cost <= budget) {
      shown.push(segment);
      used += cost;
      continue;
    }
    const remaining = budget - used;
    if (remaining > 20) shown.push({ ...segment, text: `${segment.text.slice(0, Math.max(0, remaining - 1))}…` });
    return { shown, clipped: true };
  }
  return { shown, clipped: false };
}

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
  for (const line of cleaned.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const heading = line.match(HEADING_MATCH);
    if (heading) {
      segments.push({ kind: "caption", text: heading[1].trim() });
      continue;
    }
    const bullet = line.match(BULLET_MATCH);
    if (bullet) {
      segments.push({ kind: "item", text: bullet[1].trim() });
      continue;
    }
    if (!PAIR_LOOKBEHIND.test(line)) {
      appendToLast(line);
      continue;
    }
    for (const part of line.split(PAIR_LOOKBEHIND).map((piece) => piece.trim()).filter(Boolean)) {
      const pair = part.match(PAIR_MATCH);
      if (pair) segments.push({ kind: "pair", label: pair[1].trim(), text: pair[2].trim() });
      else appendToLast(part);
    }
  }
  return segments;
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

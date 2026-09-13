import assert from "node:assert/strict";
import test from "node:test";
import { clipNoteSegments, formatNoteSegments } from "../app/workbench-note-format.ts";

// 样本取自生产 TTC 同步备注的真实形态：一段长文内联多个 **标签**：值 + xiaomai-sync 注释块。
const sampleNote =
  "**岗位要求**：需要有Agent产品经验（非客服类），理工科优先但不强制；汇报给AI Catch产品负责人。**薪资信息**：薪资范围30–40K*14薪，14薪固定+0–2个月绩效。" +
  "<!-- xiaomai-sync-begin --> # 小麦同步画像（最后更新 2026-09-08 02:21） ## 必备经验和能力 " +
  "- 当前需求偏增长方向，重点核验近阶段可量化的增长成果 - 重点核验广告素材运营及投放数据优化经验 " +
  "<!-- xiaomai-sync-end -->";

test("备注格式化：剥离 HTML 注释标记，**标签**：值解析为标签对", () => {
  const segments = formatNoteSegments(sampleNote);
  assert.ok(!segments.some((s) => s.text.includes("xiaomai-sync")));
  const labels = segments.filter((s) => s.kind === "pair").map((s) => s.label);
  assert.deepEqual(labels, ["岗位要求", "薪资信息"]);
  assert.equal(segments[0].kind, "pair");
  assert.equal(segments[0].label, "岗位要求");
  assert.ok(segments[0].text.startsWith("需要有Agent产品经验"));
});

test("备注格式化：# 标题转 caption，- 转 列表项，换行续行并入上一段", () => {
  const raw = "**注意事项**：该岗位远程工资高。\n外地候选人可能因地域犹豫。\n# 小麦同步画像（最后更新 2026-09-08 02:21）\n## 必备经验和能力\n- 重点核验海外 KOL 独立合作闭环经验\n- 重点核验增长成果";
  const segments = formatNoteSegments(raw);
  const captions = segments.filter((s) => s.kind === "caption").map((s) => s.text);
  assert.deepEqual(captions, ["小麦同步画像（最后更新 2026-09-08 02:21）", "必备经验和能力"]);
  const items = segments.filter((s) => s.kind === "item").map((s) => s.text);
  assert.deepEqual(items, ["重点核验海外 KOL 独立合作闭环经验", "重点核验增长成果"]);
  const note = segments.find((s) => s.kind === "pair" && s.label === "注意事项");
  assert.ok(note.text.includes("外地候选人可能因地域犹豫"), "无标记续行应并入上一段");
});

test("备注格式化：空值与无标记纯文本不误伤", () => {
  assert.deepEqual(formatNoteSegments(""), []);
  assert.deepEqual(formatNoteSegments("客户强调稳定性"), [{ kind: "text", text: "客户强调稳定性" }]);
  // 单个 *（如 30–40K*14薪）不应被当作标签标记
  const segments = formatNoteSegments("薪资范围30–40K*14薪");
  assert.deepEqual(segments, [{ kind: "text", text: "薪资范围30–40K*14薪" }]);
});

test("备注折叠：按预算截断并标记 clipped，展开返回全部", () => {
  const segments = formatNoteSegments(sampleNote);
  const { shown, clipped } = clipNoteSegments(segments, 40);
  assert.ok(clipped);
  assert.ok(shown.length >= 1);
  assert.ok(shown.at(-1).text.endsWith("…") || usedWithin(shown, 40));
  const full = clipNoteSegments(segments, Number.MAX_SAFE_INTEGER);
  assert.equal(full.clipped, false);
  assert.equal(full.shown.length, segments.length);
});

function usedWithin(segments, budget) {
  return segments.reduce((n, s) => n + s.text.length + (s.label ? s.label.length + 1 : 0), 0) <= budget;
}

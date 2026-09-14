import assert from "node:assert/strict";
import test from "node:test";
import { displayPipeline, recommendationSummary } from "../app/recommendation-display.ts";

test("推荐卡进展枚举统一显示为中文", () => {
  assert.equal(displayPipeline("Interview×2 Onboarding×1 Recommendation×3 Sourcing×10"),
    "面试×2 入职×1 推荐×3 寻访×10");
  assert.equal(displayPipeline(null), "待确认");
});

test("推荐卡从真实评分理由生成一条简明摘要", () => {
  assert.equal(recommendationSummary([
    "关系：我是主 PM；Interview×2 Recommendation×3",
    "方向匹配 25 分：与你画像关键词（全球化增长/买量等）的重合度",
  ]), "画像关键词与 全球化增长/买量 等方向重合；我是主 PM；面试×2 推荐×3");
});

import assert from "node:assert/strict";
import test from "node:test";
import { mapRecommendationPage } from "../app/brainx-recommendation-pages-api.ts";

test("maps Algorithm A page without inventing score and preserves Agent rank fields", () => {
  const page = mapRecommendationPage({
    engine: "agentic-ranking-v1", state: "PREVIOUS_RESULT", blocked: false,
    run_id: "arr-1", snapshot_id: "sync-1", policy_version: "agentic-ranking-v1",
    generated_at: "2026-09-24T00:00:00.000Z", evaluated_count: 200, total_count: 1,
    page_size: 20, sort: "priority", next_cursor: null, new_run_available: true,
    items: [{ engine: "agentic-ranking-v1", run_id: "arr-1", decision_id: "ard-1",
      rank: 7, decision_tier: "MONITOR", reason_codes: ["SOURCE_CONFLICT"],
      reason: "证据存在冲突，保留观察", tradeoff: "时效较新但 HC 仍需确认",
      evidence_refs: ["evidence-1"], uncertainties: ["HC 待确认"],
      suggested_next_action: "联系客户核对 HC", generated_at: "2026-09-24T00:00:00.000Z",
      job: { project_id: "job-1", company: "脱敏公司", role: "算法工程师", city: "上海",
        hc: null, active_state: "OPEN", relation: "TEAM_SHARED" },
      source_mode: "MARKET_ONLY", engagement_state: "NEW", legal_actions: ["VIEW", "WATCH"] }],
  });
  assert.equal(page.engine, "agentic-ranking-v1");
  assert.equal(page.state, "PREVIOUS_RESULT");
  assert.equal(page.jobs[0].rank, 7);
  assert.equal(page.jobs[0].finalScore, "—");
  assert.equal(page.jobs[0].rankingEngine, "agentic-ranking-v1");
  assert.equal(page.jobs[0].agenticTradeoff, "时效较新但 HC 仍需确认");
  assert.deepEqual(page.jobs[0].agenticUncertainties, ["HC 待确认"]);
  assert.deepEqual(page.jobs[0].brainxLegal, ["WATCH"]);
  assert.doesNotMatch(JSON.stringify(page.jobs[0]), /confidence_band|probability/);
});
